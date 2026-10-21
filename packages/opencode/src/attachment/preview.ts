import { Global } from "@opencode-ai/core/global"
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ProofAttachment } from "./proof"

export const MAX_BYTES = 256 * 1024
const MAX_DIMENSION = 512
const MAX_THUMBNAIL_SOURCE_BYTES = 32 * 1024 * 1024
const VERSION = "v1"
const JPEG_QUALITIES = [80, 65, 50, 35]

export type Result = {
  readonly bytes: Uint8Array
  readonly mime: string
  readonly sourceBytes: number
  readonly truncated: boolean
  readonly representation: "original" | "thumbnail" | "prefix" | "placeholder"
}

export async function create(input: {
  readonly path: string
  readonly sha256: string
  readonly mime: string
  readonly name?: string
  readonly sizeBytes: number
}): Promise<Result> {
  if (input.mime.toLowerCase().startsWith("image/")) return image(input)
  const bytes = input.sizeBytes
    ? new Uint8Array(
        await ProofAttachment.readBytes(input.path, { start: 0, end: Math.min(input.sizeBytes, MAX_BYTES) - 1 }),
      )
    : new Uint8Array()
  return {
    bytes,
    mime: input.mime,
    sourceBytes: input.sizeBytes,
    truncated: bytes.byteLength < input.sizeBytes,
    representation: bytes.byteLength < input.sizeBytes ? "prefix" : "original",
  }
}

async function image(input: {
  readonly path: string
  readonly sha256: string
  readonly mime: string
  readonly name?: string
  readonly sizeBytes: number
}) {
  const mime = input.mime.toLowerCase()
  if (input.sizeBytes <= MAX_BYTES && mime !== "image/svg+xml")
    return {
      bytes: new Uint8Array(await readFile(input.path)),
      mime: input.mime,
      sourceBytes: input.sizeBytes,
      truncated: false,
      representation: "original" as const,
    }

  const cached = await cachedThumbnail(input.sha256)
  if (cached)
    return {
      ...cached,
      sourceBytes: input.sizeBytes,
      truncated: true,
      representation: "thumbnail" as const,
    }

  const thumbnail =
    input.sizeBytes <= MAX_THUMBNAIL_SOURCE_BYTES
      ? await generateThumbnail(input.path).catch(() => undefined)
      : undefined
  if (thumbnail) {
    await publishThumbnail(input.sha256, thumbnail).catch(() => undefined)
    return {
      ...thumbnail,
      sourceBytes: input.sizeBytes,
      truncated: true,
      representation: "thumbnail" as const,
    }
  }

  return {
    bytes: placeholder(input.name),
    mime: "image/svg+xml",
    sourceBytes: input.sizeBytes,
    truncated: true,
    representation: "placeholder" as const,
  }
}

async function generateThumbnail(source: string) {
  ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
    path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
  const photon = await import("@silvia-odwyer/photon-node")
  const decoded = photon.PhotonImage.new_from_byteslice(await readFile(source))
  try {
    const scale = Math.min(1, MAX_DIMENSION / decoded.get_width(), MAX_DIMENSION / decoded.get_height())
    const sizes = Array.from({ length: 8 }).reduce<Array<{ width: number; height: number }>>((items) => {
      const previous = items.at(-1) ?? {
        width: Math.max(1, Math.round(decoded.get_width() * scale)),
        height: Math.max(1, Math.round(decoded.get_height() * scale)),
      }
      const next = items.length
        ? {
            width: Math.max(1, Math.floor(previous.width * 0.75)),
            height: Math.max(1, Math.floor(previous.height * 0.75)),
          }
        : previous
      return items.some((item) => item.width === next.width && item.height === next.height) ? items : [...items, next]
    }, [])

    for (const size of sizes) {
      const resized = photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
      try {
        const png = resized.get_bytes()
        if (png.byteLength <= MAX_BYTES) return { bytes: new Uint8Array(png), mime: "image/png" }
        for (const quality of JPEG_QUALITIES) {
          const jpeg = resized.get_bytes_jpeg(quality)
          if (jpeg.byteLength <= MAX_BYTES) return { bytes: new Uint8Array(jpeg), mime: "image/jpeg" }
        }
      } finally {
        resized.free()
      }
    }
  } finally {
    decoded.free()
  }
}

async function cachedThumbnail(sha256: string) {
  for (const mime of ["image/png", "image/jpeg"] as const) {
    const target = cachePath(sha256, mime)
    const info = await stat(target).catch(() => undefined)
    if (!info?.isFile() || info.size > MAX_BYTES) continue
    const bytes = await readFile(target).catch(() => undefined)
    if (bytes) return { bytes: new Uint8Array(bytes), mime }
  }
}

async function publishThumbnail(sha256: string, thumbnail: { readonly bytes: Uint8Array; readonly mime: string }) {
  const target = cachePath(sha256, thumbnail.mime)
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${crypto.randomUUID()}`
  await writeFile(temporary, thumbnail.bytes)
  await rename(temporary, target).catch(async () => {
    await rm(temporary, { force: true })
  })
}

export function cachePath(sha256: string, mime: string) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Attachment preview cache key is not a SHA-256 digest")
  const extension = mime === "image/png" ? "png" : "jpg"
  return path.join(Global.Path.cache, "attachment-previews", sha256.slice(0, 2), `${sha256}.${VERSION}.${extension}`)
}

function placeholder(name?: string) {
  const label = (name ?? "Image preview unavailable")
    .slice(0, 80)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="320" viewBox="0 0 512 320"><rect width="512" height="320" rx="16" fill="#171b22"/><path d="M176 220l58-70 42 50 30-35 48 55H176zm16-104a22 22 0 1 0 0-44 22 22 0 0 0 0 44z" fill="#77808f"/><text x="256" y="268" fill="#aab1bd" font-family="sans-serif" font-size="16" text-anchor="middle">${label}</text></svg>`,
  )
}

export * as AttachmentPreview from "./preview"
