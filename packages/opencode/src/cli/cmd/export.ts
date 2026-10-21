import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageV2 } from "../../session/message-v2"
import { SessionID } from "../../session/schema"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { EOL } from "os"
import { asc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

type ExportData = {
  info: Session.Info
  messages: SessionV1.WithParts[]
  v2: {
    version: 2
    messages: SessionMessage.Message[]
  }
}

function redact(kind: string, id: string, value: string) {
  return value.trim() ? `[redacted:${kind}:${id}]` : value
}

function data(kind: string, id: string, value: Record<string, unknown> | undefined) {
  if (!value) return value
  return Object.keys(value).length ? { redacted: `${kind}:${id}` } : value
}

function span(id: string, value: { value: string; start: number; end: number }) {
  return {
    ...value,
    value: redact("file-text", id, value.value),
  }
}

function diff(kind: string, diffs: { file?: string; patch?: string }[] | undefined) {
  return diffs?.map((item, i) => ({
    ...item,
    file: item.file === undefined ? undefined : redact(`${kind}-file`, String(i), item.file),
    patch: item.patch === undefined ? undefined : redact(`${kind}-patch`, String(i), item.patch),
  }))
}

function source(part: SessionV1.FilePart) {
  if (!part.source) return part.source
  if (part.source.type === "symbol") {
    return {
      ...part.source,
      path: redact("file-path", part.id, part.source.path),
      name: redact("file-symbol", part.id, part.source.name),
      text: span(part.id, part.source.text),
    }
  }
  if (part.source.type === "resource") {
    return {
      ...part.source,
      clientName: redact("file-client", part.id, part.source.clientName),
      uri: redact("file-uri", part.id, part.source.uri),
      text: span(part.id, part.source.text),
    }
  }
  return {
    ...part.source,
    path: redact("file-path", part.id, part.source.path),
    text: span(part.id, part.source.text),
  }
}

function filepart(part: SessionV1.FilePart): SessionV1.FilePart {
  return {
    ...part,
    url: redact("file-url", part.id, part.url),
    filename: part.filename === undefined ? undefined : redact("file-name", part.id, part.filename),
    source: source(part),
  }
}

function part(part: SessionV1.Part): SessionV1.Part {
  switch (part.type) {
    case "text":
      return {
        ...part,
        text: redact("text", part.id, part.text),
        metadata: data("text-metadata", part.id, part.metadata),
      }
    case "reasoning":
      return {
        ...part,
        text: redact("reasoning", part.id, part.text),
        metadata: data("reasoning-metadata", part.id, part.metadata),
      }
    case "file":
      return filepart(part)
    case "subtask":
      return {
        ...part,
        prompt: redact("subtask-prompt", part.id, part.prompt),
        description: redact("subtask-description", part.id, part.description),
        command: part.command === undefined ? undefined : redact("subtask-command", part.id, part.command),
      }
    case "tool":
      return {
        ...part,
        metadata: data("tool-metadata", part.id, part.metadata),
        state:
          part.state.status === "pending"
            ? {
                ...part.state,
                input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                raw: redact("tool-raw", part.id, part.state.raw),
              }
            : part.state.status === "running"
              ? {
                  ...part.state,
                  input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                  title: part.state.title === undefined ? undefined : redact("tool-title", part.id, part.state.title),
                  metadata: data("tool-state-metadata", part.id, part.state.metadata),
                }
              : part.state.status === "completed"
                ? {
                    ...part.state,
                    input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                    output: redact("tool-output", part.id, part.state.output),
                    title: redact("tool-title", part.id, part.state.title),
                    metadata: data("tool-state-metadata", part.id, part.state.metadata) ?? part.state.metadata,
                    attachments: part.state.attachments?.map(filepart),
                  }
                : {
                    ...part.state,
                    input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                    metadata: data("tool-state-metadata", part.id, part.state.metadata),
                  },
      }
    case "patch":
      return {
        ...part,
        hash: redact("patch", part.id, part.hash),
        files: part.files.map((item: string, i: number) => redact("patch-file", `${part.id}-${i}`, item)),
      }
    case "snapshot":
      return {
        ...part,
        snapshot: redact("snapshot", part.id, part.snapshot),
      }
    case "step-start":
      return {
        ...part,
        snapshot: part.snapshot === undefined ? undefined : redact("snapshot", part.id, part.snapshot),
      }
    case "step-finish":
      return {
        ...part,
        snapshot: part.snapshot === undefined ? undefined : redact("snapshot", part.id, part.snapshot),
      }
    case "agent":
      return {
        ...part,
        source: !part.source
          ? part.source
          : {
              ...part.source,
              value: redact("agent-source", part.id, part.source.value),
            },
      }
    default:
      return part
  }
}

const partFn = part

export function sanitizeExport(data: ExportData) {
  return {
    info: {
      ...data.info,
      title: redact("session-title", data.info.id, data.info.title),
      directory: redact("session-directory", data.info.id, data.info.directory),
      summary: !data.info.summary
        ? data.info.summary
        : {
            ...data.info.summary,
            diffs: diff("session-diff", data.info.summary.diffs),
          },
      revert: !data.info.revert
        ? data.info.revert
        : {
            ...data.info.revert,
            snapshot:
              data.info.revert.snapshot === undefined
                ? undefined
                : redact("revert-snapshot", data.info.id, data.info.revert.snapshot),
            diff:
              data.info.revert.diff === undefined
                ? undefined
                : redact("revert-diff", data.info.id, data.info.revert.diff),
          },
    },
    messages: data.messages.map((msg) => ({
      info:
        msg.info.role === "user"
          ? {
              ...msg.info,
              system: msg.info.system === undefined ? undefined : redact("system", msg.info.id, msg.info.system),
              summary: !msg.info.summary
                ? msg.info.summary
                : {
                    ...msg.info.summary,
                    title:
                      msg.info.summary.title === undefined
                        ? undefined
                        : redact("summary-title", msg.info.id, msg.info.summary.title),
                    body:
                      msg.info.summary.body === undefined
                        ? undefined
                        : redact("summary-body", msg.info.id, msg.info.summary.body),
                    diffs: diff("message-diff", msg.info.summary.diffs),
                  },
            }
          : {
              ...msg.info,
              path: {
                cwd: redact("cwd", msg.info.id, msg.info.path.cwd),
                root: redact("root", msg.info.id, msg.info.path.root),
              },
            },
      parts: msg.parts.map(partFn),
    })),
    v2: {
      version: data.v2.version,
      messages: sanitizeCanonicalMessages(data.v2.messages),
    },
  }
}

export function sanitizeCanonicalMessages(messages: SessionMessage.Message[]) {
  return messages.map(canonicalMessage)
}

function canonicalMessage(message: SessionMessage.Message): unknown {
  const base = {
    ...message,
    metadata: data("v2-message-metadata", message.id, message.metadata),
  }
  if (message.type === "user")
    return {
      ...base,
      text: redact("v2-user-text", message.id, message.text),
      files: message.files?.map((file, index) => ({
        ...file,
        uri: redact("v2-user-file-uri", `${message.id}-${index}`, file.uri),
        name: file.name === undefined ? undefined : redact("v2-user-file-name", `${message.id}-${index}`, file.name),
        description:
          file.description === undefined
            ? undefined
            : redact("v2-user-file-description", `${message.id}-${index}`, file.description),
        source: !file.source
          ? file.source
          : {
              ...file.source,
              text: redact("v2-user-file-source", `${message.id}-${index}`, file.source.text),
            },
      })),
      agents: message.agents?.map((agent, index) => ({
        ...agent,
        name: redact("v2-user-agent", `${message.id}-${index}`, agent.name),
        source: !agent.source
          ? agent.source
          : {
              ...agent.source,
              text: redact("v2-user-agent-source", `${message.id}-${index}`, agent.source.text),
            },
      })),
      format: message.format === undefined ? undefined : { redacted: `v2-user-format:${message.id}` },
    }
  if (message.type === "synthetic" || message.type === "system")
    return { ...base, text: redact(`v2-${message.type}-text`, message.id, message.text) }
  if (message.type === "shell")
    return {
      ...base,
      command: redact("v2-shell-command", message.id, message.command),
      output: redact("v2-shell-output", message.id, message.output),
    }
  if (message.type === "compaction")
    return {
      ...base,
      summary: redact("v2-compaction-summary", message.id, message.summary),
      recent: redact("v2-compaction-recent", message.id, message.recent),
    }
  if (message.type !== "assistant") return base
  return {
    ...base,
    structured: message.structured === undefined ? undefined : { redacted: `v2-assistant-structured:${message.id}` },
    error: message.error === undefined ? undefined : { redacted: `v2-assistant-error:${message.id}` },
    content: message.content.map((content) => {
      if (content.type === "text" || content.type === "reasoning")
        return {
          ...content,
          text: redact(`v2-assistant-${content.type}`, content.id, content.text),
          ...("providerMetadata" in content && content.providerMetadata !== undefined
            ? { providerMetadata: { redacted: `v2-assistant-provider-metadata:${content.id}` } }
            : {}),
        }
      if (content.type === "custom")
        return {
          ...content,
          data: { redacted: `v2-assistant-custom-data:${content.id}` },
          title: content.title === undefined ? undefined : redact("v2-assistant-custom-title", content.id, content.title),
          fallback:
            content.fallback === undefined
              ? undefined
              : redact("v2-assistant-custom-fallback", content.id, content.fallback),
          metadata: data("v2-assistant-custom-metadata", content.id, content.metadata),
        }
      return {
        ...content,
        provider:
          content.provider === undefined
            ? undefined
            : {
                ...content.provider,
                metadata: data("v2-tool-provider-metadata", content.id, content.provider.metadata),
                resultMetadata: data(
                  "v2-tool-provider-result-metadata",
                  content.id,
                  content.provider.resultMetadata,
                ),
              },
        state: {
          ...content.state,
          input:
            typeof content.state.input === "string"
              ? redact("v2-tool-input", content.id, content.state.input)
              : data("v2-tool-input", content.id, content.state.input) ?? {},
          ...("structured" in content.state
            ? { structured: data("v2-tool-structured", content.id, content.state.structured) ?? {} }
            : {}),
          ...("content" in content.state
            ? {
                content: content.state.content.map((_, index) => ({
                  redacted: `v2-tool-content:${content.id}-${index}`,
                })),
              }
            : {}),
          ...("attachments" in content.state && content.state.attachments
            ? {
                attachments: content.state.attachments.map((attachment, index) => ({
                  ...attachment,
                  uri: redact("v2-tool-attachment-uri", `${content.id}-${index}`, attachment.uri),
                  name:
                    attachment.name === undefined
                      ? undefined
                      : redact("v2-tool-attachment-name", `${content.id}-${index}`, attachment.name),
                })),
              }
            : {}),
          ...("outputPaths" in content.state && content.state.outputPaths
            ? {
                outputPaths: content.state.outputPaths.map((value, index) =>
                  redact("v2-tool-output-path", `${content.id}-${index}`, value),
                ),
              }
            : {}),
          ...("result" in content.state && content.state.result !== undefined
            ? { result: { redacted: `v2-tool-result:${content.id}` } }
            : {}),
          ...("error" in content.state ? { error: { redacted: `v2-tool-error:${content.id}` } } : {}),
        },
      }
    }),
  }
}

export const ExportCommand = effectCmd({
  command: "export [sessionID]",
  describe: "export session data as JSON",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session id to export",
        type: "string",
      })
      .option("sanitize", {
        describe: "redact sensitive transcript and file data",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.export")(function* (args) {
    return yield* run(args)
  }),
})

const run = Effect.fn("Cli.export.body")(function* (args: { sessionID?: string; sanitize?: boolean }) {
  const svc = yield* Session.Service
  const { db } = yield* Database.Service
  let sessionID = args.sessionID ? SessionID.make(args.sessionID) : undefined
  process.stderr.write(`Exporting session: ${sessionID ?? "latest"}\n`)

  if (!sessionID) {
    UI.empty()
    prompts.intro("Export session", { output: process.stderr })

    const sessions = yield* svc.list()

    if (sessions.length === 0) {
      prompts.log.error("No sessions found", { output: process.stderr })
      prompts.outro("Done", { output: process.stderr })
      return
    }

    sessions.sort((a, b) => b.time.updated - a.time.updated)

    const selectedSession = yield* Effect.promise(() =>
      prompts.autocomplete({
        message: "Select session to export",
        maxItems: 10,
        options: sessions.map((session) => ({
          label: session.title,
          value: session.id,
          hint: `${new Date(session.time.updated).toLocaleString()} • ${session.id.slice(-8)}`,
        })),
        output: process.stderr,
      }),
    )

    if (prompts.isCancel(selectedSession)) {
      return yield* Effect.die(new UI.CancelledError())
    }

    sessionID = selectedSession

    prompts.outro("Exporting session...", { output: process.stderr })
  }

  // Match legacy try/catch — catches both typed failures and defects
  // (Session.Service.get throws NotFoundError as a defect, not a typed E).
  return yield* Effect.gen(function* () {
    const sessionInfo = yield* svc.get(sessionID!)
    const messages = yield* svc.messages({ sessionID: sessionInfo.id })
    const decodeCanonical = Schema.decodeUnknownEffect(SessionMessage.Message)
    const v2Messages = yield* Effect.forEach(
      yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionInfo.id))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie),
      (row) => decodeCanonical({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie),
    )

    const exportData = { info: sessionInfo, messages, v2: { version: 2 as const, messages: v2Messages } }

    process.stdout.write(JSON.stringify(args.sanitize ? sanitizeExport(exportData) : exportData, null, 2))
    process.stdout.write(EOL)
  }).pipe(Effect.catchCause(() => fail(`Session not found: ${sessionID!}`)))
})
