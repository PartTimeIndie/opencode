export * as AppPluginHostImages from "./host-images"

import { Effect } from "effect"
import { ImageGeneration } from "@opencode-ai/core/image-generation"

// App plugins reach image generation through the same Codex adapter that the
// image_generate agent tool registers; this module only narrows the surface the
// plugin host route exposes and keeps validation testable without spawning the
// Codex CLI.
export const MAX_PROMPT_CHARS = 4_000

export type ImageGenerateInput = {
  prompt: string
  size?: string
  style?: string
  format?: string
  timeoutSeconds?: number
}

export function validateImageInput(input: ImageGenerateInput): string | undefined {
  if (typeof input.prompt !== "string" || !input.prompt.trim()) return "Expected prompt"
  if (input.prompt.length > MAX_PROMPT_CHARS) return `Prompt exceeds ${MAX_PROMPT_CHARS} characters`
  if (input.size !== undefined && !(ImageGeneration.sizes as readonly string[]).includes(input.size))
    return `Unsupported image size: ${input.size}`
  if (input.format !== undefined && !(ImageGeneration.formats as readonly string[]).includes(input.format))
    return `Unsupported image format: ${input.format}`
  if (
    input.timeoutSeconds !== undefined &&
    (typeof input.timeoutSeconds !== "number" || input.timeoutSeconds < 30 || input.timeoutSeconds > 900)
  )
    return "timeoutSeconds must be between 30 and 900"
  return undefined
}

export function toImageRequest(input: ImageGenerateInput): ImageGeneration.Input {
  return {
    prompt: input.prompt,
    ...(input.size !== undefined ? { size: input.size as ImageGeneration.Input["size"] } : {}),
    ...(input.style !== undefined ? { style: input.style } : {}),
    ...(input.format !== undefined ? { format: input.format as ImageGeneration.Input["format"] } : {}),
    ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
  }
}

export const generateImage = (input: ImageGeneration.Input, adapter?: ImageGeneration.Adapter) =>
  adapter
    ? adapter.generate(input)
    : Effect.gen(function* () {
        const images = yield* ImageGeneration.Service
        return yield* images.generate(input)
      }).pipe(Effect.provide(ImageGeneration.layer))

export function toImageResponse(result: ImageGeneration.Output) {
  return {
    ok: true as const,
    mime: result.mime,
    data: Buffer.from(result.data).toString("base64"),
    filename: result.filename,
    bytes: result.data.byteLength,
  }
}
