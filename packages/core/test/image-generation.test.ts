import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ImageGeneration } from "@opencode-ai/core/image-generation"
import { PhotonImage } from "@silvia-odwyer/photon-node"

test("project icon thumbnail is bounded to 128 pixels", async () => {
  const photon = await import("@silvia-odwyer/photon-node")
  const source = new photon.PhotonImage(
    new Uint8Array(Array.from({ length: 256 * 256 * 4 }, (_, index) => (index % 4 === 3 ? 255 : index % 251))),
    256,
    256,
  )
  const result = await Effect.runPromise(
    ImageGeneration.thumbnail(
      { data: source.get_bytes(), mime: "image/png", filename: "generated.png" },
      128,
    ),
  )
  const thumbnail = photon.PhotonImage.new_from_byteslice(result.data)

  source.free()
  expect(thumbnail.get_width()).toBe(128)
  expect(thumbnail.get_height()).toBe(128)
  expect(result.mime).toBe("image/png")
  thumbnail.free()
})

type RGB = [red: number, green: number, blue: number]

const DARK: RGB = [30, 90, 200]
const LIGHT: RGB = [248, 244, 232]

function raster(width: number, height: number, paint: (x: number, y: number) => RGB) {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [red, green, blue] = paint(x, y)
      const index = (y * width + x) * 4
      rgba[index] = red
      rgba[index + 1] = green
      rgba[index + 2] = blue
      rgba[index + 3] = 255
    }
  const image = new PhotonImage(rgba, width, height)
  try {
    return image.get_bytes()
  } finally {
    image.free()
  }
}

async function twoTone(data: Uint8Array, filename = "generated.png") {
  const result = await Effect.runPromise(ImageGeneration.twoTone({ data, mime: "image/png", filename }))
  const image = PhotonImage.new_from_byteslice(result.data)
  try {
    return { result, width: image.get_width(), height: image.get_height(), pixels: image.get_raw_pixels() }
  } finally {
    image.free()
  }
}

function pixel(pixels: Uint8Array, x: number, y: number, width: number): RGB {
  const index = (y * width + x) * 4
  return [pixels[index], pixels[index + 1], pixels[index + 2]]
}

// Largest distance of any pixel from the known background→symbol line, and how many
// tones remain once every pixel is collapsed onto the nearer end of that line.
function tones(pixels: Uint8Array, background: RGB, symbol: RGB) {
  const d = symbol.map((value, index) => value - background[index])
  const length = d[0] ** 2 + d[1] ** 2 + d[2] ** 2
  let residual = 0
  const core = new Set<string>()
  for (let index = 0; index < pixels.length; index += 4) {
    const p = [pixels[index], pixels[index + 1], pixels[index + 2]]
    const t = ((p[0] - background[0]) * d[0] + (p[1] - background[1]) * d[1] + (p[2] - background[2]) * d[2]) / length
    residual = Math.max(
      residual,
      Math.hypot(p[0] - (background[0] + t * d[0]), p[1] - (background[1] + t * d[1]), p[2] - (background[2] + t * d[2])),
    )
    core.add(t < 0.5 ? "background" : "symbol")
  }
  return { residual, core }
}

function contrast(first: RGB, second: RGB) {
  const luminance = ([red, green, blue]: RGB) =>
    0.2126 * (red / 255) ** 2.2 + 0.7152 * (green / 255) ** 2.2 + 0.0722 * (blue / 255) ** 2.2
  const [high, low] = [luminance(first) + 0.05, luminance(second) + 0.05].sort((a, b) => b - a)
  return high / low
}

test("two-tone keeps the dominant background and removes every other hue", async () => {
  // A flat background, a white patch and a two-colored glyph: the glyph must collapse onto
  // the background→white line while background and white stay exactly where they were.
  const source = raster(64, 64, (x, y) => {
    if (x < 6 && y < 6) return [255, 255, 255]
    if (x > 15 && x < 48 && y > 15 && y < 48) return y < 32 ? [250, 220, 40] : [40, 200, 90]
    return DARK
  })
  const { result, width, height, pixels } = await twoTone(source, "generated.jpg")

  expect(result.mime).toBe("image/png")
  expect(result.filename).toBe("generated.png")
  expect([width, height]).toEqual([64, 64])
  expect(pixel(pixels, 60, 60, 64)).toEqual(DARK)
  expect(pixel(pixels, 5, 5, 64)).toEqual([255, 255, 255])
  const dark = tones(pixels, DARK, [255, 255, 255])
  expect(dark.residual).toBeLessThanOrEqual(1.5)
  expect([...dark.core].sort()).toEqual(["background", "symbol"])
  expect(contrast(DARK, [255, 255, 255])).toBeGreaterThanOrEqual(4.5)
})

test("two-tone picks a dark symbol on a light background", async () => {
  const source = raster(48, 48, (x, y) => {
    if (x > 40 && y > 40) return [0, 0, 0]
    if (x > 10 && x < 38 && y > 10 && y < 38) return [40, 110, 220]
    return LIGHT
  })
  const { pixels } = await twoTone(source)

  expect(pixel(pixels, 44, 44, 48)).toEqual([0, 0, 0])
  expect(pixel(pixels, 2, 2, 48)).toEqual(LIGHT)
  const light = tones(pixels, LIGHT, [0, 0, 0])
  expect(light.residual).toBeLessThanOrEqual(1.5)
  expect(light.core.size).toBe(2)
  expect(contrast(LIGHT, [0, 0, 0])).toBeGreaterThanOrEqual(4.5)
})

test("two-tone leaves an already two-tone icon untouched", async () => {
  const background: RGB = [200, 30, 60]
  const edge: RGB = [228, 143, 158]
  const source = raster(32, 32, (x, y) => {
    if (x > 11 && x < 21 && y > 11 && y < 21) return [255, 255, 255]
    if (x > 7 && x < 25 && y > 7 && y < 25) return edge
    return background
  })
  const original = PhotonImage.new_from_byteslice(source)
  const before = original.get_raw_pixels()
  original.free()
  const { pixels } = await twoTone(source)

  for (let index = 0; index < pixels.length; index++) expect(Math.abs(pixels[index] - before[index])).toBeLessThanOrEqual(1)
})

test("two-tone flattens model noise but keeps soft edges", async () => {
  // ±3 noise around the background and 254 instead of 255 must each collapse onto exactly one
  // color; a genuine anti-aliased edge (t ≈ 0.45) lies outside the noise band and stays as is.
  const background: RGB = [200, 40, 100]
  const edge: RGB = [225, 137, 170]
  const source = raster(40, 40, (x, y) => {
    const noise = (x * 3 + y * 5) % 7 - 3
    if (x < 8 && y < 8) return (x + y) % 2 ? [255, 254, 255] : [254, 255, 255]
    if (y > 17 && y < 22) return edge
    return [background[0] + noise, background[1] + noise, background[2] + noise]
  })
  const { pixels } = await twoTone(source)

  const flat = new Set<string>()
  for (let y = 0; y < 40; y++)
    for (let x = 0; x < 40; x++) {
      if (x < 8 && y < 8) expect(pixel(pixels, x, y, 40)).toEqual([255, 255, 255])
      else if (y > 17 && y < 22) expect(pixel(pixels, x, y, 40)).toEqual(edge)
      else flat.add(pixel(pixels, x, y, 40).join(","))
    }
  expect(flat.size).toBe(1)
  const flattened = [...flat][0]!.split(",").map(Number)
  expect(flattened.map((channel, index) => Math.abs(channel - background[index]))).toEqual([0, 0, 0])
})

test("two-tone reports undecodable images", async () => {
  const failure = await Effect.runPromise(
    Effect.flip(ImageGeneration.twoTone({ data: new Uint8Array([1, 2, 3]), mime: "image/png", filename: "generated.png" })),
  )

  expect(failure._tag).toBe("ImageGeneration.GenerateError")
})
