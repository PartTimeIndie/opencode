import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GenerateError, type ImageGeneration } from "@opencode-ai/core/image-generation"
import { AppPluginHostImages } from "@/plugin/app/host-images"

const adapter = (mode: "ok" | "fail"): ImageGeneration.Adapter => ({
  generate: () =>
    mode === "fail"
      ? Effect.fail(new GenerateError({ message: "Codex did not create a valid image (exit 0)." }))
      : Effect.succeed({ data: new TextEncoder().encode("bild"), mime: "image/png", filename: "image.png" }),
})

describe("app plugin host images", () => {
  test("validates the plugin image request", () => {
    expect(AppPluginHostImages.validateImageInput({ prompt: "x" })).toBeUndefined()
    expect(AppPluginHostImages.validateImageInput({ prompt: "  " })).toBe("Expected prompt")
    expect(AppPluginHostImages.validateImageInput({ prompt: "x".repeat(4001) })).toContain("exceeds")
    expect(AppPluginHostImages.validateImageInput({ prompt: "x", size: "4096x4096" })).toContain("Unsupported image size")
    expect(AppPluginHostImages.validateImageInput({ prompt: "x", format: "gif" })).toContain("Unsupported image format")
    expect(AppPluginHostImages.validateImageInput({ prompt: "x", timeoutSeconds: 10 })).toContain("between 30 and 900")
    expect(AppPluginHostImages.validateImageInput({ prompt: "x", timeoutSeconds: 901 })).toContain("between 30 and 900")
    expect(AppPluginHostImages.validateImageInput({ prompt: "x", size: "1536x1024", format: "png", timeoutSeconds: 300 })).toBeUndefined()
  })

  test("maps the request onto the existing image generation input", () => {
    expect(AppPluginHostImages.toImageRequest({ prompt: "x" })).toEqual({ prompt: "x" })
    expect(AppPluginHostImages.toImageRequest({ prompt: "x", size: "auto", format: "webp", style: "flat", timeoutSeconds: 60 })).toEqual({
      prompt: "x",
      size: "auto",
      format: "webp",
      style: "flat",
      timeoutSeconds: 60,
    })
  })

  test("encodes the adapter output as base64 payload", () => {
    const payload = AppPluginHostImages.toImageResponse({
      data: new TextEncoder().encode("bild"),
      mime: "image/png",
      filename: "image.png",
    })
    expect(payload.ok).toBe(true)
    expect(payload.data).toBe(Buffer.from("bild").toString("base64"))
    expect(payload.bytes).toBe(4)
    expect(payload.mime).toBe("image/png")
  })

  test("generateImage passes through the provided adapter", async () => {
    const result = await Effect.runPromise(AppPluginHostImages.generateImage({ prompt: "x" }, adapter("ok")))
    expect(result.mime).toBe("image/png")
    try {
      await Effect.runPromise(AppPluginHostImages.generateImage({ prompt: "x" }, adapter("fail")))
      expect.unreachable()
    } catch (error) {
      expect(String(error)).toContain("valid image")
    }
  })
})
