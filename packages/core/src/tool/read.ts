export * as ReadTool from "./read"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { createHash } from "crypto"
import { open } from "node:fs/promises"
import { StringDecoder } from "string_decoder"
import { FileSystem } from "../filesystem"
import { Image } from "../image"
import { LocationMutation } from "../location-mutation"
import { ContentStore } from "../content-store"
import { Database } from "../database/database"
import { FileKnowledge } from "../file-knowledge"
import { ReadReceipt } from "./read-receipt"
import { PermissionV2 } from "../permission"
import { AbsolutePath, PositiveInt } from "../schema"
import { ReadToolFileSystem } from "./read-filesystem"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "read"
export const ARTIFACT_PAGE_BYTES = 32 * 1024
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const LocationInput = Schema.Struct({
  path: Schema.String.pipe(Schema.optional).annotate({
    description: "The canonical path to read",
  }),
  filePath: Schema.String.pipe(Schema.optional).annotate({
    description: "Legacy provider alias for path",
  }),
  offset: ReadToolFileSystem.PageInput.fields.offset.annotate({
    description: "The 1-based directory entry or text line offset to start reading from",
  }),
  limit: ReadToolFileSystem.PageInput.fields.limit.annotate({
    description: "The maximum number of directory entries or text lines to read",
  }),
  fullLines: ReadToolFileSystem.PageInput.fields.fullLines.annotate({
    description:
      "Text files only: return complete lines without the 2000-character cap, within a 50 KiB page. Use a small limit for long lines. An oversized single line fails without a read receipt.",
  }),
})
const Input = Schema.Struct({
  ...LocationInput.fields,
  offsetBytes: PositiveInt.pipe(Schema.optional).annotate({
    description:
      "Stored-tool-output artifacts only: byte offset to continue reading; mutually exclusive with line offset/limit",
  }),
})
export const Output = Schema.Union([FileSystem.Content, ReadToolFileSystem.TextPage, ReadToolFileSystem.ListPage])
export type Output = typeof Output.Type
type ModelOutput = typeof Output.Encoded

export const toModelOutput = (input: Pick<typeof Input.Type, "path" | "filePath">, output: ModelOutput) => {
  const resource = readPath(input)
  if ("encoding" in output) {
    if (output.encoding === "base64" && SUPPORTED_IMAGE_MIMES.has(output.mime))
      return [
        { type: "text" as const, text: `Image read successfully${output.sha256 ? `\nSHA-256: ${output.sha256}` : ""}` },
        { type: "file" as const, data: output.content, mime: output.mime, name: resource },
      ]
    if (output.encoding === "base64" && output.mime === "application/pdf")
      return [
        { type: "text" as const, text: `PDF read successfully${output.sha256 ? `\nSHA-256: ${output.sha256}` : ""}` },
        { type: "file" as const, data: output.content, mime: output.mime, name: resource },
      ]
    if (output.encoding === "utf8")
      return [{ type: "text" as const, text: formatTextFile(resource, output.content, output.sha256) }]
    return []
  }
  if ("entries" in output) return [{ type: "text" as const, text: formatDirectory(resource, output) }]
  return [{ type: "text" as const, text: formatTextPage(resource, output) }]
}

const readPath = (input: Pick<typeof Input.Type, "path" | "filePath">) => input.path ?? input.filePath ?? ""

const validateInput = (input: unknown) => {
  if (typeof input !== "object" || input === null) return
  if (!("path" in input) && !("filePath" in input)) return "path or filePath is required"
  if (
    "path" in input &&
    typeof input.path === "string" &&
    "filePath" in input &&
    typeof input.filePath === "string" &&
    input.path !== input.filePath
  )
    return "path and filePath must match when both are provided"
}

const lines = (content: string) => {
  if (content.length === 0) return []
  const trimmed = content.replace(/\r?\n$/, "")
  if (trimmed.length === 0) return [""]
  return trimmed.split(/\r?\n/)
}

const cappedLine = (line: string) =>
  line.length > ReadToolFileSystem.MAX_LINE_LENGTH
    ? line.slice(0, ReadToolFileSystem.MAX_LINE_LENGTH) + ReadToolFileSystem.MAX_LINE_SUFFIX
    : line

const numbered = (content: string, offset: number) =>
  lines(content)
    .slice(0, ReadToolFileSystem.MAX_READ_LINES)
    .map((line, index) => `${offset + index}: ${cappedLine(line)}`)
    .join("\n")

const formatTextFile = (resource: string, content: string, sha256?: string) => {
  const total = lines(content).length
  const shown = Math.min(total, ReadToolFileSystem.MAX_READ_LINES)
  const continuation =
    total > shown
      ? `(Showing lines 1-${shown} of ${total}. Use offset=${shown + 1} to continue.)`
      : `(End of file - total ${total} lines)`
  return [
    `<path>${resource}</path>`,
    `<type>file</type>`,
    ...(sha256 ? [`<sha256>${sha256}</sha256>`] : []),
    "<content>",
    numbered(content, 1),
    "",
    continuation,
    "</content>",
  ].join("\n")
}

const formatTextPage = (resource: string, output: Extract<ModelOutput, { type: "text-page" }>) => {
  const pageLines =
    output.lineCount === undefined ? lines(output.content) : output.lineCount === 0 ? [] : output.content.split(/\r?\n/)
  const count = pageLines.length
  const last = count === 0 ? output.offset - 1 : output.offset + count - 1
  const continuation = output.truncated
    ? `(Showing lines ${output.offset}-${last}. Use offset=${output.next ?? last + 1} to continue.)`
    : `(End of file - read through line ${last})`
  const fullLines = ReadToolFileSystem.rendersFullLines(output)
  return [
    `<path>${resource}</path>`,
    `<type>file</type>`,
    ...(output.sha256 ? [`<sha256>${output.sha256}</sha256>`] : []),
    "<content>",
    pageLines
      .slice(0, ReadToolFileSystem.MAX_READ_LINES)
      .map((line, index) => `${output.offset + index}: ${fullLines ? line : cappedLine(line)}`)
      .join("\n"),
    "",
    continuation,
    "</content>",
  ].join("\n")
}

const formatDirectory = (
  resource: string,
  output: Extract<ModelOutput, { entries: ReadonlyArray<{ path: string }> }>,
) => {
  const entries = output.entries.map((entry) => entry.path.replaceAll("\\", "/"))
  const continuation = output.truncated
    ? `(Showing ${entries.length} entries. Use 'offset' parameter to read beyond entry ${output.next ?? entries.length + 1})`
    : `(${entries.length} entries)`
  return [
    `<path>${resource}</path>`,
    `<type>directory</type>`,
    "<entries>",
    entries.join("\n"),
    continuation,
    "</entries>",
  ].join("\n")
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const reader = yield* ReadToolFileSystem.Service
    const mutation = yield* LocationMutation.Service
    const image = yield* Image.Service
    const permission = yield* PermissionV2.Service
    const contentStore = Option.getOrUndefined(yield* Effect.serviceOption(ContentStore.Service))
    const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
    const knowledge = database && FileKnowledge.make(database.db)

    const readArtifact = (
      resource: string,
      input: {
        readonly offset?: number
        readonly limit?: number
        readonly offsetBytes?: number
        readonly fullLines?: boolean
      },
      context: Tool.Context,
    ): Effect.Effect<Output, ToolFailure> =>
      Effect.gen(function* () {
        if (input.fullLines)
          return yield* new ToolFailure({
            message: "fullLines is supported only for filesystem text reads, not stored tool output",
          })
        if (!contentStore) return yield* new ToolFailure({ message: "Stored tool output retrieval is unavailable" })
        const located = yield* contentStore.locate({ uri: resource, sessionID: context.sessionID })
        if (!located) return yield* new ToolFailure({ message: "Stored tool output does not belong to this session" })
        yield* permission.assert({
          action: name,
          resources: [resource],
          save: ["*"],
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
        })
        if (input.offsetBytes !== undefined && (input.offset !== undefined || input.limit !== undefined))
          return yield* new ToolFailure({ message: "offsetBytes is mutually exclusive with line offset/limit" })
        return yield* Effect.tryPromise({
          try: async () => {
            const handle = await open(located.path, "r")
            try {
              const size = located.sizeBytes
              if (input.offsetBytes !== undefined) {
                const window = Buffer.alloc(3)
                let start = Math.min(input.offsetBytes, Math.max(0, size - 1))
                if (start > 0) {
                  await handle.read(window, 0, 3, start)
                  let continuation = 0
                  while (
                    continuation < 3 &&
                    (window[continuation] ?? 0) >= 0b10000000 &&
                    (window[continuation] ?? 0) < 0b11000000
                  )
                    continuation++
                  start += continuation
                }
                const length = Math.min(ARTIFACT_PAGE_BYTES, Math.max(0, size - start))
                const buffer = Buffer.alloc(length)
                const read = await handle.read(buffer, 0, length, start)
                const text = buffer.subarray(0, read.bytesRead).toString("utf-8")
                const complete = start + read.bytesRead >= size
                const trailer = complete
                  ? `\n[stored tool output bytes ${start + 1}-${start + read.bytesRead} of ${size}; end of artifact]`
                  : `\n[stored tool output bytes ${start + 1}-${start + read.bytesRead} of ${size}; continue with offsetBytes = ${start + read.bytesRead}]`
                return new ReadToolFileSystem.TextPage({
                  type: "text-page",
                  content: `${text}${trailer}`,
                  mime: "text/plain",
                  offset: 1,
                  truncated: !complete,
                })
              }
              const hash = createHash("sha256")
              const offsetLine = input.offset ?? 1
              const limitLines = input.limit ?? 2000
              const decoder = new StringDecoder("utf-8")
              const chunk = Buffer.alloc(64 * 1024)
              const collected: string[] = []
              let pending = ""
              let line = 1
              let bytes = 0
              let truncated = false
              let next: number | undefined
              let position = 0
              let done = false
              while (position < size) {
                const read = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position)
                if (read.bytesRead === 0) break
                hash.update(chunk.subarray(0, read.bytesRead))
                position += read.bytesRead
                pending += decoder.write(chunk.subarray(0, read.bytesRead))
                let newlineIndex = pending.indexOf("\n")
                while (newlineIndex !== -1) {
                  const current = pending.slice(0, newlineIndex).replace(/\r$/, "")
                  pending = pending.slice(newlineIndex + 1)
                  if (!done && line >= offsetLine) {
                    if (collected.length >= limitLines || bytes + current.length + 1 > ARTIFACT_PAGE_BYTES) {
                      truncated = true
                      next ??= line
                      done = true
                    } else {
                      collected.push(current)
                      bytes += current.length + 1
                    }
                  }
                  line++
                  newlineIndex = pending.indexOf("\n")
                }
              }
              pending += decoder.end()
              if (pending.length > 0 && !done && line >= offsetLine && collected.length < limitLines)
                collected.push(pending.replace(/\r$/, ""))
              else if (pending.length > 0 && !done) {
                truncated = true
                next ??= line
              }
              return new ReadToolFileSystem.TextPage({
                type: "text-page",
                content: collected.join("\n"),
                mime: "text/plain",
                offset: offsetLine,
                truncated,
                sha256: hash.digest("hex"),
                ...(next === undefined ? {} : { next }),
              })
            } finally {
              await handle.close()
            }
          },
          catch: (cause) => new ToolFailure({ message: cause instanceof Error ? cause.message : String(cause) }),
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.fail(
            error instanceof ToolFailure
              ? error
              : new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
          ),
        ),
      )

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Read a text file or supported image, page through a large UTF-8 text file by line offset, or list a directory page. Relative paths resolve from the current Location. External targets, including those reached via links, require external_directory approval.",
          input: Input,
          output: Output,
          validateInput,
          toModelOutput: ({ input, output }) => toModelOutput(input, output),
          execute: (input, context) => {
            const resource = readPath(input)
            if (resource.startsWith(ContentStore.URI_PREFIX)) return readArtifact(resource, input, context)
            return Effect.gen(function* () {
              const target = yield* mutation.resolve({ path: resource }, LocationMutation.guardedPaths)
              if (target.externalDirectory)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
              yield* permission.assert({
                action: name,
                resources: [target.resource],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const current = yield* mutation.resolve({ path: resource }, LocationMutation.guardedPaths)
              if (!LocationMutation.sameTarget(target, current))
                return yield* new ToolFailure({ message: "Read target changed while waiting; retry manually." })
              const absolute = AbsolutePath.make(target.canonical)
              const type = yield* reader.inspect(absolute)
              if (type === "directory" && input.fullLines)
                return yield* new ToolFailure({
                  message: "fullLines is supported only for text files, not directories",
                })
              if (type === "directory")
                return yield* reader.list(absolute, { offset: input.offset, limit: input.limit })
              const content = yield* reader.read(absolute, target.resource, {
                offset: input.offset,
                limit: input.limit,
                ...(input.fullLines === undefined ? {} : { fullLines: input.fullLines }),
              })
              if ("encoding" in content && content.encoding === "base64" && SUPPORTED_IMAGE_MIMES.has(content.mime)) {
                return yield* image.normalize(target.resource, { ...content, encoding: "base64" }).pipe(
                  Effect.map((normalized) => ({ ...normalized, sha256: content.sha256 })),
                  Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)),
                )
              }
              if ("encoding" in content && content.encoding === "base64" && content.mime === "application/pdf")
                return content
              if ("encoding" in content && content.encoding === "base64")
                return yield* Effect.fail(new ReadToolFileSystem.BinaryFileError(target.resource))
              const coverage = ReadReceipt.coverage(content)
              if (knowledge && coverage && content.sha256) {
                const output = toModelOutput(input, content)
                if (output.length === 1 && output[0]?.type === "text")
                  yield* knowledge.recordRead({
                    sessionID: context.sessionID,
                    assistantMessageID: context.assistantMessageID,
                    callID: context.toolCallID,
                    target: target.canonical,
                    sha256: content.sha256,
                    coverage,
                    output: output[0].text,
                  })
              }
              return content
            }).pipe(
              Effect.mapError((error) => {
                const message =
                  error instanceof FileKnowledge.StorageError ||
                  error instanceof ToolFailure ||
                  error instanceof ReadToolFileSystem.FullLineLimitError ||
                  error instanceof ReadToolFileSystem.BinaryFileError ||
                  error instanceof ReadToolFileSystem.MediaIngestLimitError ||
                  error instanceof Image.DecodeError ||
                  error instanceof Image.SizeError
                    ? error.message
                    : `Unable to read ${resource}`
                return new ToolFailure({ message })
              }),
            )
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)
