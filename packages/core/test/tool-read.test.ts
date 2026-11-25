import { beforeEach, describe, expect } from "bun:test"
import path from "path"
import { createHash } from "crypto"
import { Effect, Exit, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigAttachments } from "@opencode-ai/core/config/attachments"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Image } from "@opencode-ai/core/image"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionV2 } from "@opencode-ai/core/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import type { ToolContent, ToolOutput } from "@opencode-ai/llm"
import { ReadTool } from "@opencode-ai/core/tool/read"
import { ReadToolFileSystem } from "@opencode-ai/core/tool/read-filesystem"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const assertions: PermissionV2.AssertInput[] = []
const readCalls: {
  input: AbsolutePath
  page: ReadToolFileSystem.PageInput
}[] = []
const listCalls: ReadToolFileSystem.PageInput[] = []
let resolvedType: "file" | "directory" = "file"
let resolveFailure: unknown
let readResult: FileSystem.Content | ReadToolFileSystem.TextPage = {
  uri: "file:///README.md",
  name: "README.md",
  content: "hello",
  encoding: "utf8",
  mime: "text/plain",
}
let readFailure: ReadToolFileSystem.ReadError | undefined
let configEntries: Config.Entry[] = []
const reader = Layer.succeed(
  ReadToolFileSystem.Service,
  ReadToolFileSystem.Service.of({
    inspect: () => (resolveFailure === undefined ? Effect.succeed(resolvedType) : Effect.die(resolveFailure)),
    read: (input, _resource, page = {}) => {
      readCalls.push({ input, page })
      if (readFailure !== undefined) return Effect.fail(readFailure)
      return Effect.succeed(readResult)
    },
    list: (_path, input = {}) =>
      Effect.sync(() => {
        listCalls.push(input)
        return new ReadToolFileSystem.ListPage({ entries: [], truncated: false })
      }),
  }),
)
let allow = true
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => {
        assertions.push(input)
      }).pipe(Effect.andThen(allow ? Effect.void : Effect.fail(new PermissionV2.DeniedError({ rules: [] })))),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const outputs = ToolOutputStore.defaultLayer
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(configEntries) }))
const image = Image.layer.pipe(Layer.provide(config))
const testFileSystem = Layer.effect(
  FSUtil.Service,
  FSUtil.Service.use((fs) => Effect.succeed(FSUtil.Service.of({ ...fs, realPath: (path) => Effect.succeed(path) }))),
).pipe(Layer.provide(FSUtil.defaultLayer))
const infrastructure = Layer.mergeAll(
  testFileSystem,
  Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(process.cwd()) }))),
  Global.layerWith({ data: Global.Path.data }),
)
const slash = (value: string) => value.replaceAll("\\", "/")
const mutation = Layer.succeed(
  LocationMutation.Service,
  LocationMutation.Service.of({
    resolve: (input) =>
      Effect.sync(() => {
        const root = path.resolve(process.cwd())
        const canonical = path.resolve(root, input.path)
        const external = !FSUtil.contains(root, canonical)
        const directory = path.dirname(canonical)
        return {
          canonical,
          resource: external ? slash(canonical) : slash(path.relative(root, canonical) || "."),
          externalDirectory: external
            ? {
                action: "external_directory",
                directory,
                resource: slash(path.join(directory, "*")),
                save: slash(path.join(directory, "*")),
              }
            : undefined,
        }
      }),
  }),
)
const unavailableImage = Layer.succeed(
  Image.Service,
  Image.Service.of({ normalize: () => Effect.fail(new Image.ResizerUnavailableError()) }),
)
const read = ReadTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(reader),
  Layer.provide(permission),
  Layer.provide(config),
  Layer.provide(image),
  Layer.provide(mutation),
  Layer.provide(infrastructure),
)
const it = testEffect(
  Layer.mergeAll(registry, outputs, reader, permission, config, image, infrastructure, mutation, read),
)
const unavailableRead = ReadTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(reader),
  Layer.provide(permission),
  Layer.provide(config),
  Layer.provide(unavailableImage),
  Layer.provide(mutation),
  Layer.provide(infrastructure),
)
const itWithoutResizer = testEffect(
  Layer.mergeAll(
    registry,
    outputs,
    reader,
    permission,
    config,
    unavailableImage,
    infrastructure,
    mutation,
    unavailableRead,
  ),
)
const sessionID = SessionV2.ID.make("ses_read_tool_test")
const materialize = (output: ToolOutput) =>
  ToolOutputStore.Service.use((store) => store.materialize({ sessionID, output }))
const durableFile = (result: ToolRegistry.Settlement["result"]) => {
  expect(result.type).toBe("content")
  if (result.type !== "content") throw new Error("expected native tool content")
  const file = result.value.find((item: ToolContent) => item.type === "file")
  expect(file).toBeDefined()
  if (!file || file.type !== "file") throw new Error("expected durable file attachment")
  expect(file.uri).toStartWith("attachment://")
  return file
}
const readCall = (resource: string, page: ReadToolFileSystem.PageInput = { offset: undefined, limit: undefined }) => ({
  input: AbsolutePath.make(path.resolve(process.cwd(), resource)),
  page,
})

describe("ReadTool", () => {
  beforeEach(() => {
    assertions.length = 0
    readCalls.length = 0
    listCalls.length = 0
    allow = true
    resolvedType = "file"
    resolveFailure = undefined
    readResult = {
      uri: "file:///README.md",
      name: "README.md",
      content: "hello",
      encoding: "utf8",
      mime: "text/plain",
    }
    readFailure = undefined
    configEntries = []
  })

  it.effect("registers, authorizes, and reads through the location filesystem", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      expect(yield* toolDefinitions(registry)).toMatchObject([{ name: "read" }])
      expect(yield* toolDefinitions(registry, [{ action: "read", resource: "*", effect: "deny" }])).toEqual([])
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-read", name: "read", input: { path: "README.md" } },
        }),
      ).toEqual({
        type: "text",
        value: "<path>README.md</path>\n<type>file</type>\n<content>\n1: hello\n\n(End of file - total 1 lines)\n</content>",
      })
      expect(assertions).toMatchObject([{ sessionID, action: "read", resources: ["README.md"], save: ["*"] }])
      expect(readCalls).toEqual([readCall("README.md")])
    }),
  )

  it.effect("accepts the legacy filePath provider alias", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-read-file-path", name: "read", input: { filePath: "README.md" } },
        }),
      ).toEqual({
        type: "text",
        value: "<path>README.md</path>\n<type>file</type>\n<content>\n1: hello\n\n(End of file - total 1 lines)\n</content>",
      })
      expect(readCalls).toEqual([readCall("README.md")])
    }),
  )

  it.effect("accepts matching canonical and legacy read paths", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-read-matching-paths",
          name: "read",
          input: { path: "README.md", filePath: "README.md" },
        },
      })

      expect(readCalls).toEqual([readCall("README.md")])
    }),
  )

  it.effect("rejects conflicting canonical and legacy read paths", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-read-conflicting-paths",
            name: "read",
            input: { path: "README.md", filePath: "AGENTS.md" },
          },
        }),
      ).toEqual({
        type: "error",
        value: "Invalid tool input: path and filePath must match when both are provided",
      })
      expect(readCalls).toEqual([])
    }),
  )

  it.effect("rejects read input without a path", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-read-missing-path", name: "read", input: {} },
        }),
      ).toEqual({ type: "error", value: "Invalid tool input: path or filePath is required" })
      expect(readCalls).toEqual([])
    }),
  )

  it.live("returns the whole-file SHA-256 for full and paged reads", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const target = path.join(tmp.path, "versioned.txt")
          const content = "first\nsecond\nthird\n"
          yield* Effect.promise(() => Bun.write(target, content))
          const fs = yield* FSUtil.Service
          const expected = createHash("sha256").update(content).digest("hex")

          expect(yield* ReadToolFileSystem.read(fs, target, "versioned.txt")).toMatchObject({ sha256: expected })
          expect(yield* ReadToolFileSystem.read(fs, target, "versioned.txt", { offset: 2, limit: 1 })).toMatchObject({
            type: "text-page",
            content: "second",
            sha256: expected,
          })
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("renders explicitly requested full lines with bounded UTF-8 pages and the whole-file hash", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const target = path.join(tmp.path, "long.txt")
          const long = "😀ü".repeat(3000)
          const content = `before\r\n${long}\r\nafter\r\n`
          yield* Effect.promise(() => Bun.write(target, content))
          const page = yield* ReadToolFileSystem.read(fs, target, "long.txt", { offset: 2, limit: 1, fullLines: true })
          expect(page).toMatchObject({
            type: "text-page",
            content: long,
            fullLines: true,
            truncated: true,
            next: 3,
            sha256: createHash("sha256").update(content).digest("hex"),
          })
          const rendered = ReadTool.toModelOutput({ path: "long.txt" }, page)
          expect(rendered).toHaveLength(1)
          expect(rendered[0]).toMatchObject({ type: "text", text: expect.stringContaining(`2: ${long}\n`) })
          const defaultPage = yield* ReadToolFileSystem.read(fs, target, "long.txt", { offset: 2, limit: 1 })
          expect(defaultPage.content).toContain(ReadToolFileSystem.MAX_LINE_SUFFIX)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("pages full lines at the byte limit and refuses a line too large to render", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const target = path.join(tmp.path, "budget.txt")
          const long = "ü".repeat(ReadToolFileSystem.MAX_READ_BYTES / 2)
          yield* Effect.promise(() => Bun.write(target, `${long}\ntail\n`))
          expect(yield* ReadToolFileSystem.read(fs, target, "budget.txt", { fullLines: true })).toMatchObject({
            content: long,
            truncated: true,
            next: 2,
            fullLines: true,
          })
          expect(yield* ReadToolFileSystem.read(fs, target, "budget.txt", { offset: 2, fullLines: true })).toMatchObject({
            content: "tail",
            truncated: false,
          })
          yield* Effect.promise(() => Bun.write(target, `${long}ü\n`))
          const error = yield* ReadToolFileSystem.read(fs, target, "budget.txt", { fullLines: true }).pipe(Effect.flip)
          expect(error).toBeInstanceOf(ReadToolFileSystem.FullLineLimitError)
          expect(error.message).toContain("51200")
          // The streaming path must also refuse a line spanning multiple 64 KiB reads.
          yield* Effect.promise(() => Bun.write(target, "x".repeat(130_000)))
          expect(
            yield* ReadToolFileSystem.read(fs, target, "budget.txt", { fullLines: true }).pipe(Effect.flip),
          ).toBeInstanceOf(ReadToolFileSystem.FullLineLimitError)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("reports invalid UTF-8 text as a binary file error instead of an encoder defect", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const mid = path.join(tmp.path, "legacy-mid.txt")
          yield* Effect.promise(() => Bun.write(mid, new Uint8Array([0x46, 0xe4, 0x0a])))
          const tail = path.join(tmp.path, "legacy-tail.txt")
          yield* Effect.promise(() => Bun.write(tail, new Uint8Array([0x61, 0xc3])))

          expect(yield* ReadToolFileSystem.read(fs, mid, "legacy-mid.txt").pipe(Effect.flip)).toBeInstanceOf(
            ReadToolFileSystem.BinaryFileError,
          )
          expect(
            yield* ReadToolFileSystem.read(fs, mid, "legacy-mid.txt", { offset: 1, limit: 5 }).pipe(Effect.flip),
          ).toBeInstanceOf(ReadToolFileSystem.BinaryFileError)
          expect(yield* ReadToolFileSystem.read(fs, tail, "legacy-tail.txt").pipe(Effect.flip)).toBeInstanceOf(
            ReadToolFileSystem.BinaryFileError,
          )
          expect(
            yield* ReadToolFileSystem.read(fs, tail, "legacy-tail.txt", { offset: 1, limit: 5 }).pipe(Effect.flip),
          ).toBeInstanceOf(ReadToolFileSystem.BinaryFileError)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("validates paged reads past the returned page without changing page output", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const lines = Array.from({ length: 20_000 }, (_, index) => `line-${index + 1}-${"x".repeat(88)}`)
          const content = lines.join("\n") + "\n"
          const expected = createHash("sha256").update(content).digest("hex")

          const clean = path.join(tmp.path, "large-clean.txt")
          yield* Effect.promise(() => Bun.write(clean, content))
          const first = yield* ReadToolFileSystem.read(fs, clean, "large-clean.txt", { offset: 1, limit: 20 })
          expect(first).toMatchObject({
            type: "text-page",
            content: lines.slice(0, 20).join("\n"),
            truncated: true,
            next: 21,
            sha256: expected,
          })
          const second = yield* ReadToolFileSystem.read(fs, clean, "large-clean.txt", { offset: 21, limit: 20 })
          expect(second).toMatchObject({
            type: "text-page",
            content: lines.slice(20, 40).join("\n"),
            truncated: true,
            next: 41,
            sha256: expected,
          })

          const nulled = lines.with(12_000, `nulled-${"\0"}-marker-${"x".repeat(80)}`).join("\n") + "\n"
          const withNull = path.join(tmp.path, "large-null.txt")
          yield* Effect.promise(() => Bun.write(withNull, nulled))
          expect(
            yield* ReadToolFileSystem.read(fs, withNull, "large-null.txt", { offset: 1, limit: 20 }).pipe(Effect.flip),
          ).toBeInstanceOf(ReadToolFileSystem.BinaryFileError)

          const invalid = lines.with(12_000, `invalid-ä-marker-${"x".repeat(80)}`).join("\n") + "\n"
          const withLegacy = path.join(tmp.path, "large-legacy.txt")
          yield* Effect.promise(() => Bun.write(withLegacy, Buffer.from(invalid, "latin1")))
          expect(
            yield* ReadToolFileSystem.read(fs, withLegacy, "large-legacy.txt", { offset: 1, limit: 20 }).pipe(
              Effect.flip,
            ),
          ).toBeInstanceOf(ReadToolFileSystem.BinaryFileError)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.effect("bounds large text read output through managed storage", () =>
    Effect.gen(function* () {
      readResult = {
        uri: "file:///large.txt",
        name: "large.txt",
        content: Array.from({ length: ReadToolFileSystem.MAX_READ_LINES + 10 }, (_, index) =>
          `${index + 1}: ${"x".repeat(80)}`,
        ).join("\n"),
        encoding: "utf8",
        mime: "text/plain",
      }
      const registry = yield* ToolRegistry.Service

      const settled = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-large-text", name: "read", input: { path: "large.txt" } },
      })

      expect(settled.outputPaths).toHaveLength(1)
      expect(settled.outputPaths?.[0]).toStartWith("attachment://")
      expect(settled.result.type).toBe("text")
      if (settled.result.type === "text") expect(settled.result.value).toContain("full output stored at attachment://")
      expect(settled.output?.structured).toMatchObject({ name: "large.txt", encoding: "utf8", mime: "text/plain" })
    }),
  )

  it.effect("approves an external directory before reading an external absolute path", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "external.txt"), "external"))
      const registry = yield* ToolRegistry.Service

      yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-external-read", name: "read", input: { path: path.join(tmp.path, "external.txt") } },
      })

      expect(assertions.map((input) => input.action)).toEqual(["external_directory", "read"])
      expect(assertions[0]?.resources[0]).toBe(path.join(tmp.path, "*").replaceAll("\\", "/"))
      expect(assertions[1]?.resources[0]).toBe(path.join(tmp.path, "external.txt").replaceAll("\\", "/"))
    }),
  )

  it.effect("uses location-relative read resources for absolute in-location paths", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const target = path.join(process.cwd(), "README.md")

      yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-absolute-read", name: "read", input: { path: target } },
      })

      expect(assertions.map((input) => input.action)).toEqual(["read"])
      expect(assertions[0]?.resources).toEqual(["README.md"])
    }),
  )

  it.effect("externalizes a small PNG durably and materializes it for the provider", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        uri: "file:///pixel.png",
        name: "pixel.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* ToolRegistry.Service

      const settled = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-image", name: "read", input: { path: "pixel.png" } },
      })
      expect(durableFile(settled.result)).toMatchObject({ mime: "image/png", name: "pixel.png" })
      expect(readCalls).toEqual([readCall("pixel.png")])
      expect(JSON.stringify(settled.result)).not.toContain(";base64,")
      expect(settled.output?.structured).toMatchObject({
        uri: "file:///pixel.png",
        name: "pixel.png",
        mime: "image/png",
        encoding: "base64",
      })
      const durableOutput = settled.output?.content.find((item) => item.type === "file")
      expect(durableOutput).toMatchObject({ type: "file", mime: "image/png", name: "pixel.png" })
      if (durableOutput?.type === "file") expect(durableOutput.uri).toStartWith("attachment://")
      if (!settled.output) return
      expect((yield* materialize(settled.output)).content).toEqual([
        { type: "text", text: "Image read successfully" },
        { type: "file", mime: "image/png", uri: `data:image/png;base64,${png}`, name: "pixel.png" },
      ])
    }),
  )

  it.effect("externalizes a PDF durably and materializes it for the provider", () =>
    Effect.gen(function* () {
      readResult = {
        uri: "file:///document.pdf",
        name: "document.pdf",
        content: "JVBERi0x",
        encoding: "base64",
        mime: "application/pdf",
      }
      const registry = yield* ToolRegistry.Service

      const settled = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-pdf", name: "read", input: { path: "document.pdf" } },
      })
      expect(durableFile(settled.result)).toMatchObject({ mime: "application/pdf", name: "document.pdf" })
      expect(JSON.stringify(settled.result)).not.toContain(";base64,")
      if (!settled.output) return
      expect((yield* materialize(settled.output)).content).toEqual([
        { type: "text", text: "PDF read successfully" },
        { type: "file", uri: "data:application/pdf;base64,JVBERi0x", mime: "application/pdf", name: "document.pdf" },
      ])
    }),
  )

  it.effect("preserves a PNG above the generic text limit as native media", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const pixels = Uint8Array.from({ length: 256 * 256 * 4 }, (_, index) => (index * 73 + (index >> 3)) % 256)
      const source = new photon.PhotonImage(pixels, 256, 256)
      const png = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      expect(Buffer.byteLength(png)).toBeGreaterThan(50 * 1024)
      readResult = {
        uri: "file:///large.png",
        name: "large.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* ToolRegistry.Service

      const settled = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-large-image", name: "read", input: { path: "large.png" } },
      })

      expect(settled.outputPaths).toBeUndefined()
      expect(durableFile(settled.result)).toMatchObject({ mime: "image/png", name: "large.png" })
      const metadata = settled.output?.structured as {
        content?: { $opencode?: { type?: string; uri?: string; mime?: string; sizeBytes?: number } }
      }
      expect(metadata.content?.$opencode).toMatchObject({
        type: "content-reference",
        mime: "image/png",
        sizeBytes: Buffer.from(png, "base64").byteLength,
        uri: durableFile(settled.result).uri,
      })
      expect(JSON.stringify(settled.output)).not.toContain(png)
      if (!settled.output) return
      expect((yield* materialize(settled.output)).content).toEqual([
        { type: "text", text: "Image read successfully" },
        { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "large.png" },
      ])
    }),
  )

  itWithoutResizer.effect("returns the original image when the resizer is unavailable", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        uri: "file:///pixel.png",
        name: "pixel.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* ToolRegistry.Service

      const settled = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-image-fallback", name: "read", input: { path: "pixel.png" } },
      })
      expect(durableFile(settled.result)).toMatchObject({ mime: "image/png", name: "pixel.png" })
      if (!settled.output) return
      expect((yield* materialize(settled.output)).content).toEqual([
        { type: "text", text: "Image read successfully" },
        { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "pixel.png" },
      ])
    }),
  )

  it.effect("rejects invalid image data returned by the filesystem", () =>
    Effect.gen(function* () {
      readResult = {
        uri: "file:///truncated.png",
        name: "truncated.png",
        content: "iVBORw0KGgo=",
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-truncated-image", name: "read", input: { path: "truncated.png" } },
        }),
      ).toEqual({ type: "error", value: "Image could not be decoded: truncated.png" })
    }),
  )

  it.effect("rejects oversized images when resizing is disabled", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 16 * 4 }, () => 255)), 16, 1)
      const base64 = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      readResult = {
        uri: "file:///wide.png",
        name: "wide.png",
        content: base64,
        encoding: "base64",
        mime: "image/png",
      }
      configEntries = [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            attachments: new ConfigAttachments.Info({
              image: new ConfigAttachments.Image({ auto_resize: false, max_width: 4 }),
            }),
          }),
        }),
      ]
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-wide-image", name: "read", input: { path: "wide.png" } },
      })

      expect(result.type).toBe("error")
      if (result.type === "error") expect(result.value).toContain("exceeding configured limits 4x2000")
    }),
  )

  it.effect("resizes images to configured dimensions before returning media", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 16 * 4 }, () => 255)), 16, 1)
      const base64 = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      readResult = {
        uri: "file:///wide.png",
        name: "wide.png",
        content: base64,
        encoding: "base64",
        mime: "image/png",
      }
      configEntries = [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            attachments: new ConfigAttachments.Info({ image: new ConfigAttachments.Image({ max_width: 4 }) }),
          }),
        }),
      ]
      const registry = yield* ToolRegistry.Service
      const settled = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-resize-image", name: "read", input: { path: "wide.png" } },
      })

      expect(durableFile(settled.result)).toMatchObject({ mime: "image/png", name: "wide.png" })
      if (!settled.output) return
      const provider = yield* materialize(settled.output)
      const media = provider.content[1]
      expect(media?.type).toBe("file")
      if (media?.type !== "file") return
      const resized = photon.PhotonImage.new_from_byteslice(Buffer.from(media.uri.split(",")[1] ?? "", "base64"))
      expect(resized.get_width()).toBeLessThanOrEqual(4)
      expect(resized.get_height()).toBeLessThanOrEqual(2_000)
      resized.free()
    }),
  )

  it.effect("enforces max base64 bytes after resize attempts", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        uri: "file:///pixel.png",
        name: "pixel.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      configEntries = [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            attachments: new ConfigAttachments.Info({
              image: new ConfigAttachments.Image({ max_base64_bytes: 1 }),
            }),
          }),
        }),
      ]
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-max-bytes", name: "read", input: { path: "pixel.png" } },
      })

      expect(result.type).toBe("error")
      if (result.type === "error") expect(result.value).toContain("/1 bytes")
    }),
  )

  it.effect("returns supported image contents despite a misleading binary extension", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        uri: "file:///pixel.bin",
        name: "pixel.bin",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-disguised-image", name: "read", input: { path: "pixel.bin" } },
        }),
      ).toMatchObject({
        type: "content",
        value: [{ type: "text" }, { type: "file", mime: "image/png", name: "pixel.bin" }],
      })
    }),
  )

  it.effect("returns expected filesystem read errors as model-visible tool errors", () =>
    Effect.gen(function* () {
      readFailure = new ReadToolFileSystem.BinaryFileError("archive.dat")
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-binary",
            name: "read",
            input: { path: "archive.dat", offset: 2, limit: 1 },
          },
        }),
      ).toEqual({ type: "error", value: "Cannot read binary file: archive.dat" })
      expect(readCalls).toEqual([readCall("archive.dat", { offset: 2, limit: 1 })])
    }),
  )

  it.effect("does not read when permission is denied", () =>
    Effect.gen(function* () {
      allow = false
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-read", name: "read", input: { path: "README.md" } },
        }),
      ).toEqual({ type: "error", value: "Unable to read README.md" })
      expect(readCalls).toEqual([])
    }),
  )

  it.effect("authorizes full-line mode normally and preserves its typed byte-limit refusal", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      allow = false
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "full-denied", name: "read", input: { path: "long.txt", fullLines: true } },
        }),
      ).toEqual({ type: "error", value: "Unable to read long.txt" })
      expect(readCalls).toEqual([])
      allow = true
      readFailure = new ReadToolFileSystem.FullLineLimitError("long.txt", 2)
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "full-limit",
            name: "read",
            input: { path: "long.txt", offset: 2, limit: 1, fullLines: true },
          },
        }),
      ).toEqual({ type: "error", value: readFailure.message })
      expect(readCalls).toEqual([readCall("long.txt", { offset: 2, limit: 1, fullLines: true })])
    }),
  )

  it.effect("rejects full-line mode for directory listings", () =>
    Effect.gen(function* () {
      resolvedType = "directory"
      const registry = yield* ToolRegistry.Service
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "full-directory", name: "read", input: { path: "src", fullLines: true } },
        }),
      ).toEqual({ type: "error", value: "fullLines is supported only for text files, not directories" })
      expect(listCalls).toEqual([])
    }),
  )

  it.effect("lists a bounded directory page through read", () =>
    Effect.gen(function* () {
      resolvedType = "directory"
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-read-directory",
            name: "read",
            input: { path: "src", offset: 2, limit: 10 },
          },
        }),
      ).toEqual({
        type: "text",
        value: "<path>src</path>\n<type>directory</type>\n<entries>\n\n(0 entries)\n</entries>",
      })
      expect(assertions).toMatchObject([{ sessionID, action: "read", resources: ["src"], save: ["*"] }])
      expect(listCalls).toEqual([{ offset: 2, limit: 10 }])
    }),
  )

  it.effect("does not list a directory when permission is denied", () =>
    Effect.gen(function* () {
      allow = false
      resolvedType = "directory"
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-read-directory-denied", name: "read", input: { path: "src" } },
        }),
      ).toEqual({ type: "error", value: "Unable to read src" })
      expect(listCalls).toEqual([])
    }),
  )

  it.effect("preserves unexpected resolution defects", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      resolveFailure = new Error("missing")
      expect(
        Exit.isFailure(
          yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-missing", name: "read", input: { path: "missing.txt" } },
          }).pipe(Effect.exit),
        ),
      ).toBe(true)

      expect(readCalls).toEqual([])
    }),
  )

  it.effect("forwards pagination and returns bounded text pages with continuation", () =>
    Effect.gen(function* () {
      readResult = new ReadToolFileSystem.TextPage({
        type: "text-page",
        content: "hello",
        mime: "text/plain",
        offset: 2,
        truncated: true,
        next: 3,
      })
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-large",
            name: "read",
            input: { path: "large.txt", offset: 2, limit: 1 },
          },
        }),
      ).toEqual({
        type: "text",
        value: "<path>large.txt</path>\n<type>file</type>\n<content>\n2: hello\n\n(Showing lines 2-2. Use offset=3 to continue.)\n</content>",
      })
      expect(readCalls).toEqual([readCall("large.txt", { offset: 2, limit: 1 })])
    }),
  )

  it.effect("rejects unsupported binary discovered by a direct read", () =>
    Effect.gen(function* () {
      readResult = {
        uri: "file:///late-binary",
        name: "late-binary",
        content: "AAECAw==",
        encoding: "base64",
        mime: "application/octet-stream",
      }
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-direct-binary", name: "read", input: { path: "late-binary" } },
        }),
      ).toEqual({ type: "error", value: "Cannot read binary file: late-binary" })
    }),
  )
})
