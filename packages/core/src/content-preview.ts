export const MAX_CONTENT_PREVIEW_BYTES = 50 * 1024
export const MAX_PERSISTED_CONTENT_PREVIEW_BYTES = 8 * 1024

export function boundedContentPreview(value: string, maximumBytes = MAX_CONTENT_PREVIEW_BYTES) {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value
  const marker = "\n... migration preview truncated ...\n"
  // Keep room for replacement code points when a byte slice lands inside a UTF-8 sequence.
  const budget = maximumBytes - Buffer.byteLength(marker, "utf8") - 8
  const bytes = Buffer.from(value, "utf8")
  const head = bytes.subarray(0, Math.ceil(budget / 2)).toString("utf8")
  const tail = bytes.subarray(-Math.floor(budget / 2)).toString("utf8")
  return `${head}${marker}${tail}`
}

export function boundedPersistedContentPreview(value: string) {
  return boundedContentPreview(value, MAX_PERSISTED_CONTENT_PREVIEW_BYTES)
}
