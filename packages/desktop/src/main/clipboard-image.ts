import type { NativeImage } from "electron"

type ClipboardImageItem = {
  types: readonly string[]
  getType(type: string): Promise<unknown>
}

export async function readClipboardPng(
  read: () => Promise<readonly ClipboardImageItem[]>,
  decode: (buffer: Buffer) => Pick<NativeImage, "isEmpty" | "toPNG" | "getSize">,
) {
  const items = await read()
  const candidates = items.flatMap((item) => item.types
    .filter((type) => type.startsWith("image/"))
    .map((type) => ({ item, type })))
  const candidate = candidates.find((entry) => entry.type === "image/png") ?? candidates[0]
  if (!candidate) return null
  const blob = await candidate.item.getType(candidate.type)
  if (!(blob instanceof Blob)) return null
  const image = decode(Buffer.from(await blob.arrayBuffer()))
  if (image.isEmpty()) return null
  // Keep the attachment contract PNG-only even if the clipboard offers JPEG.
  const size = image.getSize()
  return { buffer: image.toPNG(), width: size.width, height: size.height }
}
