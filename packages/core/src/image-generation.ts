export * as ImageGeneration from "./image-generation"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "./effect/layer-node"

export const formats = ["png", "jpg", "webp"] as const
export const sizes = ["1024x1024", "1024x1536", "1536x1024", "auto"] as const

export type Input = {
  readonly prompt: string
  readonly size?: (typeof sizes)[number]
  readonly style?: string
  readonly format?: (typeof formats)[number]
  readonly model?: string
  readonly timeoutSeconds?: number
}

export type Output = {
  readonly data: Uint8Array
  readonly mime: "image/png" | "image/jpeg" | "image/webp"
  readonly filename: string
}

export class GenerateError extends Schema.TaggedErrorClass<GenerateError>()("ImageGeneration.GenerateError", {
  message: Schema.String,
}) {}

export interface Adapter {
  readonly generate: (input: Input) => Effect.Effect<Output, GenerateError>
}

export class Service extends Context.Service<Service, Adapter>()("@opencode/ImageGeneration") {}

export const layer = Layer.effect(
  Service,
  Effect.promise(() => import("./image-generation/codex")).pipe(Effect.map((module) => Service.of(module.adapter))),
)

export const defaultLayer = layer
export const node = LayerNode.make(layer, [])

export const thumbnail = Effect.fn("ImageGeneration.thumbnail")(function* (input: Output, size: number) {
  yield* Effect.tryPromise({
    try: () => import("./image/photon"),
    catch: () => new GenerateError({ message: "Image resizer is unavailable" }),
  })
  const photon = yield* Effect.tryPromise({
    try: () => import("@silvia-odwyer/photon-node"),
    catch: () => new GenerateError({ message: "Image resizer is unavailable" }),
  })
  const decoded = yield* Effect.try({
    try: () => photon.PhotonImage.new_from_byteslice(input.data),
    catch: () => new GenerateError({ message: "Generated image could not be decoded" }),
  })
  try {
    const edge = Math.min(decoded.get_width(), decoded.get_height())
    const left = Math.floor((decoded.get_width() - edge) / 2)
    const top = Math.floor((decoded.get_height() - edge) / 2)
    const cropped = photon.crop(decoded, left, top, left + edge, top + edge)
    try {
      const resized = photon.resize(cropped, size, size, photon.SamplingFilter.Lanczos3)
      try {
        const png = resized.get_bytes()
        if (Buffer.byteLength(Buffer.from(png).toString("base64"), "utf8") <= 256 * 1024)
          return { data: png, mime: "image/png", filename: input.filename.replace(/\.[^.]+$/, ".png") } satisfies Output
        const jpeg = resized.get_bytes_jpeg(85)
        if (Buffer.byteLength(Buffer.from(jpeg).toString("base64"), "utf8") <= 256 * 1024)
          return { data: jpeg, mime: "image/jpeg", filename: input.filename.replace(/\.[^.]+$/, ".jpg") } satisfies Output
        return yield* new GenerateError({ message: "Normalized image exceeds the project icon size limit" })
      } finally {
        resized.free()
      }
    } finally {
      cropped.free()
    }
  } finally {
    decoded.free()
  }
})
