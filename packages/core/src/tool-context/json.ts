import type { Compressed, Omission } from "./types"

const MAX_PARSE_BYTES = 4 * 1024 * 1024
const MIN_RECORDS = 30
const KEEP_HEAD = 10
const KEEP_TAIL = 5

export const compressJson = (text: string): Compressed | undefined => {
  const trimmed = text.trim()
  if (!trimmed.startsWith("[") || trimmed.length > MAX_PARSE_BYTES) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length < MIN_RECORDS) return undefined

  const serialized = parsed.map((record) => JSON.stringify(record) ?? "")
  const seen = new Map<string, number>()
  const duplicateIndexes: number[] = []
  serialized.forEach((value, index) => {
    const count = seen.get(value)
    if (count === undefined) {
      seen.set(value, 1)
      return
    }
    seen.set(value, count + 1)
    duplicateIndexes.push(index)
  })

  const duplicateSet = new Set(duplicateIndexes)
  const uniqueIndexes = serialized.map((_, index) => index).filter((index) => !duplicateSet.has(index))
  if (uniqueIndexes.length < MIN_RECORDS) return undefined

  const head = uniqueIndexes.slice(0, KEEP_HEAD)
  const tail = uniqueIndexes.slice(-KEEP_TAIL)
  const middle = uniqueIndexes.slice(KEEP_HEAD, uniqueIndexes.length - KEEP_TAIL)
  if (middle.length < MIN_RECORDS) return undefined

  const keptRecords = [...head, ...tail].map((index) => parsed[index])
  const pretty = keptRecords.map((record) => JSON.stringify(record, null, 2) ?? "").join(",\n")
  const text2 = [
    `[compressed JSON view: kept ${keptRecords.length} of ${parsed.length} records (${duplicateIndexes.length} exact duplicates collapsed)]`,
    `[\n${pretty}\n]`,
    `[... ${middle.length} records omitted (indexes ${middle[0]}-${middle.at(-1)}); retrieve the stored original artifact ...]`,
  ].join("\n")

  const omissions = [
    { kind: "json-records", count: middle.length, ranges: [`indexes ${middle[0]}-${middle.at(-1)}`] },
    ...(duplicateIndexes.length > 0
      ? [{ kind: "json-duplicates", count: duplicateIndexes.length, ranges: [] as string[] }]
      : []),
  ]
  return { processor: "json", text: text2, omissions }
}
