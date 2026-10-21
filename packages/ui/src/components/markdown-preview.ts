import type { FileContent } from "@opencode-ai/sdk/v2"

export type MarkdownFileReader = (path: string) => Promise<FileContent | undefined>

export const markdownPreviewMaxBytes = 2 * 1024 * 1024

export class MarkdownPreviewError extends Error {
  constructor(
    readonly code: "path" | "reader" | "text" | "url" | "size" | "http",
    readonly status?: number,
  ) {
    super(
      {
        path: "Unsupported Markdown preview path",
        reader: "Markdown preview needs a session file reader",
        text: "Markdown file could not be read as text",
        url: "Unsupported Markdown preview URL",
        size: "Markdown preview is too large (maximum 2 MiB)",
        http: `Request failed with status ${status}`,
      }[code],
    )
  }
}

export function markdownPreviewPath(href: string) {
  const decoded = (() => {
    try {
      return decodeURIComponent(href.split(/[?#]/, 1)[0]).replace(/\\/g, "/")
    } catch {
      throw new MarkdownPreviewError("path")
    }
  })()
  const segments = decoded.split("/").filter((segment) => segment && segment !== ".")
  if (!segments.length || decoded.startsWith("//") || /[\u0000-\u001f\u007f:]/.test(decoded) || segments.includes(".."))
    throw new MarkdownPreviewError("path")
  return segments.join("/")
}

// A remote document owns its relative URLs; project documents use project-root paths.
export function markdownPreviewTarget(href: string, base: string, source?: string) {
  const value = href.trim()
  if (!value || /^[A-Za-z]:[\\/]/.test(value)) throw new MarkdownPreviewError("path")
  if (!source && !/^(?:https?:)?\/\//i.test(value) && !/^[a-z][a-z0-9+.-]*:/i.test(value))
    return { path: markdownPreviewPath(value) }
  const url = (() => {
    try {
      return new URL(value, source ?? base)
    } catch {
      throw new MarkdownPreviewError("url")
    }
  })()
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new MarkdownPreviewError("url")
  return { url }
}

export async function loadMarkdownPreview(input: {
  href: string
  base: string
  source?: string
  signal?: AbortSignal
  readFile?: MarkdownFileReader
  fetch?: (url: URL, init: RequestInit) => Promise<Response>
}) {
  input.signal?.throwIfAborted()
  const target = markdownPreviewTarget(input.href, input.base, input.source)
  if (target.path !== undefined) {
    if (!input.readFile) throw new MarkdownPreviewError("reader")
    const file = await input.readFile(target.path)
    input.signal?.throwIfAborted()
    if (!file || file.type !== "text" || file.encoding) throw new MarkdownPreviewError("text")
    if (new TextEncoder().encode(file.content).byteLength > markdownPreviewMaxBytes)
      throw new MarkdownPreviewError("size")
    return file.content
  }
  const origin = (() => {
    try {
      return new URL(input.base).origin
    } catch {
      throw new MarkdownPreviewError("url")
    }
  })()
  const response = await (input.fetch ?? fetch)(target.url!, {
    credentials: target.url!.origin === origin ? "include" : "omit",
    signal: input.signal,
  })
  if (!response.ok) throw new MarkdownPreviewError("http", response.status)
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      input.signal?.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > markdownPreviewMaxBytes) throw new MarkdownPreviewError("size")
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const content = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    content.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(content)
}

export async function loadMarkdownPreviewImage(input: {
  href: string
  base: string
  source?: string
  signal: AbortSignal
  readFile?: MarkdownFileReader
}) {
  const target = markdownPreviewTarget(input.href, input.base, input.source)
  if (target.url) return target.url.toString()
  if (!input.readFile) throw new MarkdownPreviewError("reader")
  input.signal.throwIfAborted()
  const file = await input.readFile(target.path!)
  input.signal.throwIfAborted()
  if (!file?.mimeType?.startsWith("image/")) throw new MarkdownPreviewError("text")
  if (file.content.length > (markdownPreviewMaxBytes * 4) / 3) throw new MarkdownPreviewError("size")
  if (file.encoding === "base64") return `data:${file.mimeType};base64,${file.content}`
  if (file.mimeType === "image/svg+xml") return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.content)}`
  throw new MarkdownPreviewError("text")
}

export function markdownPreviewFilename(href: string) {
  const name = href.split(/[?#]/, 1)[0].split(/[\\/]/).filter(Boolean).at(-1) || "preview.md"
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

export function markdownPreviewBody(markdown: string) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trimStart()
}
