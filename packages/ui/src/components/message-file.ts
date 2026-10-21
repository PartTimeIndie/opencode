import type { FilePart } from "@opencode-ai/sdk/v2"

export function attached(part: FilePart) {
  return part.url.startsWith("data:") || part.url.startsWith("attachment://")
}

export function inline(part: FilePart) {
  if (attached(part)) return false
  return part.source?.text?.start !== undefined && part.source?.text?.end !== undefined
}

export function kind(part: FilePart): "image" | "video" | "audio" | "file" {
  const mime = resolvedMime(part)
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("video/")) return "video"
  if (mime.startsWith("audio/")) return "audio"
  return "file"
}

export function resolvedMime(part: Pick<FilePart, "mime" | "url">) {
  return (part.mime || part.url.match(/^data:([^;,]+)/)?.[1] || "").toLowerCase()
}

export function contentUrl(part: FilePart) {
  return managedUrl(part, "content")
}

export function previewUrl(part: FilePart) {
  return managedUrl(part, "preview")
}

function managedUrl(part: FilePart, representation: "content" | "preview") {
  if (!part.url.startsWith("attachment://")) return part.url
  const id = part.url.slice("attachment://".length)
  return `/app/attachment/${representation}/${encodeURIComponent(id)}?sessionID=${encodeURIComponent(part.sessionID)}`
}
