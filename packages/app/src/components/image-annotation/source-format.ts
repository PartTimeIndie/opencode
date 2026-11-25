// Never silently flatten an animation or render an active document (such as SVG).
// MIME alone is not evidence: clipboard and local-file metadata can be incorrect.
export async function requireStaticImage(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(bytes.buffer)
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length))
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 8 && bytes.subarray(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset)
      const kind = text(offset + 4, 4)
      if (offset + 12 + length > bytes.length) break
      if (["acTL", "fcTL", "fdAT"].includes(kind)) throw new Error("Animated images cannot be annotated. Use a static PNG, JPEG or WebP image.")
      if (kind === "IEND") return "image/png"
      offset += 12 + length
    }
    throw new Error("PNG image is incomplete")
  }
  if (bytes.length >= 12 && text(0, 4) === "RIFF" && text(8, 4) === "WEBP" && view.getUint32(4, true) + 8 === bytes.length) {
    let image = false
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = view.getUint32(offset + 4, true)
      const kind = text(offset, 4)
      if (offset + 8 + length > bytes.length) throw new Error("WebP image is incomplete")
      if (["ANIM", "ANMF"].includes(kind) || (kind === "VP8X" && length > 0 && (bytes[offset + 8] & 2))) throw new Error("Animated images cannot be annotated. Use a static PNG, JPEG or WebP image.")
      if (kind === "VP8 " || kind === "VP8L") image = true
      offset += 8 + length + (length % 2)
    }
    if (image) return "image/webp"
  }
  throw new Error("Only static PNG, JPEG and WebP images can be annotated")
}
