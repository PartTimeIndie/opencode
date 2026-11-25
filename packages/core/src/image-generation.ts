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
  // gif is accepted as an input only; thumbnails are always png or jpeg.
  readonly mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif"
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

const decode = Effect.fn("ImageGeneration.decode")(function* (input: Output) {
  yield* Effect.tryPromise({
    try: () => import("./image/photon"),
    catch: () => new GenerateError({ message: "Image resizer is unavailable" }),
  })
  const photon = yield* Effect.tryPromise({
    try: () => import("@silvia-odwyer/photon-node"),
    catch: () => new GenerateError({ message: "Image resizer is unavailable" }),
  })
  const image = yield* Effect.try({
    try: () => photon.PhotonImage.new_from_byteslice(input.data),
    catch: () => new GenerateError({ message: "Generated image could not be decoded" }),
  })
  return { photon, image }
})

export const thumbnail = Effect.fn("ImageGeneration.thumbnail")(function* (input: Output, size: number) {
  const { photon, image: decoded } = yield* decode(input)
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

type RGB = readonly [red: number, green: number, blue: number]

const WHITE: RGB = [255, 255, 255]
const BLACK: RGB = [0, 0, 0]

// Project icons are two-tone by contract: one flat background color and one symbol color.
// Image models still return shading or extra colors, so every pixel is moved onto the
// background-to-symbol line; anti-aliased edges stay smooth because they already lie on it.
export const twoTone = Effect.fn("ImageGeneration.twoTone")(function* (input: Output) {
  const { photon, image } = yield* decode(input)
  try {
    const source = image.get_raw_pixels()
    const background = dominant(source)
    const symbol = contrast(background, WHITE) >= contrast(background, BLACK) ? WHITE : BLACK
    const result = new photon.PhotonImage(restrict(source, background, symbol), image.get_width(), image.get_height())
    try {
      return {
        data: result.get_bytes(),
        mime: "image/png",
        filename: input.filename.replace(/\.[^.]+$/, ".png"),
      } satisfies Output
    } finally {
      result.free()
    }
  } finally {
    image.free()
  }
})

// The background is the most frequent coarse color bucket, averaged so compression noise
// cannot shift it while a flat background stays exact.
function dominant(pixels: Uint8Array): RGB {
  const buckets = new Map<number, [count: number, red: number, green: number, blue: number]>()
  for (let index = 0; index < pixels.length; index += 4) {
    const key = ((pixels[index] >> 4) << 8) | ((pixels[index + 1] >> 4) << 4) | (pixels[index + 2] >> 4)
    const bucket = buckets.get(key) ?? [0, 0, 0, 0]
    bucket[0] += 1
    bucket[1] += pixels[index]
    bucket[2] += pixels[index + 1]
    bucket[3] += pixels[index + 2]
    buckets.set(key, bucket)
  }
  const best = [...buckets.values()].reduce((first, second) => (second[0] > first[0] ? second : first))
  return [Math.round(best[1] / best[0]), Math.round(best[2] / best[0]), Math.round(best[3] / best[0])]
}

// WCAG contrast; the symbol is whichever of white or black separates more from the background.
function contrast(first: RGB, second: RGB) {
  const x = luminance(first) + 0.05
  const y = luminance(second) + 0.05
  return x > y ? x / y : y / x
}

function luminance([red, green, blue]: RGB) {
  const linear = (value: number) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
}

// Image models scatter faint noise over flat areas; a plain projection would keep dozens of
// near-identical background colors. Coverage this close to either end snaps to exactly that
// color, while anti-aliased edges stay soft.
const NOISE = 0.05

function restrict(pixels: Uint8Array, background: RGB, symbol: RGB) {
  const [r0, g0, b0] = background
  const [r1, g1, b1] = symbol
  const dr = r1 - r0
  const dg = g1 - g0
  const db = b1 - b0
  const length = dr * dr + dg * dg + db * db
  const output = new Uint8Array(pixels.length)
  for (let index = 0; index < pixels.length; index += 4) {
    const offset = (pixels[index] - r0) * dr + (pixels[index + 1] - g0) * dg + (pixels[index + 2] - b0) * db
    const t = Math.min(1, Math.max(0, offset / length))
    const coverage = t < NOISE ? 0 : t > 1 - NOISE ? 1 : t
    output[index] = Math.round(r0 + coverage * dr)
    output[index + 1] = Math.round(g0 + coverage * dg)
    output[index + 2] = Math.round(b0 + coverage * db)
    output[index + 3] = 255
  }
  return output
}
