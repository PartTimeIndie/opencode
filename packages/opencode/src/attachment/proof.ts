import { randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { copyFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { Buffer } from "node:buffer"
import { Readable } from "node:stream"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"

const defaultMaxBytes = 512 * 1024 * 1024
const urlPrefix = "/app/attachment/proof"

export type Metadata = {
  filename: string
  mime: string
  sizeBytes: number
  purpose: "proof"
}

export type Artifact = Metadata & {
  path: string
  url: string
}

export type ByteRange = { start: number; end: number }

export function maxBytes() {
  const value = Number(process.env.OPENCODE_PROOF_ATTACHMENT_MAX_MB)
  if (!Number.isFinite(value) || value <= 0) return defaultMaxBytes
  return Math.floor(value * 1024 * 1024)
}

export function isUrl(value: string) {
  return value.startsWith(`${urlPrefix}/`)
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export async function createFromFile(input: {
  sessionID: string
  path: string
  filename?: string
  mime: string
}): Promise<Artifact> {
  const info = await stat(input.path)
  if (!info.isFile()) throw new Error("Proof attachment source is not a file")
  if (info.size > maxBytes()) throw new Error(`Proof attachment is too large (${formatBytes(info.size)} > ${formatBytes(maxBytes())}).`)
  const artifact = artifactTarget(input.sessionID, input.filename ?? input.path, input.mime, info.size)
  await mkdir(resolve(Global.Path.state, "proof-attachments", artifact.sessionKey), { recursive: true })
  await copyFile(input.path, artifact.path)
  await writeMetadata(artifact.path, artifact.metadata)
  return { ...artifact.metadata, path: artifact.path, url: artifactUrl(artifact.sessionKey, artifact.storedName) }
}

export async function createFromBytes(input: {
  sessionID: string
  bytes: Uint8Array
  filename: string
  mime: string
}): Promise<Artifact> {
  if (input.bytes.byteLength > maxBytes()) throw new Error(`Proof attachment is too large (${formatBytes(input.bytes.byteLength)} > ${formatBytes(maxBytes())}).`)
  const artifact = artifactTarget(input.sessionID, input.filename, input.mime, input.bytes.byteLength)
  await mkdir(resolve(Global.Path.state, "proof-attachments", artifact.sessionKey), { recursive: true })
  await writeFile(artifact.path, input.bytes)
  await writeMetadata(artifact.path, artifact.metadata)
  return { ...artifact.metadata, path: artifact.path, url: artifactUrl(artifact.sessionKey, artifact.storedName) }
}

export async function readRequest(pathname: string): Promise<(Metadata & { path: string; sizeBytes: number }) | undefined> {
  const target = pathFromUrl(pathname)
  if (!target) return
  const info = await stat(target.path).catch(() => undefined)
  if (!info?.isFile()) return
  const metadata = await readMetadata(target.path).catch(() => undefined)
  if (!metadata) return
  return { ...metadata, path: target.path, sizeBytes: info.size }
}

export function rangeFromHeader(header: string | undefined, size: number): ByteRange | undefined | "invalid" {
  if (!header) return
  if (size <= 0) return "invalid"
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return "invalid"
  const startText = match[1] ?? ""
  const endText = match[2] ?? ""
  if (!startText && !endText) return "invalid"
  if (!startText) {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid"
    return { start: Math.max(0, size - suffix), end: Math.max(0, size - 1) }
  }
  const start = Number(startText)
  const requestedEnd = endText ? Number(endText) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || requestedEnd < start || start >= size) return "invalid"
  return { start, end: Math.min(requestedEnd, size - 1) }
}

export async function readBytes(path: string, range?: ByteRange) {
  if (!range) return readFile(path)
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.allocUnsafe(range.end - range.start + 1)
    const result = await handle.read(buffer, 0, buffer.byteLength, range.start)
    return buffer.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}

export function readStream(path: string, range?: ByteRange) {
  if (!range) return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>
  const handle = open(path, "r")
  let position = range.start
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await (await handle).close()
  }
  const pull = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    const remaining = range.end - position + 1
    if (remaining <= 0) {
      controller.close()
      await close()
      return
    }
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
    const result = await (await handle).read(buffer, 0, buffer.byteLength, position)
    if (result.bytesRead === 0) {
      controller.close()
      await close()
      return
    }
    position += result.bytesRead
    controller.enqueue(buffer.subarray(0, result.bytesRead))
    if (position <= range.end) return
    controller.close()
    await close()
  }
  return new ReadableStream<Uint8Array>({
    pull: (controller) =>
      pull(controller).catch(async (cause) => {
        await close().catch(() => undefined)
        controller.error(cause)
      }),
    cancel: close,
  })
}

export function contentDisposition(filename: string) {
  return `inline; filename="${filename.replace(/["\\]/g, "_")}"`
}

function artifactTarget(sessionID: string, filename: string, mime: string, sizeBytes: number) {
  const sessionKey = safeSegment(sessionID, "session")
  const displayName = safeFilename(filename, "proof-attachment")
  const storedName = `${Date.now()}-${randomUUID()}-${displayName}`
  const path = resolve(Global.Path.state, "proof-attachments", sessionKey, storedName)
  return {
    sessionKey,
    storedName,
    path,
    metadata: { filename: displayName, mime, sizeBytes, purpose: "proof" as const },
  }
}

function artifactUrl(sessionKey: string, storedName: string) {
  return `${urlPrefix}/${encodeURIComponent(sessionKey)}/${encodeURIComponent(storedName)}`
}

function pathFromUrl(pathname: string) {
  const parts = pathname.split("/").filter(Boolean)
  if (parts[0] !== "app" || parts[1] !== "attachment" || parts[2] !== "proof") return
  if (parts.length !== 5) return
  const sessionKey = safeDecode(parts[3] ?? "")
  const storedName = safeDecode(parts[4] ?? "")
  if (!sessionKey || !storedName) return
  if (safeSegment(sessionKey, "session") !== sessionKey || safeFilename(storedName, "file") !== storedName) return
  const directory = resolve(Global.Path.state, "proof-attachments", sessionKey)
  const path = resolve(directory, storedName)
  if (!FSUtil.contains(directory, path)) return
  return { path }
}

async function readMetadata(path: string): Promise<Metadata> {
  const data = JSON.parse(await readFile(metadataPath(path), "utf8")) as unknown
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid proof attachment metadata")
  const metadata = data as Record<string, unknown>
  return {
    filename: typeof metadata.filename === "string" ? metadata.filename : "proof-attachment",
    mime: typeof metadata.mime === "string" ? metadata.mime : "application/octet-stream",
    sizeBytes: typeof metadata.sizeBytes === "number" ? metadata.sizeBytes : 0,
    purpose: "proof",
  }
}

function writeMetadata(path: string, metadata: Metadata) {
  return writeFile(metadataPath(path), `${JSON.stringify(metadata, null, 2)}\n`)
}

function metadataPath(path: string) {
  return `${path}.json`
}

function safeSegment(value: string, fallback: string) {
  const segment = value.replace(/[^a-zA-Z0-9._-]/g, "_")
  if (!segment || segment === "." || segment === "..") return fallback
  return segment
}

function safeFilename(value: string, fallback: string) {
  const name = basename(value.replace(/\\/g, "/")).replace(/[^a-zA-Z0-9._-]/g, "_")
  if (!name || name === "." || name === "..") return fallback
  return name
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return ""
  }
}

export * as ProofAttachment from "./proof"
