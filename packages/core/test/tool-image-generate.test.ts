import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { ImageGeneration } from "@opencode-ai/core/image-generation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionV2 } from "@opencode-ai/core/session"
import { ImageGenerateTool } from "@opencode-ai/core/tool/image-generate"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const assertions: PermissionV2.AssertInput[] = []
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const images = Layer.succeed(
  ImageGeneration.Service,
  ImageGeneration.Service.of({
    generate: (input) =>
      Effect.succeed({ data: new Uint8Array([1, 2, 3]), mime: "image/png", filename: `${input.size ?? "auto"}.png` }),
  }),
)
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const imageGenerate = ImageGenerateTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(permission),
  Layer.provide(images),
)
const it = testEffect(Layer.mergeAll(registry, permission, images, imageGenerate))

const call = (input: typeof ImageGenerateTool.Input.Type) => ({
  sessionID: SessionV2.ID.make("ses_image_generate_test"),
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-image-generate", name: ImageGenerateTool.name, input },
})

describe("ImageGenerateTool", () => {
  test("is wired into the location's built-in tool set", async () => {
    const builtins = await Bun.file(new URL("../src/tool/builtins.ts", import.meta.url)).text()
    expect(builtins).toContain('import { ImageGenerateTool } from "./image-generate"')
    expect(builtins).toMatch(/Layer\.mergeAll\([\s\S]*ImageGenerateTool\.layer/)
  })

  test("validates bounded timeout and supported formats", () => {
    const decode = Schema.decodeUnknownSync(ImageGenerateTool.Input)
    expect(decode({ prompt: "A geometric fox", timeoutSeconds: 30, format: "webp" })).toMatchObject({
      prompt: "A geometric fox",
      timeoutSeconds: 30,
      format: "webp",
    })
    expect(() => decode({ prompt: "x", format: "svg" })).toThrow()
  })

  it.effect("registers, asks permission, and returns an inline raster file", () =>
    Effect.gen(function* () {
      assertions.length = 0
      const tools = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(tools)).map((definition) => definition.name)).toContain(ImageGenerateTool.name)
      expect(yield* executeTool(tools, call({ prompt: "A geometric fox", size: "1024x1024" }))).toMatchObject({
        type: "content",
        value: [
          { type: "text", text: "Generated 1024x1024.png (3 bytes)." },
          { type: "file", mime: "image/png", name: "1024x1024.png", uri: expect.stringContaining("attachment://") },
        ],
      })
      expect(assertions).toMatchObject([
        {
          action: "image_generate",
          resources: ["codex-image-generation"],
          metadata: { prompt: "A geometric fox", size: "1024x1024" },
        },
      ])
    }),
  )
})
