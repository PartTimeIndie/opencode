import type { Session as SDKSession, Message, Part } from "@opencode-ai/sdk/v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { CliError, effectCmd } from "../effect-cmd"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { InstanceRef } from "@/effect/instance-ref"
import { ShareNext } from "@/share/share-next"
import { EOL } from "os"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ContentStore } from "@opencode-ai/core/content-store"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment } from "@opencode-ai/core/session/prompt"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import type { ProjectV2 } from "@opencode-ai/core/project"
import { Effect, Schema } from "effect"
import type { InstanceContext } from "@/project/instance-context"

const decodeMessageInfo = Schema.decodeUnknownSync(SessionV1.Info)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)

/** Discriminated union returned by the ShareNext API (GET /api/shares/:id/data) */
export type ShareData =
  | { type: "session"; data: SDKSession }
  | { type: "message"; data: Message }
  | { type: "part"; data: Part }
  | { type: "session_diff"; data: unknown }
  | { type: "model"; data: unknown }

/** Extract share ID from a share URL like https://opncd.ai/share/abc123 */
export function parseShareUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/[^/]+\/share\/([a-zA-Z0-9_-]+)$/)
  return match ? match[1] : null
}

export function shouldAttachShareAuthHeaders(shareUrl: string, accountBaseUrl: string): boolean {
  try {
    return new URL(shareUrl).origin === new URL(accountBaseUrl).origin
  } catch {
    return false
  }
}

/**
 * Transform ShareNext API response (flat array) into the nested structure for local file storage.
 *
 * The API returns a flat array: [session, message, message, part, part, ...]
 * Local storage expects: { info: session, messages: [{ info: message, parts: [part, ...] }, ...] }
 *
 * This groups parts by their messageID to reconstruct the hierarchy before writing to disk.
 */
export function transformShareData(shareData: ShareData[]): {
  info: SDKSession
  messages: Array<{ info: Message; parts: Part[] }>
} | null {
  const sessionItem = shareData.find((d) => d.type === "session")
  if (!sessionItem) return null

  const messageMap = new Map<string, Message>()
  const partMap = new Map<string, Part[]>()

  for (const item of shareData) {
    if (item.type === "message") {
      messageMap.set(item.data.id, item.data)
    } else if (item.type === "part") {
      if (!partMap.has(item.data.messageID)) {
        partMap.set(item.data.messageID, [])
      }
      partMap.get(item.data.messageID)!.push(item.data)
    }
  }

  if (messageMap.size === 0) return null

  return {
    info: sessionItem.data,
    messages: Array.from(messageMap.values()).map((msg) => ({
      info: msg,
      parts: partMap.get(msg.id) ?? [],
    })),
  }
}

export type ExportData = { info: SDKSession; messages: Array<{ info: Message; parts: Part[] }> }

export type ImportDestination = {
  readonly projectID: ProjectV2.ID
  readonly directory: string
  readonly worktree: string
}

export const ImportCommand = effectCmd({
  command: "import <file>",
  describe: "import session data from JSON file or URL",
  builder: (yargs) =>
    yargs.positional("file", {
      describe: "path to JSON file or share URL",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.import")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* runImport(args.file, ctx).pipe(Effect.provide(ContentStore.defaultLayer))
  }),
})

const runImport = Effect.fn("Cli.import.body")(function* (file: string, ctx: InstanceContext) {
  const share = yield* ShareNext.Service
  const fs = yield* FSUtil.Service

  let exportData: ExportData | undefined

  const isUrl = file.startsWith("http://") || file.startsWith("https://")

  if (isUrl) {
    const slug = parseShareUrl(file)
    if (!slug) {
      const baseUrl = yield* Effect.orDie(share.url())
      process.stdout.write(`Invalid URL format. Expected: ${baseUrl}/share/<slug>`)
      process.stdout.write(EOL)
      return
    }

    const baseUrl = new URL(file).origin
    const req = yield* Effect.orDie(share.request())
    const headers = shouldAttachShareAuthHeaders(file, req.baseUrl) ? req.headers : {}

    const tryFetch = (url: string) =>
      Effect.tryPromise({
        try: () => fetch(url, { headers }),
        catch: (e) =>
          new CliError({
            message: `Failed to fetch share data: ${e instanceof Error ? e.message : String(e)}`,
          }),
      })

    const dataPath = req.api.data(slug)
    let response = yield* tryFetch(`${baseUrl}${dataPath}`)

    if (!response.ok && dataPath !== `/api/share/${slug}/data`) {
      response = yield* tryFetch(`${baseUrl}/api/share/${slug}/data`)
    }

    if (!response.ok) {
      process.stdout.write(`Failed to fetch share data: ${response.statusText}`)
      process.stdout.write(EOL)
      return
    }

    const shareData = yield* Effect.tryPromise({
      try: () => response.json() as Promise<ShareData[]>,
      catch: () => new CliError({ message: "Share data was not valid JSON" }),
    })
    const transformed = transformShareData(shareData)

    if (!transformed) {
      process.stdout.write(`Share not found or empty: ${slug}`)
      process.stdout.write(EOL)
      return
    }

    exportData = transformed
  } else {
    exportData = (yield* fs.readJson(file).pipe(Effect.orElseSucceed(() => undefined))) as
      | NonNullable<typeof exportData>
      | undefined
    if (!exportData) {
      process.stdout.write(`File not found: ${file}`)
      process.stdout.write(EOL)
      return
    }
  }

  if (!exportData) {
    process.stdout.write(`Failed to read session data`)
    process.stdout.write(EOL)
    return
  }

  yield* persistImportedSession(exportData, {
    projectID: ctx.project.id,
    directory: ctx.directory,
    worktree: ctx.worktree,
  }).pipe(
    Effect.mapError(
      (error) =>
        new CliError({
          message: `Failed to import attachment (${error.operation}): ${error.resource}`,
        }),
    ),
  )

  process.stdout.write(`Imported session: ${exportData.info.id}`)
  process.stdout.write(EOL)
})

export const persistImportedSession = Effect.fn("Cli.import.persist")(function* (
  exportData: ExportData,
  destination: ImportDestination,
) {
  const { db } = yield* Database.Service
  const content = yield* ContentStore.Service
  const sessionID = SessionSchema.ID.make(exportData.info.id)
  const decoded = exportData.messages.map((message) => ({
    info: decodeMessageInfo(message.info) as SessionV1.Info,
    parts: message.parts.map((part) => decodePart(part) as SessionV1.Part),
  }))
  const messages = yield* Effect.forEach(
    decoded,
    Effect.fnUntraced(function* (message) {
      const messageID = SessionMessage.ID.make(message.info.id)
      const info = decodeMessageInfo(
        yield* normalizeImportedValue(message.info, {
          content,
          sessionID,
          messageID,
          key: `message:${message.info.id}`,
          jsonPath: "$",
        }),
      ) as SessionV1.Info
      const parts = yield* Effect.forEach(
        message.parts,
        Effect.fnUntraced(function* (part) {
          return decodePart(
            yield* normalizeImportedValue(part, {
              content,
              sessionID,
              messageID,
              key: `part:${part.id}`,
              jsonPath: "$",
            }),
          ) as SessionV1.Part
        }),
        { concurrency: 1 },
      )
      return { info, parts }
    }),
    { concurrency: 1 },
  )
  const info = Schema.decodeUnknownSync(Session.Info)({
    ...exportData.info,
    projectID: destination.projectID,
    directory: destination.directory,
    path: path.relative(path.resolve(destination.worktree), destination.directory).replaceAll("\\", "/"),
  }) as Session.Info
  const row = Session.toRow(info)
  yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .insert(SessionTable)
          .values(row)
          .onConflictDoUpdate({
            target: SessionTable.id,
            set: { project_id: row.project_id, directory: row.directory, path: row.path },
          })
          .run()
        for (const message of messages) {
          const { id, sessionID: _, ...data } = message.info
          yield* tx
            .insert(MessageTable)
            .values({
              id,
              session_id: row.id,
              time_created: message.info.time?.created ?? Date.now(),
              data: data as never,
            })
            .onConflictDoNothing()
            .run()
          for (const part of message.parts) {
            const { id: partID, sessionID: _sessionID, messageID, ...partData } = part
            yield* tx
              .insert(PartTable)
              .values({
                id: partID,
                message_id: messageID,
                session_id: row.id,
                data: partData,
              })
              .onConflictDoNothing()
              .run()
          }
        }
      }),
    )
    .pipe(Effect.orDie)
  return row.id
})

type NormalizeInput = {
  readonly content: ContentStore.Interface
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
  readonly key: string
  readonly jsonPath: string
}

function normalizeImportedValue(value: unknown, input: NormalizeInput): Effect.Effect<unknown, ContentStore.Error> {
  if (Array.isArray(value))
    return Effect.forEach(
      value,
      (item, index) => normalizeImportedValue(item, { ...input, jsonPath: pointer(input.jsonPath, String(index)) }),
      { concurrency: 1 },
    )
  if (!isRecord(value)) return Effect.succeed(value)
  return Effect.gen(function* () {
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      const jsonPath = pointer(input.jsonPath, key)
      if ((key === "url" || key === "uri") && typeof child === "string" && isLocalAttachment(child)) {
        const normalized = yield* input.content.normalizeFiles({
          sessionID: input.sessionID,
          messageID: input.messageID,
          key: `import:${input.key}:${jsonPath}`,
          files: [
            new FileAttachment({
              uri: child,
              mime: attachmentMime(child, value),
              name: attachmentName(value),
            }),
          ],
        })
        output[key] = normalized[0]!.uri
        continue
      }
      output[key] = yield* normalizeImportedValue(child, { ...input, jsonPath })
    }
    return output
  })
}

function isLocalAttachment(value: string) {
  return value.startsWith("data:") || value.startsWith("file://")
}

function attachmentMime(uri: string, parent: Record<string, unknown>) {
  if (typeof parent.mime === "string") return parent.mime
  if (!uri.startsWith("data:")) return "application/octet-stream"
  const end = uri.indexOf(",")
  const header = end === -1 ? uri.slice(5) : uri.slice(5, end)
  return header.split(";", 1)[0] || "application/octet-stream"
}

function attachmentName(parent: Record<string, unknown>) {
  if (typeof parent.filename === "string") return parent.filename
  return typeof parent.name === "string" ? parent.name : undefined
}

function pointer(base: string, key: string) {
  return `${base}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
