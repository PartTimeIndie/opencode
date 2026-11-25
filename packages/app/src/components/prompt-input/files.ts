import { ACCEPTED_FILE_TYPES, ACCEPTED_IMAGE_TYPES } from "@/constants/file-picker"

export { ACCEPTED_FILE_TYPES }

type AttachmentPicker = (
  options: {
    defaultPath?: string
    multiple?: boolean
    accept?: string[]
  },
  onFile: (file: File) => Promise<unknown>,
) => Promise<void>

export function pickAttachmentFiles(input: {
  picker?: AttachmentPicker
  directory: () => string
  fallback: () => void
  onFile: (file: File) => Promise<unknown>
  onError: (error: unknown) => void
}) {
  if (!input.picker) {
    input.fallback()
    return
  }
  void input
    .picker(
      {
        defaultPath: input.directory(),
        multiple: true,
        accept: ACCEPTED_FILE_TYPES,
      },
      input.onFile,
    )
    .catch(input.onError)
}

const clipboardContents = new WeakMap<File, Promise<Uint8Array>>()

function clipboardBytes(file: File) {
  const cached = clipboardContents.get(file)
  if (cached) return cached
  const value = file.arrayBuffer().then((buffer) => new Uint8Array(buffer))
  clipboardContents.set(file, value)
  return value
}

export async function sameClipboardFile(first: File, second: File) {
  if (first.size !== second.size) return false
  if (first.size === 0) return first.name === second.name && first.type === second.type
  const [firstBytes, secondBytes] = await Promise.all([clipboardBytes(first), clipboardBytes(second)])
  return firstBytes.every((byte, index) => byte === secondBytes[index])
}

export async function uniqueClipboardFiles(files: File[]) {
  const seen = new Map<number, File[]>()
  const unique: File[] = []

  for (const file of files) {
    const matches = seen.get(file.size) ?? []
    const duplicate = (await Promise.all(matches.map((match) => sameClipboardFile(match, file)))).some(Boolean)
    if (duplicate) continue
    seen.set(file.size, [...matches, file])
    unique.push(file)
  }

  return unique
}

const IMAGE_MIMES = new Set(ACCEPTED_IMAGE_TYPES)
const IMAGE_EXTS = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])
const MEDIA_EXTS = new Map([
  ["avi", "video/x-msvideo"],
  ["m4a", "audio/mp4"],
  ["m4v", "video/mp4"],
  ["mkv", "video/x-matroska"],
  ["mov", "video/quicktime"],
  ["mp3", "audio/mpeg"],
  ["mp4", "video/mp4"],
  ["oga", "audio/ogg"],
  ["ogg", "audio/ogg"],
  ["ogv", "video/ogg"],
  ["wav", "audio/wav"],
  ["webm", "video/webm"],
])
const TEXT_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
])

const SAMPLE = 4096

function kind(type: string) {
  return type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

function ext(name: string) {
  const idx = name.lastIndexOf(".")
  if (idx === -1) return ""
  return name.slice(idx + 1).toLowerCase()
}

function textMime(type: string) {
  if (!type) return false
  if (type.startsWith("text/")) return true
  if (TEXT_MIMES.has(type)) return true
  if (type.endsWith("+json")) return true
  return type.endsWith("+xml")
}

function textBytes(bytes: Uint8Array) {
  if (bytes.length === 0) return true
  let count = 0
  for (const byte of bytes) {
    if (byte === 0) return false
    if (byte < 9 || (byte > 13 && byte < 32)) count += 1
  }
  return count / bytes.length <= 0.3
}

export async function attachmentMime(file: File) {
  const type = kind(file.type)
  // Archives must never be mistaken for text just because their header is
  // short or printable. Extraction is a separate, explicit user choice.
  if (/\.7z$/i.test(file.name)) return "application/x-7z-compressed"
  if (/\.zip$/i.test(file.name)) return "application/zip"
  if (/\.tar$/i.test(file.name)) return "application/x-tar"
  if (/\.(tgz|tar\.gz)$/i.test(file.name)) return "application/gzip"
  if (/\.tar\.bz2$/i.test(file.name)) return "application/x-bzip2"
  if (/\.tar\.xz$/i.test(file.name)) return "application/x-xz"
  if (IMAGE_MIMES.has(type)) return type
  if (type === "application/pdf") return type

  const suffix = ext(file.name)
  const fallback =
    IMAGE_EXTS.get(suffix) ?? MEDIA_EXTS.get(suffix) ?? (suffix === "pdf" ? "application/pdf" : undefined)
  if ((!type || type === "application/octet-stream") && fallback) return fallback

  if (textMime(type)) return "text/plain"
  const bytes = new Uint8Array(await file.slice(0, SAMPLE).arrayBuffer())
  if (textBytes(bytes)) return "text/plain"
  return type || "application/octet-stream"
}
