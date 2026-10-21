export * as StructuredContentReference from "./structured-content-reference"

import { isRecord } from "./util/record"

export const MIN_LEGACY_BINARY_BYTES = 256 * 1024
const MAX_DEPTH = 32
const MAX_NODES = 10_000

export interface MediaReference {
  readonly uri: string
  readonly mime: string
  readonly sizeBytes?: number
  readonly values?: ReadonlyArray<string>
}

export function replaceExact<T>(value: T, references: ReadonlyArray<MediaReference>): T {
  const exact = new Map(
    references.flatMap((reference) =>
      (reference.values ?? []).map((item) => [item, contentReference(reference)] as const),
    ),
  )
  if (exact.size === 0) return value
  return map(value, (item) => exact.get(item)) as T
}

export function replaceLegacy<T>(value: T, references: ReadonlyArray<MediaReference>): T {
  if (references.length === 0) return value
  return map(value, (item) => legacyReference(item, references)) as T
}

export function dataUriReference(source: string, reference: Omit<MediaReference, "values" | "sizeBytes">) {
  const parsed = parseDataUri(source)
  if (!parsed) return
  return {
    ...reference,
    mime: parsed.mime,
    sizeBytes: base64Bytes(parsed.payload),
    values: [source, parsed.payload],
  } satisfies MediaReference
}

function map(value: unknown, replace: (value: string) => unknown) {
  let nodes = 0
  const visit = (item: unknown, depth: number): unknown => {
    nodes++
    if (nodes > MAX_NODES || depth > MAX_DEPTH) return item
    if (typeof item === "string") return replace(item) ?? item
    if (Array.isArray(item)) {
      const next = item.map((entry) => visit(entry, depth + 1))
      return next.some((entry, index) => entry !== item[index]) ? next : item
    }
    if (!isRecord(item)) return item
    const entries = Object.entries(item).map(([key, entry]) => [key, visit(entry, depth + 1)] as const)
    return entries.some(([key, entry]) => entry !== item[key]) ? Object.fromEntries(entries) : item
  }
  return visit(value, 0)
}

function legacyReference(value: string, references: ReadonlyArray<MediaReference>) {
  if (value.length < MIN_LEGACY_BINARY_BYTES) return
  const parsed = parseDataUri(value)
  if (parsed) {
    const matches = references.filter((item) => item.mime === parsed.mime)
    if (matches.length !== 1) return
    return contentReference({ ...matches[0], sizeBytes: base64Bytes(parsed.payload) })
  }
  if (!isBase64(value)) return
  const mime = binaryMime(value)
  if (!mime) return
  const matches = references.filter((item) => item.mime === mime)
  if (matches.length !== 1) return
  return contentReference({ ...matches[0], sizeBytes: base64Bytes(value) })
}

function contentReference(reference: MediaReference) {
  return {
    $opencode: {
      type: "content-reference",
      uri: reference.uri,
      mime: reference.mime,
      ...(reference.sizeBytes === undefined ? {} : { sizeBytes: reference.sizeBytes }),
      encoding: "base64",
    },
  }
}

function parseDataUri(value: string) {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/]*={0,2})$/s.exec(value)
  if (!match?.[1] || match[2] === undefined) return
  return { mime: match[1].toLowerCase(), payload: match[2] }
}

function isBase64(value: string) {
  if (value.length % 4 !== 0) return false
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value)
}

function binaryMime(value: string) {
  const prefix = Buffer.from(value.slice(0, 32), "base64")
  if (prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png"
  if (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return "image/jpeg"
  if (prefix.subarray(0, 6).toString("ascii") === "GIF87a" || prefix.subarray(0, 6).toString("ascii") === "GIF89a")
    return "image/gif"
  if (prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp"
  if (prefix.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf"
}

function base64Bytes(value: string) {
  return Math.floor((value.length * 3) / 4) - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0)
}
