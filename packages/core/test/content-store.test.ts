import { describe, expect } from "bun:test"
import { count } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { AttachmentTable, ContentBlobTable } from "@opencode-ai/core/attachment.sql"
import { ContentStore } from "@opencode-ai/core/content-store"
import { MAX_PERSISTED_CONTENT_PREVIEW_BYTES } from "@opencode-ai/core/content-preview"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment, Prompt, Source } from "@opencode-ai/core/session/prompt"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"
import { execFile } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { promisify } from "node:util"

const sessionID = SessionV2.ID.make("ses_content_store")
const it = testEffect(Layer.empty)

const withStore = <A, E, R>(
  body: (input: {
    root: string
    store: ContentStore.Interface
    outputs: ToolOutputStore.Interface
    db: Database.Interface["db"]
    fs: FSUtil.Interface
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const database = Database.layerFromPath(path.join(tmp.path, "content.db")).pipe(Layer.fresh)
      const global = Global.layerWith({ data: tmp.path })
      const content = ContentStore.layer.pipe(
        Layer.provide(database),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(global),
      )
      const outputs = ToolOutputStore.layer.pipe(
        Layer.provide(content),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(global),
      )
      return Effect.gen(function* () {
        return yield* body({
          root: tmp.path,
          store: yield* ContentStore.Service,
          outputs: yield* ToolOutputStore.Service,
          db: (yield* Database.Service).db,
          fs: yield* FSUtil.Service,
        })
      }).pipe(Effect.provide(Layer.mergeAll(database, content, outputs, FSUtil.defaultLayer)))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("ContentStore", () => {
  it.live("unpacks an archive only with explicit per-attachment consent and preserves ownership", () =>
    withStore(({ store, root }) =>
      Effect.gen(function* () {
        const bytes = yield* Effect.promise(async () => {
          await writeFile(path.join(root, "save.json"), '{"cards":[]}')
          const archive = path.join(root, "save.tar")
          await promisify(execFile)("tar", ["--format", "ustar", "-cf", archive, "-C", root, "save.json"], {
            windowsHide: true,
          })
          return await readFile(archive)
        })
        const original = FileAttachment.create({
          uri: `data:application/x-compressed;base64,${bytes.toString("base64")}`,
          mime: "application/x-compressed",
          name: "save.7z",
          unpack: true,
        })
        const prompt = yield* store.normalizePrompt({
          sessionID,
          messageID: SessionMessage.ID.make("msg_unpack"),
          prompt: new Prompt({ text: "Read the savegame", files: [original] }),
        })
        const file = prompt.files![0]!
        expect(file.unpack).toBe(true)
        const plain = yield* store.materialize({ sessionID, file: FileAttachment.create({ ...file, unpack: false }) })
        expect(plain.mime).toBe("application/x-compressed")
        const unpacked = yield* store.materialize({ sessionID, file })
        expect(unpacked.mime).toBe("text/plain")
        const manifest = Buffer.from(unpacked.uri.split(",")[1]!, "base64").toString("utf8")
        expect(manifest).toContain('"save.json"')
        expect(manifest).toContain("unpacked locally at the user's request")
        expect((yield* store.materialize({ sessionID, file })).uri).toBe(unpacked.uri)
        expect((yield* store.resolve({ sessionID, uri: file.uri }))?.bytes).toEqual(new Uint8Array(bytes))
        expect(Exit.isFailure(yield* Effect.exit(store.materialize({ sessionID: "ses_other", file })))).toBe(true)
      }),
    ),
  )

  it.live("deduplicates inline media and materializes it on demand", () =>
    withStore(({ store, db }) =>
      Effect.gen(function* () {
        const source = new FileAttachment({
          uri: "data:image/png;base64,aGVsbG8=",
          mime: "image/png",
          name: "pixel.png",
        })
        const first = yield* store.normalizePrompt({
          sessionID,
          messageID: SessionMessage.ID.make("msg_content_first"),
          prompt: new Prompt({ text: "first", files: [source] }),
        })
        const second = yield* store.normalizePrompt({
          sessionID,
          messageID: SessionMessage.ID.make("msg_content_second"),
          prompt: new Prompt({ text: "second", files: [source] }),
        })

        expect(first.files?.[0]?.uri).toStartWith(ContentStore.URI_PREFIX)
        expect(second.files?.[0]?.uri).toStartWith(ContentStore.URI_PREFIX)
        expect(first.files?.[0]?.uri).not.toBe(second.files?.[0]?.uri)
        expect((yield* db.select({ value: count() }).from(ContentBlobTable).get())?.value).toBe(1)
        expect((yield* db.select({ value: count() }).from(AttachmentTable).get())?.value).toBe(2)

        const materialized = yield* store.materialize({ file: first.files![0]!, sessionID })
        expect(materialized.uri).toBe("data:image/png;base64,aGVsbG8=")

        const crossSession = yield* Effect.exit(
          store.materialize({ file: first.files![0]!, sessionID: SessionV2.ID.make("ses_other") }),
        )
        expect(Exit.isFailure(crossSession)).toBe(true)
      }),
    ),
  )

  it.live("repairs a corrupt existing blob before linking a retry", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const first = yield* store.normalizePrompt({
          sessionID,
          messageID: SessionMessage.ID.make("msg_content_repair_first"),
          prompt: new Prompt({
            text: "first",
            files: [new FileAttachment({ uri: "data:text/plain;base64,aGVsbG8=", mime: "text/plain" })],
          }),
        })
        const located = yield* store.locate({ uri: first.files![0]!.uri, sessionID })
        if (!located) throw new Error("expected stored blob")
        yield* fs.writeFile(located.path, Buffer.from("jello"))

        const second = yield* store.normalizePrompt({
          sessionID,
          messageID: SessionMessage.ID.make("msg_content_repair_second"),
          prompt: new Prompt({
            text: "second",
            files: [new FileAttachment({ uri: "data:text/plain;base64,aGVsbG8=", mime: "text/plain" })],
          }),
        })
        const repaired = yield* store.resolve({ uri: second.files![0]!.uri, sessionID })
        expect(Buffer.from(repaired!.bytes).toString("utf8")).toBe("hello")
      }),
    ),
  )

  it.live("recovers idempotently after crashes at every blob and attachment publish boundary", () =>
    withStore(({ root, store, db, fs }) =>
      Effect.gen(function* () {
        const crashStates = ["blob-published", "blob-metadata", "attachment-linked"] as const
        yield* Effect.forEach(
          crashStates,
          Effect.fnUntraced(function* (state, ordinal) {
            const bytes = Buffer.from(`crash-boundary-${state}`)
            const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
            const relative = path.join(ContentStore.MANAGED_DIRECTORY, sha256.slice(0, 2), sha256)
            const target = path.join(root, relative)
            const messageID = SessionMessage.ID.make(`msg_content_crash_${ordinal}`)
            yield* fs.ensureDir(path.dirname(target))
            yield* fs.writeFile(target, bytes)
            if (state !== "blob-published")
              yield* db
                .insert(ContentBlobTable)
                .values({
                  sha256,
                  size_bytes: bytes.byteLength,
                  mime: "text/plain",
                  storage_path: relative,
                  created_at: Date.now(),
                })
                .run()
                .pipe(Effect.orDie)
            if (state === "attachment-linked")
              yield* db
                .insert(AttachmentTable)
                .values({
                  id:
                    "att_" +
                    new Bun.CryptoHasher("sha256")
                      .update([sessionID, messageID, "0", sha256].join("\0"))
                      .digest("hex")
                      .slice(0, 32),
                  session_id: sessionID,
                  message_id: messageID,
                  mime: "text/plain",
                  size_bytes: bytes.byteLength,
                  storage_path: relative,
                  blob_sha256: sha256,
                  created_at: Date.now(),
                })
                .run()
                .pipe(Effect.orDie)

            const normalized = yield* store.normalizePrompt({
              sessionID,
              messageID,
              prompt: new Prompt({
                text: state,
                files: [
                  new FileAttachment({
                    uri: `data:text/plain;base64,${bytes.toString("base64")}`,
                    mime: "text/plain",
                  }),
                ],
              }),
            })
            const resolved = yield* store.resolve({ uri: normalized.files![0]!.uri, sessionID })
            expect(Buffer.from(resolved!.bytes).toString("utf8")).toBe(bytes.toString("utf8"))
          }),
          { discard: true },
        )

        expect((yield* db.select({ value: count() }).from(ContentBlobTable).get())?.value).toBe(3)
        expect((yield* db.select({ value: count() }).from(AttachmentTable).get())?.value).toBe(3)
      }),
    ),
  )

  it.live("rejects malformed base64 and bounds persisted text selection previews", () =>
    withStore(({ store, db }) =>
      Effect.gen(function* () {
        const malformed = yield* store
          .normalizePrompt({
            sessionID,
            messageID: SessionMessage.ID.make("msg_content_invalid"),
            prompt: new Prompt({
              text: "invalid",
              files: [new FileAttachment({ uri: "data:image/png;base64,%%%%", mime: "image/png" })],
            }),
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(malformed)).toBe(true)
        expect((yield* db.select({ value: count() }).from(ContentBlobTable).get())?.value).toBe(0)

        const normalized = yield* store.normalizePrompt({
          sessionID,
          messageID: SessionMessage.ID.make("msg_content_preview"),
          prompt: new Prompt({
            text: "preview",
            files: [
              new FileAttachment({
                uri: "data:text/plain;base64,aGVsbG8=",
                mime: "text/plain",
                source: new Source({ start: 0, end: 100_000, text: "ä".repeat(100_000) }),
              }),
            ],
          }),
        })
        expect(Buffer.byteLength(normalized.files![0]!.source!.text, "utf8")).toBeLessThanOrEqual(
          ContentStore.MAX_INLINE_SOURCE_BYTES,
        )
        expect(normalized.files![0]!.source).toMatchObject({ start: 0, end: 100_000 })
      }),
    ),
  )

  it.live("keeps a copied local attachment after its source disappears", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const source = path.join(root, "source.txt")
        yield* fs.writeFileString(source, "durable text")
        const normalized = yield* store.normalizePrompt({
          sessionID,
          messageID: SessionMessage.ID.make("msg_content_file"),
          prompt: new Prompt({
            text: "file",
            files: [new FileAttachment({ uri: pathToFileURL(source).href, mime: "text/plain", name: "source.txt" })],
          }),
        })
        yield* fs.remove(source)

        const materialized = yield* store.materialize({ file: normalized.files![0]!, sessionID })
        expect(Buffer.from(materialized.uri.split(",")[1]!, "base64").toString("utf8")).toBe("durable text")
      }),
    ),
  )

  it.live("externalizes tool media and oversized structured output", () =>
    withStore(({ store, outputs }) =>
      Effect.gen(function* () {
        const bounded = yield* outputs.bound({
          sessionID,
          assistantMessageID: SessionMessage.ID.make("msg_content_tool"),
          toolCallID: "call-content",
          output: {
            structured: { report: "x".repeat(ToolOutputStore.MAX_STRUCTURED_BYTES) },
            content: [
              { type: "text", text: "bounded preview" },
              { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "pixel.png" },
            ],
          },
        })

        expect(bounded.output.content[1]?.type).toBe("file")
        if (bounded.output.content[1]?.type !== "file") throw new Error("expected normalized media")
        expect(bounded.output.content[1].uri).toStartWith(ContentStore.URI_PREFIX)
        const metadata = bounded.output.structured as { $opencode?: { uri?: string; preview?: string } }
        expect(metadata.$opencode?.uri).toStartWith(ContentStore.URI_PREFIX)
        expect(metadata.$opencode?.preview).toContain('"report"')
        expect(Buffer.byteLength(metadata.$opencode?.preview ?? "", "utf8")).toBeLessThanOrEqual(
          MAX_PERSISTED_CONTENT_PREVIEW_BYTES,
        )
        const resolved = yield* store.resolve({ uri: metadata.$opencode!.uri!, sessionID })
        expect(Buffer.from(resolved!.bytes).toString("utf8")).toContain('"report"')
        const materialized = yield* outputs.materialize({ sessionID, output: bounded.output })
        const provider = materialized.structured as { $opencode?: { preview?: string } }
        expect(Buffer.byteLength(provider.$opencode?.preview ?? "", "utf8")).toBeLessThanOrEqual(
          ToolOutputStore.MAX_PROVIDER_PREVIEW_BYTES,
        )
        expect(provider.$opencode?.preview).not.toContain(
          `"report":"${"x".repeat(ToolOutputStore.MAX_STRUCTURED_BYTES)}`,
        )
      }),
    ),
  )

  it.live("keeps structured output inline at the threshold and externalizes the next byte", () =>
    withStore(({ store, outputs, db }) =>
      Effect.gen(function* () {
        const overhead = Buffer.byteLength(JSON.stringify({ report: "" }), "utf8")
        const inline = { report: "x".repeat(ToolOutputStore.MAX_STRUCTURED_BYTES - overhead) }
        const external = { report: `${inline.report}x` }
        const inlineResult = yield* outputs.bound({
          sessionID,
          assistantMessageID: SessionMessage.ID.make("msg_content_structured_limit"),
          toolCallID: "call-content-structured-limit",
          output: { structured: inline, content: [{ type: "text", text: "summary" }] },
        })
        const externalResult = yield* outputs.bound({
          sessionID,
          assistantMessageID: SessionMessage.ID.make("msg_content_structured_over_limit"),
          toolCallID: "call-content-structured-over-limit",
          output: { structured: external, content: [{ type: "text", text: "summary" }] },
        })

        expect(Buffer.byteLength(JSON.stringify(inline), "utf8")).toBe(ToolOutputStore.MAX_STRUCTURED_BYTES)
        expect(inlineResult.output.structured).toEqual(inline)
        const metadata = externalResult.output.structured as { $opencode?: { uri?: string; sizeBytes?: number } }
        expect(metadata.$opencode?.uri).toStartWith(ContentStore.URI_PREFIX)
        expect(metadata.$opencode?.sizeBytes).toBe(ToolOutputStore.MAX_STRUCTURED_BYTES + 1)
        const resolved = yield* store.resolve({ uri: metadata.$opencode!.uri!, sessionID })
        expect(Buffer.from(resolved!.bytes).toString("utf8")).toBe(JSON.stringify(external))
        expect((yield* db.select({ value: count() }).from(ContentBlobTable).get())?.value).toBe(1)
        expect((yield* db.select({ value: count() }).from(AttachmentTable).get())?.value).toBe(1)
      }),
    ),
  )

  it.live("externalizes oversized tool text with only a bounded provider preview", () =>
    withStore(({ store, outputs }) =>
      Effect.gen(function* () {
        const text = `head-${"x".repeat(ToolOutputStore.MAX_BYTES)}-tail`
        const bounded = yield* outputs.bound({
          sessionID,
          assistantMessageID: SessionMessage.ID.make("msg_content_tool_text"),
          toolCallID: "call-content-text",
          output: { structured: { kind: "report", output: text }, content: [{ type: "text", text }] },
        })

        expect(bounded.outputPaths).toHaveLength(1)
        expect(bounded.output.content).toHaveLength(1)
        if (bounded.output.content[0]?.type !== "text") throw new Error("expected bounded text preview")
        expect(Buffer.byteLength(bounded.output.content[0].text, "utf8")).toBeLessThanOrEqual(
          MAX_PERSISTED_CONTENT_PREVIEW_BYTES,
        )
        const structured = bounded.output.structured as { output: string; $opencode?: { text?: { uri?: string } } }
        expect(Buffer.byteLength(structured.output, "utf8")).toBeLessThanOrEqual(MAX_PERSISTED_CONTENT_PREVIEW_BYTES)
        const metadata = bounded.output.structured as { $opencode?: { text?: { uri?: string } } }
        expect(metadata.$opencode?.text?.uri).toStartWith(ContentStore.URI_PREFIX)
        const resolved = yield* store.resolve({ uri: metadata.$opencode!.text!.uri!, sessionID })
        expect(Buffer.from(resolved!.bytes).toString("utf8")).toBe(text)
        const materialized = yield* outputs.materialize({ sessionID, output: bounded.output })
        expect(materialized.content[0]?.type).toBe("text")
        if (materialized.content[0]?.type !== "text") throw new Error("expected provider text preview")
        expect(Buffer.byteLength(materialized.content[0].text, "utf8")).toBeLessThanOrEqual(
          ToolOutputStore.MAX_PROVIDER_PREVIEW_BYTES,
        )
        expect(materialized.content[0].text).not.toBe(text)
        expect(materialized.content[0].text).toContain("head-")
        expect(materialized.content[0].text).toContain("-tail")
      }),
    ),
  )

  it.live(
    "streams tool text beyond the generic attachment limit into the shared store",
    () =>
      withStore(({ root, store, outputs, db }) =>
        Effect.gen(function* () {
          const text = `head-${"x".repeat(ContentStore.MAX_ATTACHMENT_BYTES)}-tail`
          const bounded = yield* outputs.bound({
            sessionID,
            assistantMessageID: SessionMessage.ID.make("msg_content_very_large_tool_text"),
            toolCallID: "call-content-very-large-text",
            output: { structured: { kind: "report", output: text }, content: [{ type: "text", text }] },
          })
          const metadata = bounded.output.structured as {
            $opencode?: { text?: { uri?: string; sizeBytes?: number } }
          }
          const uri = metadata.$opencode?.text?.uri
          if (!uri) throw new Error("expected managed text reference")

          expect(uri).toStartWith(ContentStore.URI_PREFIX)
          expect(bounded.outputPaths).toEqual([uri])
          expect(JSON.stringify(bounded.outputPaths)).not.toContain(root)
          expect(metadata.$opencode?.text?.sizeBytes).toBe(Buffer.byteLength(text, "utf8"))
          expect((yield* db.select({ value: count() }).from(ContentBlobTable).get())?.value).toBe(1)
          expect((yield* db.select({ value: count() }).from(AttachmentTable).get())?.value).toBe(1)

          const resolved = yield* store.resolve({ uri, sessionID })
          expect(resolved?.bytes.byteLength).toBe(Buffer.byteLength(text, "utf8"))
          expect(new Bun.CryptoHasher("sha256").update(resolved!.bytes).digest("hex")).toBe(
            new Bun.CryptoHasher("sha256").update(text).digest("hex"),
          )
          expect(Buffer.from(resolved!.bytes.subarray(0, 5)).toString("utf8")).toBe("head-")
          expect(Buffer.from(resolved!.bytes.subarray(-5)).toString("utf8")).toBe("-tail")
        }),
      ),
    { timeout: 120_000 },
  )

  it.live("externalizes medium tool text once and restores a bounded provider preview", () =>
    withStore(({ store, outputs, db }) =>
      Effect.gen(function* () {
        const text = `head-${"x".repeat(MAX_PERSISTED_CONTENT_PREVIEW_BYTES + 4_096)}-tail`
        const bounded = yield* outputs.bound({
          sessionID,
          assistantMessageID: SessionMessage.ID.make("msg_content_medium_tool_text"),
          toolCallID: "call-content-medium-text",
          output: { structured: { kind: "report", output: text }, content: [{ type: "text", text }] },
        })

        expect(bounded.outputPaths).toHaveLength(1)
        if (bounded.output.content[0]?.type !== "text") throw new Error("expected bounded text preview")
        expect(Buffer.byteLength(bounded.output.content[0].text, "utf8")).toBeLessThanOrEqual(
          MAX_PERSISTED_CONTENT_PREVIEW_BYTES,
        )
        const structured = bounded.output.structured as { output: string; $opencode?: { text?: { uri?: string } } }
        expect(Buffer.byteLength(structured.output, "utf8")).toBeLessThanOrEqual(MAX_PERSISTED_CONTENT_PREVIEW_BYTES)
        expect((yield* db.select({ value: count() }).from(ContentBlobTable).get())?.value).toBe(1)
        expect((yield* db.select({ value: count() }).from(AttachmentTable).get())?.value).toBe(1)
        const materialized = yield* outputs.materialize({ sessionID, output: bounded.output })
        expect(materialized.content[0]?.type).toBe("text")
        if (materialized.content[0]?.type !== "text") throw new Error("expected provider text preview")
        expect(Buffer.byteLength(materialized.content[0].text, "utf8")).toBeLessThanOrEqual(
          ToolOutputStore.MAX_PROVIDER_PREVIEW_BYTES,
        )
        expect(materialized.content[0].text).toContain("head-")
        expect(materialized.content[0].text).toContain("-tail")
        expect(materialized.content[0].text).not.toBe(text)
        const resolved = yield* store.resolve({ uri: structured.$opencode!.text!.uri!, sessionID })
        expect(Buffer.from(resolved!.bytes).toString("utf8")).toBe(text)
      }),
    ),
  )

  it.live("keeps medium structured-only tool results as JSON", () =>
    withStore(({ outputs, db }) =>
      Effect.gen(function* () {
        const structured = { payload: "x".repeat(MAX_PERSISTED_CONTENT_PREVIEW_BYTES + 4_096) }
        const bounded = yield* outputs.bound({
          sessionID,
          assistantMessageID: SessionMessage.ID.make("msg_content_medium_structured"),
          toolCallID: "call-content-medium-structured",
          output: { structured, content: [] },
        })

        expect(bounded.output).toEqual({ structured, content: [] })
        expect(bounded.outputPaths).toEqual([])
        expect((yield* db.select({ value: count() }).from(ContentBlobTable).get())?.value).toBe(0)
        expect((yield* db.select({ value: count() }).from(AttachmentTable).get())?.value).toBe(0)
      }),
    ),
  )

  it.live("materializes migrated legacy metadata and output references independently", () =>
    withStore(({ store, outputs }) =>
      Effect.gen(function* () {
        const metadata = { result: { rows: [1, 2, 3] }, source: "legacy" }
        const encoded = JSON.stringify(metadata)
        const structured = yield* store.storeAttachment({
          sessionID,
          messageID: SessionMessage.ID.make("msg_content_legacy_tool"),
          key: "legacy-tool:structured",
          bytes: Buffer.from(encoded, "utf8"),
          mime: "application/json",
          name: "legacy-tool-structured.json",
        })
        const output = "full legacy tool output\n".repeat(4_000)
        const text = yield* store.storeAttachment({
          sessionID,
          messageID: SessionMessage.ID.make("msg_content_legacy_tool"),
          key: "legacy-tool:output",
          bytes: Buffer.from(output, "utf8"),
          mime: "text/plain",
          name: "legacy-tool-output.txt",
        })
        const materialized = yield* outputs.materialize({
          sessionID,
          output: {
            structured: {
              $opencode: {
                type: "content-reference",
                uri: structured.uri,
                mime: "application/json",
                sizeBytes: Buffer.byteLength(encoded, "utf8"),
                preview: "legacy metadata preview",
                output: {
                  type: "content-reference",
                  uri: text.uri,
                  mime: "text/plain",
                  sizeBytes: Buffer.byteLength(output, "utf8"),
                },
              },
            },
            content: [{ type: "text", text: "legacy output preview" }],
          },
        })

        const providerMetadata = materialized.structured as { $opencode?: { preview?: string } }
        expect(providerMetadata.$opencode?.preview).toContain('"source":"legacy"')
        expect(Buffer.byteLength(providerMetadata.$opencode?.preview ?? "", "utf8")).toBeLessThanOrEqual(
          ToolOutputStore.MAX_BYTES,
        )
        expect(materialized.content[0]?.type).toBe("text")
        if (materialized.content[0]?.type !== "text") throw new Error("expected provider text preview")
        expect(Buffer.byteLength(materialized.content[0].text, "utf8")).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
        expect(materialized.content[0].text).not.toBe(output)
      }),
    ),
  )
})
