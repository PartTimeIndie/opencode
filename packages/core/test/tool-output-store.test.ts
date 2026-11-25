import { describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@opencode-ai/core/config"
import { ConfigOptimization } from "@opencode-ai/core/config/optimization"
import { ConfigToolOutput } from "@opencode-ai/core/config/tool-output"
import { ContentStore } from "@opencode-ai/core/content-store"
import { MAX_PERSISTED_CONTENT_PREVIEW_BYTES } from "@opencode-ai/core/content-preview"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { toolDetailsMetadata } from "@opencode-ai/core/util/tool-details"
import { isRecord } from "@opencode-ai/core/util/record"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const sessionID = SessionV2.ID.make("ses_tool_output_store")

const withStore = <A, E, R>(
  body: (input: { root: string; store: ToolOutputStore.Interface; fs: FSUtil.Interface }) => Effect.Effect<A, E, R>,
  config?: Config.Info,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const global = Global.layerWith({ data: tmp.path })
      const configured = config
        ? Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () => Effect.succeed([new Config.Document({ type: "document", info: config })]),
            }),
          )
        : Layer.empty
      const store = ToolOutputStore.layer.pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(global),
        Layer.provide(configured),
      )
      return Effect.gen(function* () {
        return yield* body({ root: tmp.path, store: yield* ToolOutputStore.Service, fs: yield* FSUtil.Service })
      }).pipe(Effect.provide(Layer.mergeAll(store, FSUtil.defaultLayer)))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const withSharedStore = <A, E, R>(
  body: (input: {
    root: string
    store: ToolOutputStore.Interface
    contentStore: ContentStore.Interface
  }) => Effect.Effect<A, E, R>,
  config?: Config.Info,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const database = Database.layerFromPath(path.join(tmp.path, "content.db")).pipe(Layer.fresh)
      const global = Global.layerWith({ data: tmp.path })
      const configured = config
        ? Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () => Effect.succeed([new Config.Document({ type: "document", info: config })]),
            }),
          )
        : Layer.empty
      const content = ContentStore.layer.pipe(
        Layer.provide(database),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(global),
      )
      const store = ToolOutputStore.layer.pipe(
        Layer.provide(content),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(global),
        Layer.provide(configured),
      )
      return Effect.gen(function* () {
        return yield* body({
          root: tmp.path,
          store: yield* ToolOutputStore.Service,
          contentStore: yield* ContentStore.Service,
        })
      }).pipe(Effect.provide(Layer.mergeAll(database, content, store)))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const it = testEffect(Layer.empty)

describe("ToolOutputStore", () => {
  it.live("retains bounded fanout details when large reviewer results become a managed reference", () =>
    withSharedStore(({ store }) =>
      Effect.gen(function* () {
        const structured = {
          workflow: "review",
          results: [
            {
              reviewer: { model: "configured/reviewer" },
              sessionID: "ses_actual_child",
              status: "success",
              task: { sessionID: "ses_actual_child", state: "completed", text: "report ".repeat(50000) },
              result: { findings: [], notes: ["report ".repeat(50000)] },
            },
          ],
        }
        const bound = yield* store.bound({
          sessionID,
          toolCallID: "large-fanout",
          tool: "multi_agent_fanout",
          output: { structured, content: [{ type: "text", text: JSON.stringify(structured) }] },
        })
        expect(bound.output.structured).toHaveProperty("$opencode")
        const snapshot = isRecord(bound.output.structured) ? bound.output.structured : {}
        const details = toolDetailsMetadata("multi_agent_fanout", snapshot)
        expect(details.reviewers).toMatchObject([
          { model: "configured/reviewer", sessionID: "ses_actual_child", state: "completed" },
        ])
        expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(ToolOutputStore.MAX_STRUCTURED_BYTES)
        // A reload reads the same bounded structured snapshot, not the previous live cache.
        expect(toolDetailsMetadata("multi_agent_fanout", JSON.parse(JSON.stringify(snapshot)))).toEqual(details)
      }),
    ),
  )
  it.live("bounds the provider-facing text channel with one managed file", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const first = "HEAD-" + "x".repeat(30_000)
        const second = "y".repeat(30_000) + "-TAIL"
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-aggregate",
          output: {
            structured: { kind: "report" },
            content: [
              { type: "text", text: first },
              { type: "text", text: second },
            ],
          },
        })
        expect(result.output.structured).toEqual({ kind: "report" })
        expect(result.outputPaths).toHaveLength(1)
        expect(yield* fs.readFileString(result.outputPaths[0])).toBe(first + second)
        if (result.output.content[0]?.type !== "text") throw new Error("expected text preview")
        expect(Buffer.byteLength(result.output.content[0].text)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
      }),
    ),
  )

  it.live("uses bounded text for oversized structured-only output", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const structured = { text: "x".repeat(ToolOutputStore.MAX_BYTES) }
        const result = yield* store.bound({ sessionID, toolCallID: "call-json", output: { structured, content: [] } })
        expect(result.output.structured).toEqual(structured)
        expect(result.outputPaths).toHaveLength(1)
        expect(JSON.parse(yield* fs.readFileString(result.outputPaths[0]))).toEqual(structured)
        expect(result.output.content).toHaveLength(1)
      }),
    ),
  )

  it.live("preserves native media and structured metadata without applying a settlement media limit", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const data = "a".repeat(6 * 1024 * 1024)
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-file",
          output: {
            structured: { caption: "pixel" },
            content: [{ type: "file", uri: `data:image/png;base64,${data}`, mime: "image/png", name: "pixel.png" }],
          },
        })
        expect(result.outputPaths).toEqual([])
        expect(result.output.structured).toEqual({ caption: "pixel" })
        expect(result.output.content).toHaveLength(1)
        expect(result.output.content[0]).toEqual({
          type: "file",
          uri: `data:image/png;base64,${data}`,
          mime: "image/png",
          name: "pixel.png",
        })
      }),
    ),
  )

  it.live("preserves structured metadata and native media when bounding text", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const text = "x".repeat(ToolOutputStore.MAX_BYTES + 1)
        const media = {
          type: "file" as const,
          uri: "data:image/png;base64,aGVsbG8=",
          mime: "image/png",
          name: "pixel.png",
        }
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-text-and-media",
          output: { structured: { caption: "pixel" }, content: [{ type: "text", text }, media] },
        })

        expect(result.output.structured).toEqual({ caption: "pixel" })
        expect(result.output.content[1]).toEqual(media)
        expect(yield* fs.readFileString(result.outputPaths[0])).toBe(text)
      }),
    ),
  )

  it.live("does not double-count structured data duplicated in projected text", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const text = "x".repeat(30_000)
        const output = { structured: { output: text }, content: [{ type: "text" as const, text }] }
        const result = yield* store.bound({ sessionID, toolCallID: "call-duplicated", output })

        expect(result.output.content).toEqual(output.content)
        expect(result.outputPaths).toEqual([])
        expect(Buffer.byteLength((result.output.structured as { output: string }).output, "utf8")).toBeLessThanOrEqual(
          MAX_PERSISTED_CONTENT_PREVIEW_BYTES,
        )
        expect((result.output.structured as { output: string }).output).not.toBe(text)
      }),
    ),
  )

  it.live("fails oversized settlement when complete retention cannot be written", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(root, "tool-output"), "not a directory")
        const exit = yield* store
          .bound({
            sessionID,
            toolCallID: "call-lossy",
            output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag).toBe("ToolOutputStore.StorageError")
      }),
    ),
  )

  it.live("does not encode ignored structured metadata when projected content exists", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const output = { structured: { value: 1n }, content: [{ type: "text" as const, text: "readable text" }] }
        expect(yield* store.bound({ sessionID, toolCallID: "call-unencodable", output })).toEqual({
          output,
          outputPaths: [],
        })
      }),
    ),
  )

  it.live("preserves interruption while retaining complete output", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => tmpdir())
      const blockedFilesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...fs,
            ensureDir: () => Effect.void,
            writeFileString: () => Effect.never,
          })
        }),
      ).pipe(Layer.provide(FSUtil.defaultLayer))
      const store = ToolOutputStore.layer.pipe(
        Layer.provide(blockedFilesystem),
        Layer.provide(Global.layerWith({ data: root.path })),
      )
      const exit = yield* Effect.gen(function* () {
        const service = yield* ToolOutputStore.Service
        const fiber = yield* service
          .bound({
            sessionID,
            toolCallID: "call-interrupted",
            output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })
          .pipe(Effect.forkChild)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(store))
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      yield* Effect.promise(() => root[Symbol.asyncDispose]())
    }),
  )

  it.live("honors configured limits", () =>
    withStore(
      ({ store }) =>
        Effect.gen(function* () {
          expect(yield* store.limits()).toEqual({ maxLines: 2, maxBytes: 1_000 })
          const result = yield* store.bound({
            sessionID,
            toolCallID: "call-config",
            output: { structured: {}, content: [{ type: "text", text: "one\ntwo\nthree" }] },
          })
          expect(result.outputPaths).toHaveLength(1)
        }),
      new Config.Info({ tool_output: new ConfigToolOutput.Info({ max_lines: 2, max_bytes: 1_000 }) }),
    ),
  )

  it.live("keeps complete output when unlimited mode is enabled", () =>
    withStore(
      ({ store }) =>
        Effect.gen(function* () {
          const text = "unlimited-" + "x".repeat(ToolOutputStore.MAX_BYTES * 2)
          expect(yield* store.limits()).toEqual({
            maxLines: Number.POSITIVE_INFINITY,
            maxBytes: Number.POSITIVE_INFINITY,
          })
          const result = yield* store.bound({
            sessionID,
            toolCallID: "call-unlimited",
            output: { structured: {}, content: [{ type: "text", text }] },
          })
          expect(result.outputPaths).toHaveLength(0)
          expect(result.output.content).toEqual([{ type: "text", text }])
        }),
      new Config.Info({ tool_output: new ConfigToolOutput.Info({ unlimited: true }) }),
    ),
  )

  it.live("references duplicate structured media even when unlimited mode is enabled", () =>
    withSharedStore(
      ({ store }) =>
        Effect.gen(function* () {
          const bytes = Buffer.alloc(ToolOutputStore.MAX_STRUCTURED_BYTES + 1)
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
          const base64 = bytes.toString("base64")
          const text = "unlimited structured text " + "x".repeat(ToolOutputStore.MAX_STRUCTURED_BYTES)
          const result = yield* store.bound({
            sessionID,
            toolCallID: "call-unlimited-duplicate-media",
            output: {
              structured: { content: base64, report: text },
              content: [{ type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "pixel.png" }],
            },
          })

          expect(result.outputPaths).toEqual([])
          expect(result.output.content[0]).toMatchObject({ type: "file", mime: "image/png", name: "pixel.png" })
          if (result.output.content[0]?.type !== "file") throw new Error("expected normalized media")
          expect(result.output.content[0].uri).toStartWith(ContentStore.URI_PREFIX)
          expect(result.output.structured).toEqual({
            content: {
              $opencode: {
                type: "content-reference",
                uri: result.output.content[0].uri,
                mime: "image/png",
                sizeBytes: bytes.byteLength,
                encoding: "base64",
              },
            },
            report: text,
          })
          expect(JSON.stringify(result.output.structured)).not.toContain(base64)

          const materialized = yield* store.materialize({ sessionID, output: result.output })
          expect(materialized.content[0]).toMatchObject({
            type: "file",
            uri: `data:image/png;base64,${base64}`,
            mime: "image/png",
          })
          expect((materialized.structured as { report: string }).report).toBe(text)
        }),
      new Config.Info({ tool_output: new ConfigToolOutput.Info({ unlimited: true }) }),
    ),
  )

  it.live("preserves structured output and shares the provider preview budget", () =>
    withSharedStore(({ store }) =>
      Effect.gen(function* () {
        const value = { value: `head-${"x".repeat(24 * 1024)}-tail` }
        const first = yield* store.bound({
          sessionID,
          toolCallID: "call-structured-first",
          output: { structured: value, content: [] },
        })
        const second = yield* store.bound({
          sessionID,
          toolCallID: "call-structured-second",
          output: { structured: value, content: [] },
        })
        expect(first.output.structured).toEqual(value)

        const budget = { remaining: ToolOutputStore.MAX_PROVIDER_PREVIEW_BYTES }
        const materializedFirst = yield* store.materialize({ sessionID, output: first.output, budget })
        const materializedSecond = yield* store.materialize({ sessionID, output: second.output, budget })
        const firstPreview = (materializedFirst.structured as { $opencode: { preview: string } }).$opencode.preview
        const secondPreview = (materializedSecond.structured as { $opencode: { preview: string } }).$opencode.preview
        expect(firstPreview).toContain("head-")
        expect(firstPreview).toContain("-tail")
        expect(Buffer.byteLength(firstPreview, "utf8")).toBeLessThanOrEqual(ToolOutputStore.MAX_PROVIDER_PREVIEW_BYTES)
        expect(secondPreview).toContain("provider replay budget exhausted")
      }),
    ),
  )

  it.live("uses a stable managed path for repeated oversized output when enabled", () =>
    withStore(
      ({ store }) =>
        Effect.gen(function* () {
          const first = yield* store.bound({
            sessionID,
            toolCallID: "call-stable-preview",
            output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })
          const second = yield* store.bound({
            sessionID,
            toolCallID: "call-stable-preview",
            output: { structured: {}, content: [{ type: "text", text: "y".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })

          expect(second.outputPaths).toEqual(first.outputPaths)
          expect(first.outputPaths[0]).toContain("call-stable-preview")
        }),
      new Config.Info({
        optimization: new ConfigOptimization.Info({
          features: new ConfigOptimization.Features({ stable_tool_output_preview: true }),
        }),
      }),
    ),
  )

  it.live("cleans expired stable and legacy managed files without parsing their IDs", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const old = path.join(root, "tool-output", "tool_ses_0b57d077effeExample_call_stable-preview")
        const recent = path.join(root, "tool-output", "tool_recent")
        const unrelated = path.join(root, "tool-output", "keep.txt")
        yield* fs.ensureDir(path.join(root, "tool-output"))
        yield* fs.writeFileString(old, "old")
        yield* fs.writeFileString(recent, "recent")
        yield* fs.writeFileString(unrelated, "keep")
        const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
        yield* fs.utimes(old, expired, expired)
        yield* store.cleanup()
        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
        expect(yield* fs.exists(unrelated)).toBe(true)
      }),
    ),
  )
})
