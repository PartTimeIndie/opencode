import type { Compressed, Omission } from "./types"

const WINDOWS_MATCH = /^([A-Za-z]:[^:]+):(\d+)[:-](.*)$/
const MATCH = /^(.+?):(\d+)[:-](.*)$/
const MAX_LINE_CHARS = 300
const PER_FILE_HEAD = 3
const PER_FILE_TAIL = 1

type Match = { readonly file: string; readonly line: number; readonly content: string }

const parseLine = (line: string): Match | undefined => {
  const windows = WINDOWS_MATCH.exec(line)
  if (windows) return { file: windows[1] ?? "", line: Number(windows[2]), content: windows[3] ?? "" }
  const generic = MATCH.exec(line)
  if (!generic) return undefined
  const lineNumber = Number(generic[2])
  if (!Number.isInteger(lineNumber) || lineNumber <= 0) return undefined
  return { file: generic[1] ?? "", line: lineNumber, content: generic[3] ?? "" }
}

const truncate = (content: string) =>
  content.length > MAX_LINE_CHARS ? `${content.slice(0, MAX_LINE_CHARS)}…` : content

export const compressSearch = (text: string): Compressed | undefined => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "")
  if (lines.length === 0) return undefined
  const matches = lines.map(parseLine)
  const parsed = matches.filter((match): match is Match => match !== undefined)
  if (parsed.length < Math.ceil(lines.length * 0.5) || parsed.length < 8) return undefined

  const order: string[] = []
  const byFile = new Map<string, Match[]>()
  for (const match of parsed) {
    if (!byFile.has(match.file)) {
      byFile.set(match.file, [])
      order.push(match.file)
    }
    byFile.get(match.file)?.push(match)
  }

  const parts: string[] = [
    `[compressed search view: ${parsed.length} matches across ${order.length} files]`,
  ]
  const omissions: Omission[] = []
  let omittedTotal = 0
  for (const file of order) {
    const fileMatches = byFile.get(file) ?? []
    const seen = new Set<string>()
    const unique = fileMatches.filter((match) => {
      const key = `${match.line}:${match.content}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const duplicateCount = fileMatches.length - unique.length
    const head = unique.slice(0, PER_FILE_HEAD)
    const tail = unique.length > PER_FILE_HEAD + PER_FILE_TAIL ? unique.slice(-PER_FILE_TAIL) : []
    const middleCount = Math.max(0, unique.length - head.length - tail.length)
    omittedTotal += middleCount + duplicateCount
    parts.push(`${file} (${unique.length}${duplicateCount > 0 ? `; ${duplicateCount} duplicate` : ""} matches)`)
    for (const match of head) parts.push(`  ${match.line}: ${truncate(match.content)}`)
    if (middleCount > 0)
      parts.push(
        `  [... ${middleCount} matches omitted between original lines ${head.at(-1)?.line ?? 0}-${tail[0]?.line ?? unique.at(-1)?.line ?? 0}; retrieve the stored original artifact ...]`,
      )
    for (const match of tail) parts.push(`  ${match.line}: ${truncate(match.content)}`)
  }

  if (omittedTotal === 0) return undefined
  omissions.push({ kind: "search-matches", count: omittedTotal, ranges: ["per-file omitted match ranges above"] })
  return { processor: "search", text: parts.join("\n"), omissions }
}
