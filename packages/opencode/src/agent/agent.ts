import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Config } from "@/config/config"
import { ConfigAgent } from "@opencode-ai/core/config/agent"
import { ConfigModelChain } from "@opencode-ai/core/config/model-chain"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Provider } from "@/provider/provider"

import { streamObject, type ModelMessage } from "ai"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"
import { HeadlessAI } from "@/headless-ai"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import nodeFS from "fs/promises"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { AbsolutePath, type DeepMutable } from "@opencode-ai/core/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { Reference } from "@opencode-ai/core/reference"
import { Location } from "@opencode-ai/core/location"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { PermissionSchema } from "@opencode-ai/core/permission/schema"

const PLAN_SYSTEM = `You are a planning agent. Collaborate with the user until the work is decision-complete.

Use read-only inspection and questions to resolve uncertainty. Maintain the single session plan with plan_document when that tool is available. Do not edit project files or run implementation commands. When the plan is ready, present it clearly. If the user has approved it or explicitly asks to implement it—including in a later message after the plan was presented, such as "Implement it now"—call switch_agent with agent "build" and an exact prompt to implement the approved plan in the current session. The tool opens the confirmation UI. Do not merely promise that implementation will start, attempt implementation from the plan agent, ask the user to switch agents manually, or author a switch action.`

const agentContextExtensions = new Set([".md", ".txt", ".prompt"])

export function isManualInstructionPath(root: string, requested: string, canonical: string, allowExternal = false) {
  if (!agentContextExtensions.has(path.extname(requested).toLowerCase())) return false
  if (!agentContextExtensions.has(path.extname(canonical).toLowerCase())) return false
  if (allowExternal) return true
  const relative = path.relative(root, requested)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false
  const canonicalRelative = path.relative(root, canonical)
  return !(
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalRelative)
  )
}

export async function readManualInstructionFile(rootInput: string, file: string) {
  const root = path.resolve(await nodeFS.realpath(rootInput))
  const explicitlyAbsolute = path.isAbsolute(file)
  const requested = path.resolve(root, file)
  const canonical = await nodeFS.realpath(requested).catch(() => undefined)
  if (!canonical || !isManualInstructionPath(root, requested, canonical, explicitlyAbsolute)) return undefined
  const content = await nodeFS.readFile(canonical, "utf8").catch(() => "")
  return content ? { canonical, content } : undefined
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
      chain: Schema.optional(ModelV2.Chain),
    }),
  ),
  modelTarget: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  systemMode: Schema.optional(Schema.Literals(["inherit", "append", "replace"])),
  instructions: Schema.optional(
    Schema.Struct({
      mode: Schema.Literals(["inherit", "manual"]),
      files: Schema.Array(Schema.String),
    }),
  ),
  instructionPrompt: Schema.optional(Schema.String),
  tools: Schema.optional(
    Schema.Struct({
      mode: Schema.Literals(["inherit", "explicit"]),
      entries: Schema.Record(
        Schema.String,
        Schema.Struct({
          visible: Schema.optional(Schema.Boolean),
          permission: Schema.optional(Schema.Literals(["allow", "ask", "deny"])),
        }),
      ),
    }),
  ),
  completion: Schema.optional(
    Schema.Struct({
      mode: Schema.Literals(["inherit", "custom"]),
      prompt: Schema.optional(Schema.String),
      files: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError | Provider.InitError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const headlessAI = yield* HeadlessAI.Service
    const locations = yield* LocationServiceMap

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const referenceDirs = yield* Effect.gen(function* () {
          yield* (yield* PluginBoot.Service).wait()
          return (yield* (yield* Reference.Service).list()).map((reference) => reference.path)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        const managedOutputGlob = path.join(Global.Path.data, ToolOutputStore.MANAGED_DIRECTORY, "*")
        const whitelistedDirs = [
          managedOutputGlob,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
          ...referenceDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          surface: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                surface: "allow",
                switch_agent: {
                  "*": "deny",
                  plan: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          plan: {
            name: "plan",
            description: "Planning agent with read-only workspace access and one session-owned plan document.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                surface: "allow",
                bash: "deny",
                task: {
                  general: "deny",
                },
                edit: "deny",
                plan_document: "allow",
                switch_agent: {
                  "*": "deny",
                  build: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
            prompt: PLAN_SYSTEM,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions. This agent may run on a fast low-reasoning model: use it for lookups you will verify yourself, not for bug hunting, root-cause analysis, or correctness judgments you would act on unchecked.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) {
            const target = ConfigModelChain.agentTarget(value.model, cfg.model_chains)
            item.model = {
              modelID: target.id,
              providerID: target.providerID,
              ...(target.chain ? { chain: { ...target.chain, steps: target.chain.steps.map((step) => ({ ...step })) } } : {}),
            }
            item.modelTarget = value.model
          }
          item.variant = item.model?.chain ? undefined : (value.variant ?? item.variant)
          item.prompt = value.prompt ?? item.prompt
          item.completion = value.completion
            ? { ...value.completion, files: value.completion.files ? [...value.completion.files] : undefined }
            : item.completion
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          const options = { ...(value.options ?? {}) }
          const configuredSystemMode = options.__agentSystemMode
          if (
            configuredSystemMode === "inherit" ||
            configuredSystemMode === "append" ||
            configuredSystemMode === "replace"
          ) {
            item.systemMode = configuredSystemMode
          }
          const configuredSystemFiles = Array.isArray(options.__agentSystemFiles)
            ? options.__agentSystemFiles.filter((file): file is string => typeof file === "string")
            : []
          if (configuredSystemFiles.length > 0) {
            const contents: string[] = []
            for (const file of configuredSystemFiles) {
              const loaded = yield* Effect.promise(() => readManualInstructionFile(ctx.directory, file))
              if (!loaded) {
                yield* Effect.logWarning("Skipping unsafe, missing, or unsupported agent system prompt file", {
                  agent: key,
                  file,
                })
                continue
              }
              contents.push(loaded.content)
            }
            item.prompt = [item.prompt, ...contents].filter(Boolean).join("\n\n") || undefined
          }
          const configuredInstructions = options.__agentInstructions
          if (configuredInstructions && typeof configuredInstructions === "object") {
            const candidate = configuredInstructions as { mode?: "inherit" | "manual"; files?: unknown }
            if ((candidate.mode === "inherit" || candidate.mode === "manual") && Array.isArray(candidate.files)) {
              item.instructions = {
                mode: candidate.mode,
                files: candidate.files.filter((file): file is string => typeof file === "string"),
              }
              if (item.instructions.mode === "manual") {
                const root = path.resolve(ctx.directory)
                const contents: string[] = []
                for (const file of item.instructions.files) {
                  const loaded = yield* Effect.promise(() => readManualInstructionFile(root, file))
                  if (!loaded) {
                    yield* Effect.logWarning("Skipping unsafe, missing, or non-Markdown manual agent instruction", {
                      agent: key,
                      file,
                    })
                    continue
                  }
                  contents.push(`Instructions from: ${loaded.canonical}\n${loaded.content}`)
                }
                item.instructionPrompt = contents.join("\n\n") || undefined
              }
            }
          }
          if (item.completion?.mode === "custom" && item.completion.files?.length) {
            const contents: string[] = []
            for (const file of item.completion.files) {
              const loaded = yield* Effect.promise(() => readManualInstructionFile(ctx.directory, file))
              if (!loaded) {
                yield* Effect.logWarning("Skipping unsafe, missing, or unsupported agent completion prompt file", {
                  agent: key,
                  file,
                })
                continue
              }
              contents.push(loaded.content)
            }
            item.completion.prompt = [item.completion.prompt, ...contents].filter(Boolean).join("\n\n") || undefined
          }
          const configuredTools = options.__agentTools
          const candidate = configuredTools && typeof configuredTools === "object"
            ? configuredTools as {
              mode?: "inherit" | "explicit"
              entries?: Record<string, { visible?: boolean; permission?: "allow" | "ask" | "deny" }>
            }
            : undefined
          const toolSwitches = candidate && (candidate.mode === "inherit" || candidate.mode === "explicit")
            ? ConfigAgent.normalizeSwitchConfig(
                { mode: candidate.mode, entries: candidate.entries ?? {} },
                [],
              )
            : undefined
          if (toolSwitches?.tools) {
            item.tools = {
              mode: toolSwitches.tools.mode,
              entries: Object.fromEntries(
                Object.entries(toolSwitches.tools.entries ?? {}).map(([name, entry]) => [name, { ...entry }]),
              ),
            }
          }
          const configuredPermissions = Option.getOrUndefined(
            Schema.decodeUnknownOption(PermissionSchema.Ruleset)(options.__agentPermissions),
          )
          const normalizedPermissions = ConfigAgent.normalizeSwitchPermissions([
            ...(toolSwitches?.permissions ?? []),
            ...(configuredPermissions ?? []),
          ])
          delete options.__agentSystemMode
          delete options.__agentSystemFiles
          delete options.__agentInstructions
          delete options.__agentTools
          delete options.__agentPermissions
          item.options = mergeDeep(item.options, options)
          item.permission = Permission.merge(
            item.permission,
            Permission.fromConfig(value.permission ?? {}),
            normalizedPermissions.map((rule) => ({
              permission: rule.action,
              pattern: rule.resource,
              action: rule.effect,
            })),
          )
        }

        // Ensure managed tool-output files are readable unless explicitly configured.
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === managedOutputGlob
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [managedOutputGlob]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const telemetry = {
          isEnabled: cfg.experimental?.openTelemetry,
          tracer,
          metadata: {
            userId: cfg.username ?? "unknown",
          },
        }
        const messages = [
          ...(isOpenaiOauth
            ? []
            : system.map(
                (item): ModelMessage => ({
                  role: "system",
                  content: item,
                }),
              )),
          {
            role: "user",
            content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
          },
        ] satisfies ModelMessage[]
        const schema = Object.assign(
          Schema.toStandardSchemaV1(GeneratedAgent),
          Schema.toStandardJSONSchemaV1(GeneratedAgent),
        )

        if (isOpenaiOauth) {
          const language = yield* provider.getLanguage(resolved)
          return yield* Effect.promise(async () => {
            const result = streamObject({
              experimental_telemetry: telemetry,
              temperature: 0.3,
              messages,
              model: language,
              schema,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* headlessAI
          .object<Schema.Schema.Type<typeof GeneratedAgent>>({
            model: `${model.providerID}/${model.modelID}`,
            generation: { temperature: 0.3 },
            messages,
            schema,
            telemetry,
          })
          .pipe(
            Effect.map((result) => result.object),
            Effect.orDie,
          )
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(HeadlessAI.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(LocationServiceMap.layer),
)

const locationServiceMapNode = LayerNode.make(LocationServiceMap.layer, [])

export const node = LayerNode.make(layer, [
  Config.node,
  Auth.node,
  Plugin.node,
  Skill.node,
  Provider.node,
  HeadlessAI.node,
  locationServiceMapNode,
])

export * as Agent from "./agent"
