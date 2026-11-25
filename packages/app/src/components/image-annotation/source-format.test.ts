import { expect, test } from "bun:test"
import { requireStaticImage } from "./source-format"

const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
function pngChunk(kind: string, data = new Uint8Array()) {
  const bytes = new Uint8Array(data.length + 12)
  new DataView(bytes.buffer).setUint32(0, data.length)
  bytes.set(new TextEncoder().encode(kind), 4)
  bytes.set(data, 8)
  return bytes
}
function webp(kind: string, data: Uint8Array) {
  const bytes = new Uint8Array(20 + data.length + data.length % 2)
  bytes.set(new TextEncoder().encode("RIFF"))
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true)
  bytes.set(new TextEncoder().encode("WEBP"), 8)
  bytes.set(new TextEncoder().encode(kind), 12)
  new DataView(bytes.buffer).setUint32(16, data.length, true)
  bytes.set(data, 20)
  return bytes
}
test("source validation uses bytes rather than a claimed MIME and rejects animation", async () => {
  expect(await requireStaticImage(new Blob([signature, pngChunk("IEND")]))).toBe("image/png")
  expect(await requireStaticImage(new Blob([new Uint8Array([255, 216, 255])]))).toBe("image/jpeg")
  expect(await requireStaticImage(new Blob([webp("VP8L", new Uint8Array([0]))]))).toBe("image/webp")
  for (const kind of ["acTL", "fcTL", "fdAT"]) {
    await expect(requireStaticImage(new Blob([signature, pngChunk(kind), pngChunk("IEND")]))).rejects.toThrow("Animated")
  }
  for (const kind of ["ANIM", "ANMF", "VP8X"]) {
    await expect(requireStaticImage(new Blob([webp(kind, new Uint8Array([2]))]))).rejects.toThrow("Animated")
  }
  await expect(requireStaticImage(new Blob(["<svg></svg>"], { type: "image/png" }))).rejects.toThrow("static")
  await expect(requireStaticImage(new Blob([signature]))).rejects.toThrow("incomplete")
  await expect(requireStaticImage(new Blob(["GIF89a"], { type: "image/png" }))).rejects.toThrow("static")
})
