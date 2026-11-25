import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
// CLI entry point for `opencode run`.
//
// Handles three modes:
//   1. Non-interactive (default): sends a single prompt, streams events to
//      stdout, and exits when the session goes idle.
//   2. Interactive local (`--interactive`): boots the split-footer direct mode
//      with an in-process server (no external HTTP).
//   3. Interactive attach (`--interactive --attach`): connects to a running
//      opencode server and runs interactive mode against it.
//
// Also supports `--command` for slash-command execution, `--format json` for
// raw event streaming, `--continue` / `--session` for session resumption,
// and `--fork` for forking before continuing.
import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { Effect } from "effect"
import { processEvents } from "@opencode-ai/core/process-events"
import { UI } from "../ui"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { EOL } from "os"
import { Filesystem } from "@/util/filesystem"
import {
  createOpencodeClient,
  type Event,
  type GlobalEvent,
  type OpencodeClient,
  type ToolPart,
} from "@opencode-ai/sdk/v2"
import { FormatError, FormatUnknownError } from "../error"
import {
  createTurnCompletionTracker,
  settleEventStream,
  turnCompletionError,
  waitForCompletedAssistant,
  waitForRunCompletion,
  waitForTerminalAssistant,
  waitForTurnCompletion,
} from "./run/event-stream"
import { serializeErrorEvent } from "./run/error-event"
import { INTERACTIVE_INPUT_ERROR, resolveInteractiveStdin } from "./run/runtime.stdin"
import { terminalToolPartsForTurn, unemittedTextParts } from "./run/turn-parts"
import { settledV2ToolPart, v2RunProgress, type V2RunProgress } from "./run/v2-progress"
import { resolveRunModel } from "./run/model-chain"
import { Config } from "@/config/config"

type V2PromptInput = Parameters<OpencodeClient["v2"]["session"]["prompt"]>[0]
type V2SessionMessage = NonNullable<
  NonNullable<Awaited<ReturnType<OpencodeClient["v2"]["session"]["messages"]>>["data"]>["data"]
>[number]
type ModelInput = {
  providerID: string
  modelID: string
  variant?: string
  chain?: NonNullable<V2PromptInput["model"]>["chain"]
}

function pick(value: string | undefined): ModelInput | undefined {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  return {
    providerID,
    modelID: rest.join("/"),
  }
}

function v2Model(model: ModelInput | undefined, variant: string | undefined): V2PromptInput["model"] | undefined {
  if (!model) return undefined
  return {
    providerID: model.providerID,
    id: model.modelID,
    ...(model.chain ? { chain: model.chain } : {}),
    ...(variant === undefined ? {} : { variant }),
  }
}

function v2Prompt(parts: Array<FilePart | { type: "text"; text: string }>): V2PromptInput["prompt"] {
  const text = parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  const files = parts
    .filter((part): part is FilePart => part.type === "file")
    .map((part) => ({ uri: part.url, mime: part.mime, ...(part.filename ? { name: part.filename } : {}) }))
  return { text, ...(files.length === 0 ? {} : { files }) }
}

function globalPayloadEvent(event: GlobalEvent): Event | undefined {
  if (event.payload.type === "sync") return undefined
  return event.payload
}

// Normalize `--attach` into a valid server URL for SDK construction. A bare
// numeric port (e.g. `--attach 4096`) is treated as localhost so users don't
// have to spell out the full `http://127.0.0.1:4096`.
function normalizeAttachUrl(value: string): string {
  return /^\d+$/.test(value) ? `http://127.0.0.1:${value}` : value
}

function resolveRunInput(value?: string, piped?: string): string | undefined {
  if (!value) {
    return piped
  }

  if (!piped) {
    return value
  }

  return value + "\n" + piped
}

type FilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

type Inline = {
  icon: string
  title: string
  description?: string
}

type SessionInfo = {
  id: string
  title?: string
  directory?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function formatRunError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

async function tool(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    if (next.mode === "block") {
      block(next, next.body)
      return
    }

    inline(next)
  } catch {
    inline({
      icon: "\u2699",
      title: part.tool,
    })
  }
}

async function toolError(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    inline({
      icon: "✗",
      title: `${next.title} failed`,
      ...(next.description && { description: next.description }),
    })
    return
  } catch {
    inline({
      icon: "✗",
      title: `${part.tool} failed`,
    })
  }
}

export const RunCommand = effectCmd({
  command: "run [message..]",
  describe: "run opencode with a message",
  // --attach connects to a remote server (no local instance needed); the
  // default path runs an in-process server and needs the project instance.
  instance: (args) => !args.attach,
  // For --dir without --attach, load instance for the resolved target dir.
  // The handler also chdirs (preserving the legacy order: chdir → file resolution).
  directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("share", {
        type: "boolean",
        describe: "share the session",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running opencode server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
      })
      .option("replay", {
        type: "boolean",
        default: true,
        describe: "replay interactive session history on resume and after resize (use --no-replay to disable)",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible interactive replay to the newest N messages",
      })
      .option("interactive", {
        alias: ["i"],
        type: "boolean",
        describe: "run in direct interactive split-footer mode",
        default: false,
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
      .option("demo", {
        type: "boolean",
        default: false,
        describe: "enable direct interactive demo slash commands; pass one as the message to run it immediately",
      }),
  handler: Effect.fn("Cli.run")(function* (args) {
    const { Agent } = yield* Effect.promise(() => import("@/agent/agent"))
    const { RuntimeFlags } = yield* Effect.promise(() => import("@/effect/runtime-flags"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const agentSvc = yield* Agent.Service
    const configSvc = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const config = args.attach ? undefined : yield* configSvc.get()
    const attachUrl = args.attach ? normalizeAttachUrl(args.attach) : undefined
    const attachHeaders = args.attach
      ? ServerAuth.headers({ password: args.password, username: args.username })
      : undefined
    const selectedAgent = args.agent
      ? args.attach
        ? yield* Effect.tryPromise({
            try: () =>
              createOpencodeClient({
                baseUrl: attachUrl!,
                directory: args.dir,
                headers: attachHeaders,
              })
                .app.agents(undefined, { throwOnError: true })
                .then((result) => (result.data ?? []).find((item) => item.name === args.agent)),
            catch: () => new CliError({ message: `failed to list agents from ${attachUrl ?? args.attach}` }),
          })
        : yield* agentSvc.get(args.agent)
      : undefined
    if (args.agent) {
      if (!selectedAgent) return yield* fail(`agent "${args.agent}" not found`)
      if (selectedAgent.mode === "subagent" && args.interactive)
        return yield* fail(`agent "${args.agent}" is a subagent and cannot be used in interactive mode`)
    }
    const explicitModel = pick(args.model)
    const configured = explicitModel
      ? undefined
      : args.attach
        ? yield* Effect.promise(() =>
            createOpencodeClient({
              baseUrl: attachUrl!,
              directory: args.dir,
              headers: attachHeaders,
            })
              .config.get(undefined, { throwOnError: true })
              .then((result) => result.data),
          )
        : {
            model_chains: config?.model_chains,
            default_model_chain: config?.default_model_chain,
          }
    const pending = resolveRunModel({
      explicit: explicitModel
        ? { providerID: explicitModel.providerID, id: explicitModel.modelID, variant: explicitModel.variant }
        : undefined,
      agent: selectedAgent?.model
        ? {
            providerID: selectedAgent.model.providerID,
            id: selectedAgent.model.modelID,
            ...(selectedAgent.variant ? { variant: selectedAgent.variant } : {}),
          }
        : undefined,
      chains: configured?.model_chains,
      defaultChainID: configured?.default_model_chain,
      variant: args.variant,
    })
    const providers =
      !explicitModel && pending?.chain
        ? args.attach
          ? yield* Effect.tryPromise({
              try: () =>
                createOpencodeClient({
                  baseUrl: attachUrl!,
                  directory: args.dir,
                  headers: attachHeaders,
                })
                  .config.providers(undefined, { throwOnError: true })
                  .then((result) => result.data?.providers ?? []),
              catch: () => new CliError({ message: `failed to list providers from ${attachUrl ?? args.attach}` }),
            })
          : yield* Effect.gen(function* () {
              const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
              const providerSvc = yield* Provider.Service
              return Object.values(yield* providerSvc.list())
            })
        : undefined
    const admitted = providers
      ? resolveRunModel({
          explicit: undefined,
          agent: selectedAgent?.model
            ? {
                providerID: selectedAgent.model.providerID,
                id: selectedAgent.model.modelID,
                ...(selectedAgent.variant ? { variant: selectedAgent.variant } : {}),
              }
            : undefined,
          chains: configured?.model_chains,
          defaultChainID: configured?.default_model_chain,
          variant: args.variant,
          providers,
        })
      : pending
    const model = admitted
      ? {
          providerID: admitted.providerID,
          modelID: admitted.id,
          ...(admitted.variant ? { variant: admitted.variant } : {}),
          ...(admitted.chain
            ? { chain: { ...admitted.chain, steps: admitted.chain.steps.map((step) => ({ ...step })) } }
            : {}),
        }
      : undefined
    const variant = model?.variant
    yield* Effect.promise(async () => {
      const rawMessage = [...args.message, ...(args["--"] || [])].join(" ")
      const thinking = args.interactive ? (args.thinking ?? true) : (args.thinking ?? false)
      const die = (message: string): never => {
        throw new CliError({ message })
      }
      const dieInteractive = (error: unknown): never => {
        if (error instanceof Error && error.message === INTERACTIVE_INPUT_ERROR) {
          die(error.message)
        }

        throw error
      }

      let message = [...args.message, ...(args["--"] || [])]
        .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
        .join(" ")

      if (args.interactive && args.command) {
        die("--interactive cannot be used with --command")
      }

      if (args.demo && !args.interactive) {
        die("--demo requires --interactive")
      }

      if (args.interactive && args.format === "json") {
        die("--interactive cannot be used with --format json")
      }

      if (args["replay-limit"] !== undefined && !args.interactive) {
        die("--replay-limit requires --interactive")
      }

      if (
        args["replay-limit"] !== undefined &&
        (!Number.isInteger(args["replay-limit"]) || args["replay-limit"] <= 0)
      ) {
        die("--replay-limit must be a positive integer")
      }

      if (args.interactive && !process.stdout.isTTY) {
        die("--interactive requires a TTY stdout")
      }

      if (args.interactive) {
        try {
          resolveInteractiveStdin().cleanup?.()
        } catch (error) {
          dieInteractive(error)
        }
      }

      const replay = args.replay || args["replay-limit"] !== undefined

      const root = Filesystem.resolve(process.env.PWD ?? process.cwd())
      const directory = (() => {
        if (!args.dir) return args.attach ? undefined : root
        if (args.attach) return args.dir

        try {
          process.chdir(path.isAbsolute(args.dir) ? args.dir : path.join(root, args.dir))
          return process.cwd()
        } catch {
          UI.error("Failed to change directory to " + args.dir)
          process.exit(1)
        }
      })()
      const attachSDK = (dir?: string) => {
        return createOpencodeClient({
          baseUrl: attachUrl!,
          directory: dir,
          headers: attachHeaders,
        })
      }

      const files: FilePart[] = []
      if (args.file) {
        const list = Array.isArray(args.file) ? args.file : [args.file]

        for (const filePath of list) {
          const resolvedPath = path.resolve(args.attach ? root : (directory ?? root), filePath)
          if (!(await Filesystem.exists(resolvedPath))) {
            UI.error(`File not found: ${filePath}`)
            process.exit(1)
          }

          const mime = (await Filesystem.isDir(resolvedPath)) ? "application/x-directory" : "text/plain"

          files.push({
            type: "file",
            url: pathToFileURL(resolvedPath).href,
            filename: path.basename(resolvedPath),
            mime,
          })
        }
      }

      const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
      message = resolveRunInput(message, piped) ?? ""
      const initialInput = resolveRunInput(rawMessage, piped)

      if (message.trim().length === 0 && !args.command && !args.interactive) {
        UI.error("You must provide a message or a command")
        process.exit(1)
      }

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exit(1)
      }

      const rules: PermissionV1.Ruleset = args.interactive
        ? []
        : [
            {
              permission: "question",
              action: "deny",
              pattern: "*",
            },
          ]

      function title() {
        if (args.title === undefined) return
        if (args.title !== "") return args.title
        return message.slice(0, 50) + (message.length > 50 ? "..." : "")
      }

      async function session(sdk: OpencodeClient): Promise<SessionInfo | undefined> {
        if (args.session) {
          const current = await sdk.v2.session
            .get({
              sessionID: args.session,
            })
            .catch(() => undefined)
          const info = current?.data?.data

          if (!info) {
            UI.error("Session not found")
            process.exit(1)
          }

          if (args.fork) {
            const forked = await sdk.session.fork({
              sessionID: args.session,
            })
            const id = forked.data?.id
            if (!id) {
              return
            }

            return {
              id,
              title: forked.data?.title ?? info.title,
              directory: forked.data?.directory ?? info.location.directory,
            }
          }

          return {
            id: info.id,
            title: info.title,
            directory: info.location.directory,
          }
        }

        const base = args.continue ? (await sdk.session.list()).data?.find((item) => !item.parentID) : undefined

        if (base && args.fork) {
          const forked = await sdk.session.fork({
            sessionID: base.id,
          })
          const id = forked.data?.id
          if (!id) {
            return
          }

          return {
            id,
            title: forked.data?.title ?? base.title,
            directory: forked.data?.directory ?? base.directory,
          }
        }

        if (base) {
          return {
            id: base.id,
            title: base.title,
            directory: base.directory,
          }
        }

        if (!args.interactive && !args.command) {
          const result = await sdk.v2.session.create({
            location: directory ? { directory } : undefined,
            agent: args.agent,
            model: v2Model(model, variant),
          })
          if (result.error) throw result.error
          const id = result.data?.data.id
          if (!id) {
            return
          }

          const name = title()
          if (name !== undefined) {
            const updated = await sdk.session.update({ sessionID: id, title: name })
            if (updated.error) throw updated.error
          }

          return {
            id,
            title: name,
            directory,
          }
        }

        const name = title()
        const result = await sdk.session.create({
          title: name,
          agent: args.agent,
          model: model
            ? {
                providerID: model.providerID,
                id: model.modelID,
                ...(model.chain ? { chain: model.chain } : {}),
                variant,
              }
            : undefined,
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          return
        }

        return {
          id,
          title: result.data?.title ?? name,
          directory: result.data?.directory,
        }
      }

      async function share(sdk: OpencodeClient, sessionID: string) {
        const cfg = await sdk.config.get()
        if (cfg.error) throw cfg.error
        if (!cfg.data) return
        if (cfg.data.share !== "auto" && !flags.autoShare && !args.share) return cfg.data
        const res = await sdk.session.share({ sessionID }).catch((error) => {
          if (error instanceof Error && error.message.includes("disabled")) {
            UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
          }
          return { error }
        })
        if (!res.error && "data" in res && res.data?.share?.url) {
          UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + res.data.share.url)
        }
        return cfg.data
      }

      async function createFreshSession(
        sdk: OpencodeClient,
        input: { agent: string | undefined; model: ModelInput | undefined; variant: string | undefined },
      ): Promise<SessionInfo> {
        const result = await sdk.session.create({
          title: args.title !== undefined && args.title !== "" ? args.title : undefined,
          agent: input.agent,
          model: input.model
            ? {
                providerID: input.model.providerID,
                id: input.model.modelID,
                ...(input.model.chain ? { chain: input.model.chain } : {}),
                variant: input.variant,
              }
            : undefined,
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          throw new Error("Failed to create session")
        }

        void share(sdk, id).catch(() => {})
        return {
          id,
          title: result.data?.title,
        }
      }

      async function current(sdk: OpencodeClient): Promise<string> {
        if (!args.attach) {
          return directory ?? root
        }

        const next = await sdk.path
          .get()
          .then((x) => x.data?.directory)
          .catch(() => undefined)
        if (next) {
          return next
        }

        UI.error("Failed to resolve remote directory")
        process.exit(1)
      }

      async function execute(sdk: OpencodeClient) {
        const sess = await session(sdk)
        if (!sess?.id) {
          UI.error("Session not found")
          process.exit(1)
        }
        const sessionID = sess.id

        function emit(type: string, data: Record<string, unknown>) {
          if (args.format === "json") {
            process.stdout.write(
              JSON.stringify({
                type,
                timestamp: Date.now(),
                sessionID,
                ...data,
              }) + EOL,
            )
            return true
          }
          return false
        }

        // Consume one subscribed event stream for the active session and mirror it
        // to stdout/UI. `client` is passed explicitly because attach mode may
        // rebind the SDK to the session's directory after the subscription is
        // created, and replies issued from inside the loop must use that client.
        let observedError: string | undefined
        let finalAssistant: Extract<V2SessionMessage, { type: "assistant" }> | undefined
        const emittedParts = new Set<string>()
        const emittedV2Text = new Set<string>()
        const emittedV2Reasoning = new Set<string>()
        const v2Tools = new Map<string, Extract<V2RunProgress, { kind: "tool-started" }>>()
        const turnCompletions = createTurnCompletionTracker(sessionID)

        async function loop(
          client: OpencodeClient,
          events: Awaited<ReturnType<typeof sdk.global.event>>,
          interrupted: () => boolean,
        ) {
          const toggles = new Map<string, boolean>()
          let error: string | undefined

          for await (const item of events.stream) {
            const event = globalPayloadEvent(item)
            if (!event) continue

            turnCompletions.observe(event)

            const progress = v2RunProgress(event, sessionID)
            if (progress?.kind === "step-started" && args.format !== "json" && toggles.get("start") !== true) {
              UI.empty()
              UI.println(`> ${progress.agent} · ${progress.model}`)
              UI.empty()
              toggles.set("start", true)
            }

            if (progress?.kind === "text") {
              const key = `${progress.messageID}:${progress.partID}`
              if (!emittedV2Text.has(key) && progress.text.trim()) {
                emittedV2Text.add(key)
                const part = {
                  id: progress.partID,
                  sessionID,
                  messageID: progress.messageID,
                  type: "text" as const,
                  text: progress.text,
                  time: { start: progress.timestamp, end: progress.timestamp },
                }
                if (!emit("text", { part })) {
                  if (!process.stdout.isTTY) process.stdout.write(progress.text.trim() + EOL)
                  else {
                    UI.empty()
                    UI.println(progress.text.trim())
                    UI.empty()
                  }
                }
              }
            }

            if (progress?.kind === "reasoning" && thinking) {
              const key = `${progress.messageID}:${progress.partID}`
              if (!emittedV2Reasoning.has(key) && progress.text.trim()) {
                emittedV2Reasoning.add(key)
                const part = {
                  id: progress.partID,
                  sessionID,
                  messageID: progress.messageID,
                  type: "reasoning" as const,
                  text: progress.text,
                  time: { start: progress.timestamp, end: progress.timestamp },
                }
                if (!emit("reasoning", { part })) {
                  const line = `Thinking: ${progress.text.trim()}`
                  if (process.stdout.isTTY) {
                    UI.empty()
                    UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                    UI.empty()
                  } else process.stdout.write(line + EOL)
                }
              }
            }

            if (progress?.kind === "tool-started") v2Tools.set(progress.callID, progress)

            if (progress?.kind === "tool-succeeded" || progress?.kind === "tool-failed") {
              if (!emittedParts.has(progress.callID)) {
                const part = settledV2ToolPart(progress, v2Tools.get(progress.callID))
                emittedParts.add(progress.callID)
                if (!emit("tool_use", { part })) {
                  if (part.state.status === "completed") await tool(part)
                  if (part.state.status === "error") {
                    await toolError(part)
                    UI.error(part.state.error)
                  }
                }
              }
              v2Tools.delete(progress.callID)
            }

            if (
              event.type === "message.updated" &&
              event.properties.sessionID === sessionID &&
              event.properties.info.role === "assistant" &&
              args.format !== "json" &&
              toggles.get("start") !== true
            ) {
              UI.empty()
              UI.println(`> ${event.properties.info.agent} · ${event.properties.info.modelID}`)
              UI.empty()
              toggles.set("start", true)
            }

            if (event.type === "message.part.updated") {
              const part = event.properties.part
              if (part.sessionID !== sessionID) continue

              if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
                emittedParts.add(part.id)
                if (emit("tool_use", { part })) continue
                if (part.state.status === "completed") {
                  await tool(part)
                  continue
                }
                await toolError(part)
                UI.error(part.state.error)
              }

              if (
                part.type === "tool" &&
                part.tool === "task" &&
                part.state.status === "running" &&
                args.format !== "json"
              ) {
                if (toggles.get(part.id) === true) continue
                await tool(part)
                toggles.set(part.id, true)
              }

              if (part.type === "step-start") {
                if (emit("step_start", { part })) continue
              }

              if (part.type === "step-finish") {
                emittedParts.add(part.id)
                if (emit("step_finish", { part })) continue
              }

              if (part.type === "text" && part.time?.end) {
                const text = part.text.trim()
                if (!text) continue
                const key = `${part.messageID}:${part.id}`
                if (emittedV2Text.has(key)) continue
                emittedV2Text.add(key)
                if (emit("text", { part })) continue
                if (!process.stdout.isTTY) {
                  process.stdout.write(text + EOL)
                  continue
                }
                UI.empty()
                UI.println(text)
                UI.empty()
              }

              if (part.type === "reasoning" && part.time?.end && thinking) {
                if (emit("reasoning", { part })) continue
                const text = part.text.trim()
                if (!text) continue
                const line = `Thinking: ${text}`
                if (process.stdout.isTTY) {
                  UI.empty()
                  UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                  UI.empty()
                  continue
                }
                process.stdout.write(line + EOL)
              }
            }

            if (event.type === "session.error") {
              const props = event.properties
              if (props.sessionID !== sessionID || !props.error) continue
              if (interrupted()) continue
              let err = String(props.error.name)
              if ("data" in props.error && props.error.data && "message" in props.error.data) {
                err = String(props.error.data.message)
              }
              error = error ? error + EOL + err : err
              observedError = error
              if (emit("error", { error: serializeErrorEvent(props.error, err) })) continue
              UI.error(err)
            }

            if (event.type === "session.next.activity.failed") {
              const props = event.properties
              if (props.sessionID !== sessionID) continue
              if (interrupted()) continue
              const err = props.error.message
              error = error ? error + EOL + err : err
              observedError = error
              if (emit("error", { error: serializeErrorEvent(props.error, err) })) continue
              UI.error(err)
            }

            // Legacy idle can precede the durable completion verdict. Keep
            // listening until session.wait settles and finish drains/aborts SSE.

            if (event.type === "permission.asked") {
              const permission = event.properties
              if (permission.sessionID !== sessionID) continue

              if (args["dangerously-skip-permissions"]) {
                await client.permission.reply({
                  requestID: permission.id,
                  reply: "once",
                })
              } else {
                UI.println(
                  UI.Style.TEXT_WARNING_BOLD + "!",
                  UI.Style.TEXT_NORMAL +
                    `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
                )
                await client.permission.reply({
                  requestID: permission.id,
                  reply: "reject",
                })
              }
            }

            if (event.type === "surface.asked") {
              const question = event.properties
              if (question.sessionID !== sessionID) continue
              await client.v2.session.surface.dismiss({ sessionID, requestID: question.id })
            }
          }
          return error
        }

        async function readFinalAssistant(client: OpencodeClient) {
          const result = await client.v2.session.messages({ sessionID, order: "desc", limit: 20 })
          if (result.error) throw result.error
          return result.data?.data.find(
            (item): item is Extract<V2SessionMessage, { type: "assistant" }> => item.type === "assistant",
          )
        }

        async function waitForIdle(
          client: OpencodeClient,
          previousAssistantMarker: string,
          interrupted: () => boolean,
        ) {
          const waited = client.v2.session.wait({ sessionID }).then((result) => {
            if (result.error && !interrupted()) throw result.error
          })
          // The durable activity and completed assistant can settle before the
          // session-wide wait endpoint returns. Observe that exact terminal
          // boundary so a stale wait cannot strand an otherwise finished CLI.
          const observed = await waitForTerminalAssistant({
            wait: waited,
            interrupted,
            observe: async () => {
              const result = await client.v2.session.activity({ sessionID })
              if (result.error && !interrupted()) throw result.error
              const activity = result.data?.data
              if (activity?.type !== "idle" || !["completed", "failed", "interrupted"].includes(activity.activityStatus ?? ""))
                return { terminal: false }
              const assistant = await readFinalAssistant(client)
              if (assistant?.error !== undefined) throw assistant.error
              const fresh = JSON.stringify(assistant ?? null) !== previousAssistantMarker
              return { terminal: true, assistant: fresh && assistant?.time.completed ? assistant : undefined }
            },
          })
          finalAssistant = observed ?? await waitForCompletedAssistant({
            previousMarker: previousAssistantMarker,
            read: () => readFinalAssistant(client),
            interrupted,
            completed: (assistant) => !!assistant.time.completed,
            error: (assistant) => assistant.error,
          })
        }

        async function emitFinalText(client: OpencodeClient) {
          const message = finalAssistant ?? (await readFinalAssistant(client))
          if (!message) return
          for (const part of unemittedTextParts(message, emittedV2Text)) {
            emittedV2Text.add(`${message.id}:${part.id}`)
            if (emit("text", { part })) continue
            if (!process.stdout.isTTY) {
              process.stdout.write(part.text.trim() + EOL)
              continue
            }
            UI.empty()
            UI.println(part.text.trim())
            UI.empty()
          }
        }

        async function emitMissedFinalParts(client: OpencodeClient, turnID: string) {
          if (args.format !== "json") return
          // Load the full transcript, then select by the admitted user-message
          // ID. An ascending fixed-size page can contain only old history in a
          // long resumed session and silently omit the current turn.
          const result = await client.v2.session.messages({ sessionID })
          if (result.error) throw result.error
          for (const part of terminalToolPartsForTurn(result.data?.data ?? [], turnID, emittedParts)) {
            emittedParts.add(part.id)
            emit("tool_use", { part })
          }
        }

        function admittedTurnID(result: { data?: { data?: { id?: unknown } } }): string {
          const id = result.data?.data?.id
          if (typeof id !== "string" || !id) throw new Error("Session input was admitted without a turn ID")
          return id
        }

        async function validateModel(client: OpencodeClient, model: ModelInput | undefined) {
          if (!model) return true
          const result = await client.config.providers()
          const provider = result.data?.providers.find((item) => item.id === model.providerID)
          if (provider?.models?.[model.modelID]) return true
          UI.error(`Model not found: ${model.providerID}/${model.modelID}`)
          process.exitCode = 1
          return false
        }

        const cwd = args.attach ? (directory ?? sess.directory ?? (await current(sdk))) : (directory ?? root)
        const client = args.attach ? attachSDK(cwd) : sdk

        // Validate agent if specified
        const agent = args.agent

        const runConfig = await share(client, sessionID)

        if (!args.interactive) {
          const previousAssistantMarker = JSON.stringify((await readFinalAssistant(client)) ?? null)
          const eventAbort = new AbortController()
          let turnAdmitted = false
          let interruptRequested = false
          let interrupting: Promise<void> | undefined
          const interrupt = () => {
            interruptRequested = true
            process.exitCode = 130
            if (!turnAdmitted || interrupting) return
            interrupting = client.v2.session
              .interrupt({ sessionID })
              .then((result) => {
                if (result.error) throw result.error
              })
              .catch((error) => {
                observedError = error
                process.exitCode = 1
                eventAbort.abort()
              })
          }
          const admitted = () => {
            turnAdmitted = true
            if (interruptRequested) interrupt()
          }
          processEvents.on("SIGINT", interrupt)
          let completedDone = false
          const completed = loop(
            client,
            await client.global.event({ signal: eventAbort.signal }),
            () => interruptRequested,
          )
            .catch((e) => {
              if (eventAbort.signal.aborted) return observedError
              console.error(e)
              process.exitCode = 1
              return formatRunError(e)
            })
            .finally(() => {
              completedDone = true
            })
          async function finish(wait: Promise<unknown> | undefined, turnID: string) {
            let waitError: unknown
            let durableVerdict: "done" | "incomplete" | "unknown" | undefined
            if (wait) {
              await waitForRunCompletion({ completed, wait }).catch((error) => {
                waitError = error
              })
            }
            if (
              !waitError &&
              !observedError &&
              !interruptRequested &&
              runConfig?.session?.turn_completion?.enabled === true &&
              turnCompletions.get(turnID) === undefined
            ) {
              const activityBeforeCompletion = turnCompletions.activity(turnID)?.activityID
              await waitForTurnCompletion({
                messageID: turnID,
                tracker: turnCompletions,
                completed,
                done: () => completedDone,
                interrupted: () => interruptRequested,
                wait: () => waitForIdle(client, previousAssistantMarker, () => interruptRequested),
                readDurable: async () => {
                  const result = await client.v2.session.activity({ sessionID, messageID: turnID })
                  if (result.error) throw result.error
                  const activity = result.data?.data
                  if (activity?.type !== "idle") return
                  const verdict = activity.turnCompletionResult
                  if (verdict !== "done" && verdict !== "incomplete" && verdict !== "unknown") return
                  durableVerdict = verdict
                  return verdict
                },
                // A busy server can decide the bound verdict later than the
                // plain deadline: deferred continuations and evaluation claims
                // with exponential retry backoff (5s up to 5min) publish the
                // verdict on this still-open stream. One bounded extension
                // turns those slow decisions into real verdicts instead of a
                // missing-verdict run failure; a closed stream never extends.
                extensionMs: 300_000,
                maxExtensions: 1,
              }).catch((error) => {
                waitError = error
              })
              // A separately claimed evaluation can schedule a successor after
              // the first session.wait returned. Refresh only that own successor;
              // a foreign prompt must not replace the cached completed answer.
              if (turnCompletions.activity(turnID)?.activityID !== activityBeforeCompletion) finalAssistant = undefined
            }
            const completedError = await settleEventStream({
              completed,
              done: () => completedDone,
              abort: () => eventAbort.abort(),
            })
            if (completedError || observedError) process.exitCode = 1
            // The terminal verdict is emitted after bounded continuations. Bind
            // it to the promoted input so old Session verdicts cannot fail a new run.
            const verdict = turnCompletions.get(turnID) ?? durableVerdict
            const error = turnCompletionError(verdict, runConfig?.session?.turn_completion?.enabled === true)
            if (!waitError && !observedError && !interruptRequested && error) {
              if (!emit("error", { error: serializeErrorEvent(error) })) UI.error(error.message)
              process.exitCode = 1
            }
            if (waitError) {
              if (!emit("error", { error: serializeErrorEvent(waitError) })) UI.error(formatRunError(waitError))
              process.exitCode = 1
            }
          }

          try {
            // Subscribe first so a continuation opened during this read cannot
            // be replaced by an older activity snapshot.
            const currentActivity = await client.v2.session.activity({ sessionID })
            if (currentActivity.error) throw currentActivity.error
            if (currentActivity.data?.data.activityID) turnCompletions.seed(currentActivity.data.data.activityID)
            if (args.command) {
              if (!(await validateModel(client, model))) return
              const result = await client.v2.session.command({
                sessionID,
                agent,
                model: v2Model(model, variant),
                command: args.command,
                arguments: message,
              })
              if (result.error) {
                if (!emit("error", { error: serializeErrorEvent(result.error) })) UI.error(formatRunError(result.error))
                process.exitCode = 1
                return
              }
              admitted()
              const turnID = admittedTurnID(result)
              await finish(
                waitForIdle(client, previousAssistantMarker, () => interruptRequested),
                turnID,
              )
              await emitMissedFinalParts(client, turnID)
              await emitFinalText(client)
              return
            }

            if (!(await validateModel(client, model))) return
            const result = await client.v2.session.prompt({
              sessionID,
              agent,
              model: v2Model(model, variant),
              prompt: v2Prompt([...files, { type: "text", text: message }]),
            })
            if (result.error) {
              if (!emit("error", { error: serializeErrorEvent(result.error) })) UI.error(formatRunError(result.error))
              process.exitCode = 1
              return
            }
            admitted()
            const turnID = admittedTurnID(result)
            await finish(
              waitForIdle(client, previousAssistantMarker, () => interruptRequested),
              turnID,
            )
            await emitMissedFinalParts(client, turnID)
            await emitFinalText(client)
            return
          } finally {
            processEvents.off("SIGINT", interrupt)
            await interrupting
            eventAbort.abort()
          }
        }

        const { runInteractiveMode } = await import("./run/runtime")
        try {
          await runInteractiveMode({
            sdk: client,
            directory: cwd,
            sessionID,
            sessionTitle: sess.title,
            resume: Boolean(args.session || args.continue) && !args.fork,
            replay,
            replayLimit: args["replay-limit"],
            agent,
            model,
            variant,
            files,
            initialInput,
            createSession: createFreshSession,
            thinking,
            backgroundSubagents: flags.experimentalBackgroundSubagents,
            demo: args.demo,
          })
        } catch (error) {
          dieInteractive(error)
        }
        return
      }

      if (args.interactive && !args.attach && !args.session && !args.continue) {
        const { runInteractiveLocalMode } = await import("./run/runtime")
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const { Server } = await import("@/server/server")
          const request = new Request(input, init)
          const headers = new Headers(request.headers)
          const auth = ServerAuth.header()
          if (auth) headers.set("Authorization", auth)
          return Server.Default().app.fetch(new Request(request, { headers }))
        }) as typeof globalThis.fetch

        try {
          return await runInteractiveLocalMode({
            directory: directory ?? root,
            fetch: fetchFn,
            resolveAgent: async () => args.agent,
            session,
            share: async (sdk, sessionID) => {
              await share(sdk, sessionID)
            },
            createSession: createFreshSession,
            agent: args.agent,
            model,
            variant,
            replay,
            replayLimit: args["replay-limit"],
            files,
            initialInput,
            thinking,
            backgroundSubagents: flags.experimentalBackgroundSubagents,
            demo: args.demo,
          })
        } catch (error) {
          dieInteractive(error)
        }
      }

      if (args.attach) {
        const sdk = attachSDK(directory)
        return await execute(sdk)
      }

      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const { Server } = await import("@/server/server")
        const request = new Request(input, init)
        const headers = new Headers(request.headers)
        const auth = ServerAuth.header()
        if (auth) headers.set("Authorization", auth)
        return Server.Default().app.fetch(new Request(request, { headers }))
      }) as typeof globalThis.fetch
      const sdk = createOpencodeClient({
        baseUrl: "http://opencode.internal",
        fetch: fetchFn,
        directory,
      })
      await execute(sdk)
    })
  }),
})
