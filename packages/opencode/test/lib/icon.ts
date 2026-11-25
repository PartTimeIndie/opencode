import { PhotonImage } from "@silvia-odwyer/photon-node"

type RGB = [red: number, green: number, blue: number]

/** Renders a real raster image so icon normalization runs through the actual decoder. */
export function rasterIcon(edge = 1024, mime: "png" | "jpeg" = "png") {
  const rgba = new Uint8Array(edge * edge * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = (i / 4) % 256
    rgba[i + 1] = 90
    rgba[i + 2] = 40
    rgba[i + 3] = 255
  }
  const image = new PhotonImage(rgba, edge, edge)
  try {
    const data = mime === "jpeg" ? image.get_bytes_jpeg(90) : image.get_bytes()
    return `data:image/${mime};base64,${Buffer.from(data).toString("base64")}`
  } finally {
    image.free()
  }
}

export function rasterSize(dataUrl: string) {
  const image = PhotonImage.new_from_byteslice(new Uint8Array(Buffer.from(dataUrl.split(",")[1]!, "base64")))
  try {
    return { width: image.get_width(), height: image.get_height() }
  } finally {
    image.free()
  }
}

/** A multi-colored "model result": a flat background, a two-colored glyph and a white patch. */
export function multicolorIcon() {
  const edge = 64
  const rgba = new Uint8Array(edge * edge * 4)
  for (let y = 0; y < edge; y++)
    for (let x = 0; x < edge; x++) {
      const color: RGB =
        x < 8 && y < 8
          ? [255, 255, 255]
          : x > 15 && x < 48 && y > 15 && y < 48
            ? y < 32
              ? [250, 220, 40]
              : [40, 200, 90]
            : [30, 90, 200]
      rgba.set([...color, 255], (y * edge + x) * 4)
    }
  const image = new PhotonImage(rgba, edge, edge)
  try {
    return image.get_bytes()
  } finally {
    image.free()
  }
}
