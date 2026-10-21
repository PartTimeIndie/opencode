import { describe, expect, test } from "bun:test"
import { Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment } from "@opencode-ai/core/session/prompt"
import { VisionDelegation } from "@opencode-ai/core/session/runner/vision-delegation"
import { ConfigVision } from "@opencode-ai/core/config/vision"
import { DateTime, Schema } from "effect"

const created = DateTime.makeUnsafe(0)
// SVG is a real image type not in TOOL_RESULT_IMAGE_MIMES, so IMAGE_ONLY routes reject it
const imageFile = FileAttachment.create({ uri: "data:image/svg+xml,abc", mime: "image/svg+xml", name: "diagram.svg" })
const pngFile = FileAttachment.create({ uri: "data:image/png;base64,abc", mime: "image/png", name: "shot.png" })
const textFile = FileAttachment.create({ uri: "data:text/plain,hello", mime: "text/plain", name: "notes.txt" })

const userMessage = (files: FileAttachment[], description?: string) =>
  new SessionMessage.User({
    id: SessionMessage.ID.make("msg_1"),
    type: "user",
    text: "Describe this",
    files: files.map((file) => (description ? FileAttachment.create({ ...file, description }) : file)),
    time: { created },
  })

const visionConfig = (overrides?: Partial<ConfigVision.Info>): ConfigVision.Info =>
  Schema.decodeUnknownSync(ConfigVision.Info)({
    enabled: true,
    primary: { model: "openai/gpt-4o" },
    fallbacks: [{ model: "google/gemini-2.5-flash" }],
    ...overrides,
  })

// openai-chat route only accepts image MIME for user files, so it is a non-vision route for non-images
const nonVisionModel = Model.make({ id: "text-model", provider: "provider", route })
const visionModel = Model.make({ id: "vision-model", provider: "provider", route })

describe("VisionDelegation pure helpers", () => {
  test("pendingImages finds images the model cannot process", () => {
    const pending = VisionDelegation.pendingImages([userMessage([imageFile])], nonVisionModel)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.file.mime).toBe("image/svg+xml")
  })

  test("pendingImages skips images the model can process", () => {
    const pending = VisionDelegation.pendingImages([userMessage([pngFile])], visionModel)
    expect(pending).toHaveLength(0)
  })

  test("pendingImages finds PNG when catalog capabilities omit image input", () => {
    const pending = VisionDelegation.pendingImages([userMessage([pngFile])], visionModel, { input: ["text"] })
    expect(pending).toHaveLength(1)
  })

  test("pendingImages ignores non-image files", () => {
    const pending = VisionDelegation.pendingImages([userMessage([textFile])], nonVisionModel)
    expect(pending).toHaveLength(0)
  })

  test("pendingImages skips images that already have a description", () => {
    const pending = VisionDelegation.pendingImages([userMessage([imageFile], "already analyzed")], nonVisionModel)
    expect(pending).toHaveLength(0)
  })

  test("pendingImages returns empty when there are no messages with files", () => {
    const pending = VisionDelegation.pendingImages([], nonVisionModel)
    expect(pending).toHaveLength(0)
  })

  test("candidates returns primary followed by fallbacks", () => {
    const result = VisionDelegation.candidates(visionConfig())
    expect(result).toHaveLength(2)
    expect(result[0]?.model).toBe("openai/gpt-4o")
    expect(result[1]?.model).toBe("google/gemini-2.5-flash")
  })

  test("candidates returns empty when no primary configured", () => {
    const result = VisionDelegation.candidates({ enabled: true })
    expect(result).toHaveLength(0)
  })

  test("candidates includes variant from primary", () => {
    const result = VisionDelegation.candidates(visionConfig({ primary: { model: "openai/gpt-4o", variant: "low" } }))
    expect(result[0]?.variant).toBe("low")
  })

  test("visionRef builds a ModelV2.Ref from a candidate", () => {
    const ref = VisionDelegation.visionRef({ model: "anthropic/claude-sonnet-4-5", variant: "high" })
    expect(String(ref.id)).toBe("claude-sonnet-4-5")
    expect(String(ref.providerID)).toBe("anthropic")
    expect(String(ref.variant)).toBe("high")
  })

  test("visionRef omits variant when undefined", () => {
    const ref = VisionDelegation.visionRef({ model: "openai/gpt-4o" })
    expect(ref.variant).toBeUndefined()
  })

  test("buildPrompt substitutes user_message and image_name", () => {
    const result = VisionDelegation.buildPrompt(
      VisionDelegation.resolveTemplate(visionConfig()),
      "What colors do you see?",
      "photo.png",
    )
    expect(result).toContain("What colors do you see?")
  })

  test("resolveTemplate uses configured template when provided", () => {
    const result = VisionDelegation.resolveTemplate(visionConfig({ prompt_template: "Custom: {{user_message}}" }))
    expect(result).toBe("Custom: {{user_message}}")
  })

  test("resolveTemplate falls back to default when no template configured", () => {
    const result = VisionDelegation.resolveTemplate(undefined)
    expect(result).toContain("{{user_message}}")
  })

  test("withAnalysis writes description onto the matching file", () => {
    const enriched = VisionDelegation.withAnalysis(
      [userMessage([imageFile])],
      "msg_1",
      0,
      "A blue chart showing sales data.",
    )
    const user = enriched[0] as SessionMessage.User
    expect(user.files?.[0]?.description).toBe("A blue chart showing sales data.")
  })

  test("withAnalysis leaves other messages untouched", () => {
    const enriched = VisionDelegation.withAnalysis(
      [userMessage([imageFile])],
      "other_message",
      0,
      "analysis",
    )
    const user = enriched[0] as SessionMessage.User
    expect(user.files?.[0]?.description).toBeUndefined()
  })

  test("sidecarKey produces stable messageID:fileIndex key", () => {
    expect(VisionDelegation.sidecarKey("msg_1", 2)).toBe("msg_1:2")
  })

  test("decodeAnalyses accepts valid map", () => {
    const result = VisionDelegation.decodeAnalyses({ "msg_1:0": "description text" })
    expect(result["msg_1:0"]).toBe("description text")
  })

  test("decodeAnalyses returns empty for invalid input", () => {
    expect(VisionDelegation.decodeAnalyses("not an object")).toEqual({})
    expect(VisionDelegation.decodeAnalyses(null)).toEqual({})
    expect(VisionDelegation.decodeAnalyses(undefined)).toEqual({})
  })

  test("decodeAnalyses filters non-string values", () => {
    const result = VisionDelegation.decodeAnalyses({ valid: "ok", invalid: 123 })
    expect(result.valid).toBe("ok")
    expect(result.invalid).toBeUndefined()
  })
})
