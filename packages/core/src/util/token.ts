export * as Token from "./token"

const CHARS_PER_TOKEN = 4

// Providers bill media attachments by resolution or page count, not by payload
// length. Counting a base64 data URL as text overestimates a ~1MB image by
// roughly 200x, which used to trigger premature auto-compaction.
const MEDIA_TOKENS = 1_600
const BASE64_DATA_URL = /^data:[^,]*;base64,/i
const MEDIA_PAYLOAD_MIN_CHARS = 1_024
const MEDIA_PART_TYPES = new Set(["media", "file", "image"])
const MEDIA_PAYLOAD_KEYS = new Set(["data", "image", "uri", "url"])

export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))

/** Estimate prompt tokens for a request-shaped value, pricing embedded media as media instead of text. */
export const estimateFootprint = (input: unknown) => {
  let media = 0
  const json = JSON.stringify(input, function (this: unknown, key: string, value: unknown) {
    if (!isMediaPayload(this, key, value)) return value
    media += MEDIA_TOKENS
    return "[media]"
  })
  return estimate(json ?? "") + media
}

function isMediaPayload(parent: unknown, key: string, value: unknown) {
  if (typeof value === "string" && BASE64_DATA_URL.test(value)) return true
  if (!MEDIA_PAYLOAD_KEYS.has(key) || !isMediaPart(parent)) return false
  if (value instanceof Uint8Array) return true
  return (
    typeof value === "string" &&
    value.length >= MEDIA_PAYLOAD_MIN_CHARS &&
    !value.startsWith("http://") &&
    !value.startsWith("https://")
  )
}

function isMediaPart(value: unknown) {
  if (typeof value !== "object" || value === null) return false
  const type = (value as Record<string, unknown>).type
  return typeof type === "string" && MEDIA_PART_TYPES.has(type)
}
