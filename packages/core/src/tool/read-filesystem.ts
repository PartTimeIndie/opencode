export * as ReadToolFileSystem from "./read-filesystem"

import { createHash } from "crypto"
import path from "path"
import { pathToFileURL } from "url"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { AbsolutePath, PositiveInt, RelativePath } from "../schema"

export const MAX_READ_LINES = 2_000
export const MAX_READ_BYTES = 50 * 1024
export const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024
export const MAX_LINE_LENGTH = 2_000
export const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`

export class BinaryFileError extends Error {
  constructor(readonly resource: string) {
    super(`Cannot read binary file: ${resource}`)
    this.name = "BinaryFileError"
  }
}

export class MediaIngestLimitError extends Error {
  constructor(
    readonly resource: string,
    readonly maximumBytes: number,
  ) {
    super(`Media exceeds ${maximumBytes} byte ingestion limit: ${resource}`)
    this.name = "MediaIngestLimitError"
  }
}

export class FullLineLimitError extends Error {
  constructor(resource: string, line: number) {
    super(
      `Line ${line} in ${resource} exceeds the ${MAX_READ_BYTES} byte full-line page limit; no complete line was returned`,
    )
    this.name = "FullLineLimitError"
  }
}

export type ReadError = FSUtil.Error | BinaryFileError | MediaIngestLimitError | Error

export const PageInput = Schema.Struct({
  offset: PositiveInt.pipe(Schema.optional),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_READ_LINES)).pipe(Schema.optional),
  fullLines: Schema.Boolean.pipe(Schema.optional),
})
export type PageInput = typeof PageInput.Type

export class TextPage extends Schema.Class<TextPage>("ReadTool.TextPage")({
  type: Schema.Literal("text-page"),
  content: Schema.String,
  mime: Schema.String,
  offset: PositiveInt,
  truncated: Schema.Boolean,
  next: PositiveInt.pipe(Schema.optional),
  sha256: Schema.String.pipe(Schema.optional),
  lineCount: Schema.Number.pipe(Schema.optional),
  totalLines: Schema.Number.pipe(Schema.optional),
  fullLines: Schema.Boolean.pipe(Schema.optional),
}) {}

/** Renderer and read receipts must agree before removing the per-line cap.
 * The reader sets this flag only on bounded, complete-line text pages. */
export const rendersFullLines = (page: TextPage) =>
  page.fullLines === true &&
  Buffer.byteLength(page.content, "utf8") <= MAX_READ_BYTES &&
  page.content.split(/\r?\n/).length <= MAX_READ_LINES

export class ListPage extends Schema.Class<ListPage>("ReadTool.ListPage")({
  entries: Schema.Array(FileSystem.Entry),
  truncated: Schema.Boolean,
  next: PositiveInt.pipe(Schema.optional),
}) {}

export interface Interface {
  readonly inspect: (path: AbsolutePath) => Effect.Effect<"file" | "directory", ReadError>
  readonly read: (
    path: AbsolutePath,
    resource: string,
    page?: PageInput,
  ) => Effect.Effect<FileSystem.Content | TextPage, ReadError>
  readonly list: (path: AbsolutePath, page?: PageInput) => Effect.Effect<ListPage, ReadError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ReadToolFileSystem") {}

const extensions = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".class",
  ".jar",
  ".war",
  ".7z",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".bin",
  ".dat",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".wasm",
  ".pyc",
  ".pyo",
])
const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)
const imageMime = (bytes: Uint8Array) => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]))
    return "image/webp"
}
const binary = (resource: string, bytes: Uint8Array) => {
  if (extensions.has(path.extname(resource).toLowerCase())) return true
  if (bytes.length === 0) return false
  let nonPrintable = 0
  for (const byte of bytes) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++
  }
  return nonPrintable / bytes.length > 0.3
}

/**
 * A fatal UTF-8 TextDecoder throws on legacy encodings (e.g. Windows-1252) that
 * pass the printable-byte pre-scan; report those as the established
 * BinaryFileError instead of leaking an opaque encoder defect.
 */
const decodeChunk = (decoder: TextDecoder, bytes: Uint8Array, resource: string) =>
  Effect.try({
    try: () => decoder.decode(bytes, { stream: true }),
    catch: () => new BinaryFileError(resource),
  })

const flushDecoder = (decoder: TextDecoder, resource: string) =>
  Effect.try({
    try: () => decoder.decode(),
    catch: () => new BinaryFileError(resource),
  })

export const inspect = Effect.fn("ReadTool.inspect")(function* (fs: FSUtil.Interface, input: string) {
  const info = yield* fs.stat(input)
  const type = info.type === "File" ? "file" : info.type === "Directory" ? "directory" : undefined
  if (!type) return yield* Effect.fail(new Error("Path is not a file or directory"))
  return type
})

export const read = Effect.fn("ReadTool.read")(function* (
  fs: FSUtil.Interface,
  input: string,
  resource: string,
  page: PageInput = {},
) {
  const real = yield* fs.realPath(input)
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(real, { flag: "r" }).pipe(Effect.orDie)
      const info = yield* file.stat.pipe(Effect.orDie)
      if (info.type !== "File") return yield* Effect.fail(new Error("Path is not a file"))
      const first = Option.getOrElse(
        yield* file.readAlloc(Math.min(64 * 1024, Number(info.size) || 4 * 1024)).pipe(Effect.orDie),
        () => new Uint8Array(),
      )
      const mime = imageMime(first)
      if (mime) {
        if (info.size > MAX_MEDIA_INGEST_BYTES)
          return yield* Effect.fail(new MediaIngestLimitError(resource, MAX_MEDIA_INGEST_BYTES))
        const chunks = [first]
        let total = first.length
        while (total <= MAX_MEDIA_INGEST_BYTES) {
          const chunk = yield* file
            .readAlloc(Math.min(64 * 1024, MAX_MEDIA_INGEST_BYTES + 1 - total))
            .pipe(Effect.orDie)
          if (Option.isNone(chunk)) break
          chunks.push(chunk.value)
          total += chunk.value.length
        }
        if (total > MAX_MEDIA_INGEST_BYTES)
          return yield* Effect.fail(new MediaIngestLimitError(resource, MAX_MEDIA_INGEST_BYTES))
        const bytes = Buffer.concat(
          chunks.map((chunk) => Buffer.from(chunk)),
          total,
        )
        return {
          uri: pathToFileURL(real).href,
          name: path.basename(real),
          content: bytes.toString("base64"),
          encoding: "base64" as const,
          mime,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }
      }
      if (startsWith(first, [0x25, 0x50, 0x44, 0x46])) {
        if (info.size > MAX_MEDIA_INGEST_BYTES)
          return yield* Effect.fail(new MediaIngestLimitError(resource, MAX_MEDIA_INGEST_BYTES))
        const chunks = [first]
        let total = first.length
        while (total <= MAX_MEDIA_INGEST_BYTES) {
          const chunk = yield* file
            .readAlloc(Math.min(64 * 1024, MAX_MEDIA_INGEST_BYTES + 1 - total))
            .pipe(Effect.orDie)
          if (Option.isNone(chunk)) break
          chunks.push(chunk.value)
          total += chunk.value.length
        }
        if (total > MAX_MEDIA_INGEST_BYTES)
          return yield* Effect.fail(new MediaIngestLimitError(resource, MAX_MEDIA_INGEST_BYTES))
        const bytes = Buffer.concat(
          chunks.map((chunk) => Buffer.from(chunk)),
          total,
        )
        return {
          uri: pathToFileURL(real).href,
          name: path.basename(real),
          content: bytes.toString("base64"),
          encoding: "base64" as const,
          mime: "application/pdf",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }
      }
      if (binary(resource, first)) return yield* Effect.fail(new BinaryFileError(resource))
      const paged =
        info.size > MAX_READ_BYTES || page.offset !== undefined || page.limit !== undefined || page.fullLines === true
      if (!paged) {
        const decoder = new TextDecoder("utf-8", { fatal: true })
        const hash = createHash("sha256").update(first)
        const text = [yield* decodeChunk(decoder, first, resource)]
        while (true) {
          const chunk = yield* file.readAlloc(64 * 1024).pipe(Effect.orDie)
          if (Option.isNone(chunk)) break
          if (chunk.value.includes(0)) return yield* Effect.die(new BinaryFileError(resource))
          hash.update(chunk.value)
          text.push(yield* decodeChunk(decoder, chunk.value, resource))
        }
        text.push(yield* flushDecoder(decoder, resource))
        return {
          uri: pathToFileURL(real).href,
          name: path.basename(real),
          content: text.join(""),
          encoding: "utf8" as const,
          mime: FSUtil.mimeType(real),
          sha256: hash.digest("hex"),
        }
      }
      const offset = page.offset ?? 1
      const limit = Math.min(page.limit ?? MAX_READ_LINES, MAX_READ_LINES)
      const maxLineLength = page.fullLines ? MAX_READ_BYTES + 1 : MAX_LINE_LENGTH
      const lines: string[] = []
      const hash = createHash("sha256").update(first)
      const decoder = new TextDecoder("utf-8", { fatal: true })
      let pending = ""
      let discard = false
      let line = 1
      let bytes = 0
      let found = false
      let truncated = false
      let next: number | undefined
      const append = (input: string) => {
        if (line < offset) {
          line++
          return
        }
        if (lines.length >= limit || bytes >= MAX_READ_BYTES) {
          truncated = true
          next ??= line++
          return
        }
        found = true
        const text =
          !page.fullLines && input.length > MAX_LINE_LENGTH ? input.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : input
        const size = Buffer.byteLength(text, "utf-8") + (lines.length > 0 ? 1 : 0)
        if (bytes + size > MAX_READ_BYTES) {
          if (page.fullLines && lines.length === 0) return new FullLineLimitError(resource, line)
          truncated = true
          next ??= line++
          return
        }
        lines.push(text)
        bytes += size
        line++
      }
      // Once the page budget is satisfied, later chunks only need null-byte and
      // UTF-8 validation plus the running hash. Skipping line splitting then
      // avoids per-line string work to EOF on large files; `next` and
      // `truncated` are already fixed at the first over-limit line.
      let saturated = false
      const consume = (chunk: Uint8Array) => {
        if (chunk.includes(0)) return new BinaryFileError(resource)
        let text: string
        try {
          text = decoder.decode(chunk, { stream: true })
        } catch {
          return new BinaryFileError(resource)
        }
        if (saturated) return
        let cursor = 0
        while (cursor < text.length) {
          const index = text.indexOf("\n", cursor)
          if (index === -1) {
            if (!discard) {
              pending += text.slice(cursor)
              if (pending.length > maxLineLength) {
                pending = pending.slice(0, maxLineLength + 1)
                discard = true
              }
            }
            return
          }
          const current = pending + (discard ? "" : text.slice(cursor, index))
          pending = ""
          discard = false
          cursor = index + 1
          const error = append(current.endsWith("\r") ? current.slice(0, -1) : current)
          if (error) return error
          if (truncated) {
            saturated = true
            return
          }
        }
      }
      const firstError = yield* Effect.sync(() => consume(first))
      if (firstError) return yield* Effect.fail(firstError)
      while (true) {
        const chunk = yield* file.readAlloc(64 * 1024).pipe(Effect.orDie)
        if (Option.isNone(chunk)) break
        hash.update(chunk.value)
        const chunkError = yield* Effect.sync(() => consume(chunk.value))
        if (chunkError) return yield* Effect.fail(chunkError)
      }
      const tail = yield* flushDecoder(decoder, resource)
      if (!discard) pending += tail
      if (pending) {
        const error = append(pending.endsWith("\r") ? pending.slice(0, -1) : pending)
        if (error) return yield* Effect.fail(error)
      }
      if (!found && offset !== 1) return yield* Effect.fail(new Error(`Offset ${offset} is out of range`))
      return new TextPage({
        type: "text-page",
        content: lines.join("\n"),
        mime: FSUtil.mimeType(real),
        offset,
        truncated,
        sha256: hash.digest("hex"),
        lineCount: lines.length,
        ...(page.fullLines ? { fullLines: true } : {}),
        ...(!truncated ? { totalLines: line - 1 } : {}),
        ...(next === undefined ? {} : { next }),
      })
    }),
  )
})

export const list = Effect.fn("ReadTool.list")(function* (fs: FSUtil.Interface, input: string, page: PageInput = {}) {
  const real = yield* fs.realPath(input)
  const items = yield* fs.readDirectoryEntries(real)
  const offset = page.offset ?? 1
  const limit = Math.min(page.limit ?? MAX_READ_LINES, MAX_READ_LINES)
  const entries = yield* Effect.forEach(
    items,
    (item) =>
      Effect.gen(function* () {
        const absolute = path.join(real, item.name)
        const target = yield* fs.realPath(absolute).pipe(Effect.catch(() => Effect.void))
        if (!target || !FSUtil.contains(real, target)) return
        const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.void))
        const type = info?.type === "Directory" ? "directory" : info?.type === "File" ? "file" : undefined
        if (!type) return
        return new FileSystem.Entry({
          path: RelativePath.make(item.name + (type === "directory" ? path.sep : "")),
          type,
          mime: type === "directory" ? "application/x-directory" : FSUtil.mimeType(target),
        })
      }),
    { concurrency: 16 },
  )
  const visible = entries
    .filter((item): item is FileSystem.Entry => item !== undefined)
    .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1))
  const selected = visible.slice(offset - 1, offset - 1 + limit)
  const truncated = offset - 1 + selected.length < visible.length
  return new ListPage({ entries: selected, truncated, ...(truncated ? { next: offset + selected.length } : {}) })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return Service.of({
      inspect: (path) => inspect(fs, path),
      read: (path, resource, page) => read(fs, path, resource, page),
      list: (path, page) => list(fs, path, page),
    })
  }),
)
