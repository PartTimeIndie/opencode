export * as ContentStore from "./content-store"

import { and, eq, sql } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { AttachmentTable, ContentBlobTable } from "./attachment.sql"
import { Database } from "./database/database"
import { LayerNode } from "./effect/layer-node"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { SessionMessage } from "./session/message"
import { SessionForkAttachmentID } from "./session/fork-attachment-id"
import { FileAttachment, Prompt, Source } from "./session/prompt"
import { SessionSchema } from "./session/schema"
import { isArchiveAttachment } from "./session/archive-attachment"

export const MANAGED_DIRECTORY = "content"
export const URI_PREFIX = "attachment://"
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
export const MAX_PROVIDER_ATTACHMENT_BYTES = 32 * 1024 * 1024
export const MAX_PROVIDER_TOTAL_BYTES = 64 * 1024 * 1024
export const MAX_INLINE_SOURCE_BYTES = 50 * 1024

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("ContentStore.StorageError", {
  operation: Schema.Literals(["decode", "read", "write", "database", "integrity", "limit"]),
  resource: Schema.String,
  cause: Schema.Defect,
}) {}

export type Error = StorageError

export interface Resolved {
  readonly id: string
  readonly sha256: string
  readonly mime: string
  readonly name?: string
  readonly bytes: Uint8Array
}

export interface Located extends Omit<Resolved, "bytes"> {
  readonly sessionID: string
  readonly path: string
  readonly sizeBytes: number
}

export interface BlobInfo {
  readonly sha256: string
  readonly mime: string
  readonly path: string
  readonly sizeBytes: number
}

export interface Interface {
  readonly putBlob: (input: { readonly bytes: Uint8Array; readonly mime: string }) => Effect.Effect<BlobInfo, Error>
  readonly locateBlob: (sha256: string) => Effect.Effect<BlobInfo | undefined, Error>
  readonly readBlob: (input: {
    readonly sha256: string
    readonly maxBytes?: number
  }) => Effect.Effect<Uint8Array | undefined, Error>
  readonly storeAttachment: (input: {
    readonly sessionID: SessionSchema.ID
    readonly messageID?: SessionMessage.ID
    readonly key: string
    readonly bytes: Uint8Array
    readonly mime: string
    readonly name?: string
  }) => Effect.Effect<FileAttachment, Error>
  readonly storeTextAttachment: (input: {
    readonly sessionID: SessionSchema.ID
    readonly messageID?: SessionMessage.ID
    readonly key: string
    readonly text: string
    readonly mime: string
    readonly name?: string
  }) => Effect.Effect<FileAttachment, Error>
  readonly normalizePrompt: (input: {
    readonly sessionID: SessionSchema.ID
    readonly messageID: SessionMessage.ID
    readonly prompt: Prompt
  }) => Effect.Effect<Prompt, Error>
  readonly normalizeFiles: (input: {
    readonly sessionID: SessionSchema.ID
    readonly messageID?: SessionMessage.ID
    readonly key: string
    readonly files: ReadonlyArray<FileAttachment>
  }) => Effect.Effect<ReadonlyArray<FileAttachment>, Error>
  readonly resolve: (input: {
    readonly uri: string
    readonly sessionID: string
    readonly maxBytes?: number
  }) => Effect.Effect<Resolved | undefined, Error>
  readonly locate: (input: {
    readonly uri: string
    readonly sessionID?: string
  }) => Effect.Effect<Located | undefined, Error>
  readonly materialize: (input: {
    readonly file: FileAttachment
    readonly sessionID: string
    readonly maxBytes?: number
  }) => Effect.Effect<FileAttachment, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ContentStore") {}

type BlobSource = {
  readonly bytes: Uint8Array
  readonly mime: string
  readonly sourcePath?: string
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const directory = path.join(global.data, MANAGED_DIRECTORY)
    const extractedArchives = new Map<string, string>()

    const source = Effect.fn("ContentStore.source")(function* (file: FileAttachment) {
      if (file.uri.startsWith(URI_PREFIX)) return undefined
      if (file.uri.startsWith("data:")) return yield* decodeDataURL(file.uri, file.mime)
      if (!file.uri.startsWith("file://")) return undefined
      const url = yield* Effect.try({
        try: () => new URL(file.uri),
        catch: (cause) => new StorageError({ operation: "decode", resource: file.uri, cause }),
      })
      url.search = ""
      url.hash = ""
      const sourcePath = yield* Effect.try({
        try: () => fileURLToPath(url),
        catch: (cause) => new StorageError({ operation: "decode", resource: file.uri, cause }),
      })
      if (!(yield* fs.isFile(sourcePath)))
        return yield* new StorageError({
          operation: "read",
          resource: sourcePath,
          cause: new Error("Attachment source is not a readable file"),
        })
      const info = yield* fs
        .stat(sourcePath)
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "read", resource: sourcePath, cause })))
      if (Number(info.size) > MAX_ATTACHMENT_BYTES)
        return yield* new StorageError({
          operation: "limit",
          resource: sourcePath,
          cause: new Error(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`),
        })
      const bytes = yield* fs
        .readFile(sourcePath)
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "read", resource: sourcePath, cause })))
      return { bytes, mime: file.mime, sourcePath } satisfies BlobSource
    })

    const verifyBlob = Effect.fn("ContentStore.verifyBlob")(function* (input: {
      readonly target: string
      readonly sha256: string
      readonly sizeBytes: number
      readonly hash: boolean
    }) {
      const info = yield* fs
        .stat(input.target)
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "integrity", resource: input.target, cause })))
      if (info.type !== "File" || Number(info.size) !== input.sizeBytes)
        return yield* new StorageError({
          operation: "integrity",
          resource: input.target,
          cause: new Error("Managed blob size does not match its metadata"),
        })
      if (!input.hash) return
      const sha256 = yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => open(input.target, "r"),
          catch: (cause) => new StorageError({ operation: "integrity", resource: input.target, cause }),
        }),
        (handle) =>
          Effect.tryPromise({
            try: async () => {
              const hash = createHash("sha256")
              const bytes = Buffer.allocUnsafe(1024 * 1024)
              let position = 0
              while (position < input.sizeBytes) {
                const read = await handle.read(bytes, 0, bytes.byteLength, position)
                if (read.bytesRead === 0) break
                hash.update(bytes.subarray(0, read.bytesRead))
                position += read.bytesRead
              }
              return hash.digest("hex")
            },
            catch: (cause) => new StorageError({ operation: "integrity", resource: input.target, cause }),
          }),
        (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
      )
      if (sha256 === input.sha256) return
      return yield* new StorageError({
        operation: "integrity",
        resource: input.target,
        cause: new Error("Managed blob hash does not match its content address"),
      })
    })

    const publishBlobOnce = Effect.fn("ContentStore.publishBlobOnce")(function* (input: {
      readonly target: string
      readonly sha256: string
      readonly bytes: Uint8Array
    }) {
      yield* fs
        .ensureDir(path.dirname(input.target))
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", resource: input.target, cause })))
      const temporary = `${input.target}.tmp-${crypto.randomUUID()}`
      yield* Effect.tryPromise({
        try: async () => {
          const handle = await open(temporary, "wx")
          try {
            await handle.writeFile(input.bytes)
            await handle.sync()
          } finally {
            await handle.close()
          }
        },
        catch: (cause) => new StorageError({ operation: "write", resource: temporary, cause }),
      })
      const renamed = yield* Effect.exit(fs.rename(temporary, input.target))
      if (Exit.isSuccess(renamed))
        return yield* verifyBlob({
          target: input.target,
          sha256: input.sha256,
          sizeBytes: input.bytes.byteLength,
          hash: false,
        })
      yield* fs.remove(temporary).pipe(Effect.ignore)
      if (!(yield* fs.existsSafe(input.target)))
        return yield* new StorageError({
          operation: "write",
          resource: input.target,
          cause: Cause.squash(renamed.cause),
        })
      return yield* verifyBlob({
        target: input.target,
        sha256: input.sha256,
        sizeBytes: input.bytes.byteLength,
        hash: true,
      })
    })

    const publishBlob = Effect.fn("ContentStore.publishBlob")(
      (input: { readonly target: string; readonly sha256: string; readonly bytes: Uint8Array }) =>
        publishBlobOnce(input).pipe(
          Effect.catchTag("ContentStore.StorageError", (error) => {
            if (error.operation !== "integrity") return error
            return fs.remove(input.target).pipe(Effect.ignore, Effect.andThen(publishBlobOnce(input)))
          }),
        ),
    )

    const publishStagedBlob = Effect.fn("ContentStore.publishStagedBlob")(function* (input: {
      readonly temporary: string
      readonly target: string
      readonly sha256: string
      readonly sizeBytes: number
    }) {
      yield* fs
        .ensureDir(path.dirname(input.target))
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", resource: input.target, cause })))
      const renamed = yield* Effect.exit(fs.rename(input.temporary, input.target))
      if (Exit.isSuccess(renamed))
        return yield* verifyBlob({
          target: input.target,
          sha256: input.sha256,
          sizeBytes: input.sizeBytes,
          hash: false,
        })
      if (!(yield* fs.existsSafe(input.target)))
        return yield* new StorageError({
          operation: "write",
          resource: input.target,
          cause: Cause.squash(renamed.cause),
        })
      const existing = yield* Effect.exit(
        verifyBlob({ target: input.target, sha256: input.sha256, sizeBytes: input.sizeBytes, hash: true }),
      )
      if (Exit.isSuccess(existing)) return
      yield* fs
        .remove(input.target)
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", resource: input.target, cause })))
      yield* fs
        .rename(input.temporary, input.target)
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", resource: input.target, cause })))
      yield* verifyBlob({
        target: input.target,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        hash: false,
      })
    })

    const putBlob: Interface["putBlob"] = Effect.fn("ContentStore.putBlob")(function* (input) {
      if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
        return yield* new StorageError({
          operation: "limit",
          resource: "blob",
          cause: new Error(`Blob exceeds ${MAX_ATTACHMENT_BYTES} bytes`),
        })
      const sha256 = createHash("sha256").update(input.bytes).digest("hex")
      const relative = path.join(MANAGED_DIRECTORY, sha256.slice(0, 2), sha256)
      const target = path.join(global.data, relative)
      yield* publishBlob({ target, sha256, bytes: input.bytes })
      yield* db
        .insert(ContentBlobTable)
        .values({
          sha256,
          size_bytes: input.bytes.byteLength,
          mime: input.mime,
          storage_path: relative,
          created_at: Date.now(),
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "database", resource: sha256, cause })))
      return { sha256, mime: input.mime, path: target, sizeBytes: input.bytes.byteLength }
    })

    const putTextBlob = Effect.fn("ContentStore.putTextBlob")(function* (input: {
      readonly text: string
      readonly mime: string
    }) {
      const staging = path.join(directory, ".staging")
      const temporary = path.join(staging, `text-${crypto.randomUUID()}`)
      yield* fs
        .ensureDir(staging)
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", resource: staging, cause })))
      const written = yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => open(temporary, "wx"),
          catch: (cause) => new StorageError({ operation: "write", resource: temporary, cause }),
        }),
        (handle) =>
          Effect.tryPromise({
            try: async () => {
              const hash = createHash("sha256")
              let position = 0
              let sizeBytes = 0
              while (position < input.text.length) {
                const requested = Math.min(input.text.length, position + 1024 * 1024)
                const end =
                  requested < input.text.length && isHighSurrogate(input.text.charCodeAt(requested - 1))
                    ? requested - 1
                    : requested
                const bytes = Buffer.from(input.text.slice(position, end), "utf8")
                let offset = 0
                while (offset < bytes.byteLength) {
                  const written = await handle.write(bytes, offset, bytes.byteLength - offset, null)
                  if (written.bytesWritten === 0) throw new Error("Managed text blob write made no progress")
                  offset += written.bytesWritten
                }
                hash.update(bytes)
                sizeBytes += bytes.byteLength
                position = end
              }
              await handle.sync()
              return { sha256: hash.digest("hex"), sizeBytes }
            },
            catch: (cause) => new StorageError({ operation: "write", resource: temporary, cause }),
          }),
        (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
      ).pipe(Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)))
      const relative = path.join(MANAGED_DIRECTORY, written.sha256.slice(0, 2), written.sha256)
      const target = path.join(global.data, relative)
      yield* publishStagedBlob({
        temporary,
        target,
        sha256: written.sha256,
        sizeBytes: written.sizeBytes,
      }).pipe(Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)))
      yield* db
        .insert(ContentBlobTable)
        .values({
          sha256: written.sha256,
          size_bytes: written.sizeBytes,
          mime: input.mime,
          storage_path: relative,
          created_at: Date.now(),
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "database", resource: written.sha256, cause })))
      return { sha256: written.sha256, mime: input.mime, path: target, sizeBytes: written.sizeBytes }
    })

    const linkAttachment = Effect.fn("ContentStore.linkAttachment")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly messageID?: SessionMessage.ID
      readonly key: string
      readonly ordinal: number
      readonly file: FileAttachment
      readonly sourcePath?: string
      readonly blob: BlobInfo
    }) {
      const attachmentID =
        "att_" +
        createHash("sha256")
          .update(`${input.sessionID}\0${input.key}\0${input.ordinal}\0${input.blob.sha256}`)
          .digest("hex")
          .slice(0, 32)
      yield* db
        .insert(AttachmentTable)
        .values({
          id: attachmentID,
          session_id: input.sessionID,
          message_id: input.messageID,
          mime: input.blob.mime,
          filename: input.file.name,
          size_bytes: input.blob.sizeBytes,
          source_path: input.sourcePath,
          storage_path: path.relative(global.data, input.blob.path),
          blob_sha256: input.blob.sha256,
          created_at: Date.now(),
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "database", resource: attachmentID, cause })))
      return FileAttachment.create({
        ...input.file,
        uri: URI_PREFIX + attachmentID,
        mime: input.blob.mime,
      })
    })

    const store = Effect.fn("ContentStore.store")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly messageID?: SessionMessage.ID
      readonly key: string
      readonly ordinal: number
      readonly file: FileAttachment
      readonly source: BlobSource
    }) {
      const blob = yield* putBlob({ bytes: input.source.bytes, mime: input.source.mime })
      return yield* linkAttachment({
        sessionID: input.sessionID,
        messageID: input.messageID,
        key: input.key,
        ordinal: input.ordinal,
        file: input.file,
        sourcePath: input.source.sourcePath,
        blob,
      })
    })

    const storeAttachment: Interface["storeAttachment"] = Effect.fn("ContentStore.storeAttachment")(function* (input) {
      return yield* store({
        sessionID: input.sessionID,
        messageID: input.messageID,
        key: input.key,
        ordinal: 0,
        file: new FileAttachment({ uri: "data:,", mime: input.mime, name: input.name }),
        source: { bytes: input.bytes, mime: input.mime },
      })
    })

    const storeTextAttachment: Interface["storeTextAttachment"] = Effect.fn("ContentStore.storeTextAttachment")(
      function* (input) {
        const blob = yield* putTextBlob({ text: input.text, mime: input.mime })
        return yield* linkAttachment({
          sessionID: input.sessionID,
          messageID: input.messageID,
          key: input.key,
          ordinal: 0,
          file: new FileAttachment({ uri: "data:,", mime: input.mime, name: input.name }),
          blob,
        })
      },
    )

    const normalizeFiles: Interface["normalizeFiles"] = Effect.fn("ContentStore.normalizeFiles")(function* (input) {
      return yield* Effect.forEach(
        input.files,
        Effect.fnUntraced(function* (file, ordinal) {
          if (file.uri.startsWith(URI_PREFIX)) {
            const managed = yield* locate({ uri: file.uri, sessionID: input.sessionID })
            if (managed) return limitSourcePreview(file)
            return yield* new StorageError({
              operation: "read",
              resource: file.uri,
              cause: new Error("Managed attachment does not belong to this session"),
            })
          }
          const decoded = yield* source(file)
          if (!decoded) return limitSourcePreview(file)
          return limitSourcePreview(
            yield* store({
              sessionID: input.sessionID,
              messageID: input.messageID,
              key: input.key,
              ordinal,
              file,
              source: decoded,
            }),
          )
        }),
        { concurrency: 4 },
      )
    })

    const normalizePrompt: Interface["normalizePrompt"] = Effect.fn("ContentStore.normalizePrompt")(function* (input) {
      if (!input.prompt.files?.length) return input.prompt
      const files = yield* Effect.forEach(
        input.prompt.files,
        Effect.fnUntraced(function* (file, ordinal) {
          if (file.uri.startsWith(URI_PREFIX)) {
            const managed = yield* locate({ uri: file.uri, sessionID: input.sessionID })
            if (managed) return limitSourcePreview(file)
            return yield* new StorageError({
              operation: "read",
              resource: file.uri,
              cause: new Error("Managed attachment does not belong to this session"),
            })
          }
          const decoded = yield* source(file)
          if (!decoded) return limitSourcePreview(file)
          return limitSourcePreview(
            yield* store({
              sessionID: input.sessionID,
              messageID: input.messageID,
              key: input.messageID,
              ordinal,
              file,
              source: decoded,
            }),
          )
        }),
        { concurrency: 4 },
      )
      return new Prompt({ ...input.prompt, files })
    })

    const locateBlob: Interface["locateBlob"] = Effect.fn("ContentStore.locateBlob")(function* (sha256) {
      if (!/^[0-9a-f]{64}$/.test(sha256))
        return yield* new StorageError({
          operation: "integrity",
          resource: sha256,
          cause: new Error("Managed blob has no valid content address"),
        })
      const blob = yield* db
        .select()
        .from(ContentBlobTable)
        .where(eq(ContentBlobTable.sha256, sha256))
        .get()
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "database", resource: sha256, cause })))
      if (!blob) return undefined
      const expected = path.join(MANAGED_DIRECTORY, blob.sha256.slice(0, 2), blob.sha256)
      if (path.isAbsolute(blob.storage_path) || path.normalize(blob.storage_path) !== expected)
        return yield* new StorageError({
          operation: "integrity",
          resource: sha256,
          cause: new Error("Managed attachment path does not match its content address"),
        })
      const target = path.resolve(global.data, blob.storage_path)
      if (!FSUtil.contains(path.resolve(global.data), target))
        return yield* new StorageError({
          operation: "integrity",
          resource: sha256,
          cause: new Error("Managed attachment path escapes the content root"),
        })
      yield* verifyBlob({ target, sha256: blob.sha256, sizeBytes: blob.size_bytes, hash: false })
      return { sha256: blob.sha256, mime: blob.mime, path: target, sizeBytes: blob.size_bytes }
    })

    const readBlob: Interface["readBlob"] = Effect.fn("ContentStore.readBlob")(function* (input) {
      const blob = yield* locateBlob(input.sha256)
      if (!blob) return undefined
      if (input.maxBytes !== undefined && blob.sizeBytes > input.maxBytes)
        return yield* new StorageError({
          operation: "limit",
          resource: input.sha256,
          cause: new Error(`Blob exceeds the ${input.maxBytes} byte read budget`),
        })
      return yield* fs
        .readFile(blob.path)
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "read", resource: blob.path, cause })))
    })

    // Forked history references the parent's attachment URIs verbatim. The only
    // owned path back to those bytes is this session's own deterministic fork
    // row; the scan is bounded to fork-namespaced rows of the requesting session.
    const locateForkAlias = (uri: string, sessionID: string) =>
      db
        .select()
        .from(AttachmentTable)
        .where(
          and(
            eq(AttachmentTable.session_id, sessionID),
            sql`substr(${AttachmentTable.id}, 1, ${SessionForkAttachmentID.AttachmentPrefix.length}) = ${SessionForkAttachmentID.AttachmentPrefix}`,
          ),
        )
        .all()
        .pipe(
          Effect.mapError((cause) => new StorageError({ operation: "database", resource: uri, cause })),
          Effect.map((rows) =>
            rows.find(
              (row) =>
                typeof row.blob_sha256 === "string" &&
                row.blob_sha256.length > 0 &&
                SessionForkAttachmentID.derive({ sessionID, uri, blobSha256: row.blob_sha256 }) === row.id,
            ),
          ),
        )

    const locate: Interface["locate"] = Effect.fn("ContentStore.locate")(function* (input) {
      if (!input.uri.startsWith(URI_PREFIX)) return undefined
      const id = input.uri.slice(URI_PREFIX.length)
      const attachment = yield* db
        .select()
        .from(AttachmentTable)
        .where(eq(AttachmentTable.id, id))
        .get()
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "database", resource: id, cause })))
      const owned =
        attachment && (input.sessionID === undefined || attachment.session_id === input.sessionID)
          ? attachment
          : // A forked child retains the parent's serialized attachment references
            // so the provider sees a byte-identical cacheable prefix. Resolve such
            // a reference only through this session's own deterministic fork row;
            // a reference with no owned fork copy stays unresolved, never foreign.
            input.sessionID !== undefined && !id.startsWith(SessionForkAttachmentID.AttachmentPrefix)
            ? yield* locateForkAlias(input.uri, input.sessionID)
            : undefined
      if (!owned) return undefined
      if (!owned.blob_sha256)
        return yield* new StorageError({
          operation: "integrity",
          resource: owned.id,
          cause: new Error("Managed attachment has no blob content address"),
        })
      const blob = yield* locateBlob(owned.blob_sha256)
      if (!blob)
        return yield* new StorageError({
          operation: "integrity",
          resource: owned.id,
          cause: new Error("Managed attachment blob metadata is missing"),
        })
      return {
        id: owned.id,
        sessionID: owned.session_id,
        sha256: blob.sha256,
        mime: owned.mime,
        name: owned.filename ?? undefined,
        path: blob.path,
        sizeBytes: blob.sizeBytes,
      }
    })

    const resolve: Interface["resolve"] = Effect.fn("ContentStore.resolve")(function* (input) {
      const attachment = yield* locate({ uri: input.uri, sessionID: input.sessionID })
      if (!attachment) return undefined
      if (input.maxBytes !== undefined && attachment.sizeBytes > input.maxBytes)
        return yield* new StorageError({
          operation: "limit",
          resource: input.uri,
          cause: new Error(`Attachment exceeds the ${input.maxBytes} byte materialization budget`),
        })
      const bytes = yield* fs
        .readFile(attachment.path)
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "read", resource: attachment.path, cause })))
      return {
        id: attachment.id,
        sha256: attachment.sha256 || createHash("sha256").update(bytes).digest("hex"),
        mime: attachment.mime,
        name: attachment.name,
        bytes,
      }
    })

    const materialize: Interface["materialize"] = Effect.fn("ContentStore.materialize")(function* (input) {
      const content = yield* resolve({ uri: input.file.uri, sessionID: input.sessionID, maxBytes: input.maxBytes })
      if (!content && !input.file.uri.startsWith(URI_PREFIX)) return input.file
      if (!content)
        return yield* new StorageError({
          operation: "read",
          resource: input.file.uri,
          cause: new Error("Managed attachment does not belong to this session"),
        })
      if (input.file.unpack && isArchiveAttachment(input.file)) {
        const key = `${input.sessionID}:${content.id}`
        const cached = extractedArchives.get(key)
        const text =
          cached ??
          (yield* Effect.tryPromise({
            try: async (signal) => {
              const { extractArchiveAttachment } = await import("./session/archive-attachment")
              return (
                await extractArchiveAttachment({
                  bytes: content.bytes,
                  root: path.join(global.data, "attachment-extractions", encodeURIComponent(input.sessionID)),
                  name: input.file.name ?? content.name ?? "archive",
                  signal,
                })
              ).text
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.catch((cause) =>
              Effect.succeed(
                `Archive ${JSON.stringify(input.file.name ?? "archive")} could not be unpacked: ${cause instanceof Error ? cause.message : String(cause)}. Original attachment retained. No archive contents have been supplied to the model.`,
              ),
            ),
          ))
        if (extractedArchives.size >= 128) extractedArchives.delete(extractedArchives.keys().next().value!)
        extractedArchives.set(key, text)
        return FileAttachment.create({
          uri: `data:text/plain;base64,${Buffer.from(text).toString("base64")}`,
          mime: "text/plain",
          name: input.file.name ?? content.name,
        })
      }
      return FileAttachment.create({
        ...input.file,
        uri: `data:${content.mime};base64,${Buffer.from(content.bytes).toString("base64")}`,
        mime: content.mime,
        name: input.file.name ?? content.name,
      })
    })

    return Service.of({
      putBlob,
      locateBlob,
      readBlob,
      storeAttachment,
      storeTextAttachment,
      normalizePrompt,
      normalizeFiles,
      locate,
      resolve,
      materialize,
    })
  }),
)

function decodeDataURL(uri: string, fallbackMime: string) {
  const match = /^data:([^,]*),(.*)$/s.exec(uri)
  if (!match)
    return Effect.fail(
      new StorageError({ operation: "decode", resource: "data-url", cause: new Error("Invalid data URL") }),
    )
  const header = match[1] ?? ""
  const mime = header.split(";")[0] || fallbackMime
  const encoded = match[2] ?? ""
  const base64 = header.split(";").some((part) => part.toLowerCase() === "base64")
  const normalized = base64 ? encoded.replaceAll(/\s/g, "").replace(/=+$/, "") : encoded
  if (base64 && (!/^[A-Za-z0-9+/]*$/.test(normalized) || normalized.length % 4 === 1))
    return Effect.fail(
      new StorageError({ operation: "decode", resource: "data-url", cause: new Error("Invalid base64 data URL") }),
    )
  const padded = base64 ? normalized + "=".repeat((4 - (normalized.length % 4)) % 4) : normalized
  const estimated = base64
    ? Math.floor((padded.length * 3) / 4) - (padded.endsWith("==") ? 2 : padded.endsWith("=") ? 1 : 0)
    : Buffer.byteLength(encoded, "utf8")
  if (estimated > MAX_ATTACHMENT_BYTES)
    return Effect.fail(
      new StorageError({
        operation: "limit",
        resource: "data-url",
        cause: new Error(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`),
      }),
    )
  return Effect.try({
    try: () => {
      const bytes = base64 ? Buffer.from(padded, "base64") : Buffer.from(decodeURIComponent(encoded), "utf8")
      if (base64 && bytes.toString("base64").replace(/=+$/, "") !== normalized)
        throw new Error("Invalid base64 data URL")
      return { bytes, mime }
    },
    catch: (cause) => new StorageError({ operation: "decode", resource: "data-url", cause }),
  })
}

function limitSourcePreview(file: FileAttachment) {
  if (!file.source || Buffer.byteLength(file.source.text, "utf8") <= MAX_INLINE_SOURCE_BYTES) return file
  const bytes = Buffer.from(file.source.text, "utf8").subarray(0, MAX_INLINE_SOURCE_BYTES)
  const text = bytes.toString("utf8").replace(/\uFFFD$/, "")
  return FileAttachment.create({
    ...file,
    source: new Source({ start: file.source.start, end: file.source.end, text }),
  })
}

function isHighSurrogate(value: number) {
  return value >= 0xd800 && value <= 0xdbff
}

export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.defaultLayer),
)

export const node = LayerNode.make(layer, [Database.node, FSUtil.node, Global.node])
