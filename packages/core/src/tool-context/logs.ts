import type { Compressed, Omission } from "./types"

const ERROR_LINE = /\b(error|fatal|failed|fail)\b/i
const EXCEPTION_NAME = /(?:^|[\s:'"])[A-Za-z_][\w.]*(?:Error|Exception)\b/
const TRACEBACK_START = /^Traceback \(most recent call last\):/
const STACK_FRAME = /^\s+(?:at\s|File "|raise )/
const SUMMARY_HINT = /\b(passed?|failed?|passing|failing|tests?|suites?|expected|actual|assertions?)\b[^\n]*\d/i
const NOISY_LINE = /^\s*(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\(\d{1,3}%\)|\[\d+\s*\/\s*\d+\]|\d+%\s)/
const KEEP_HEAD = 5
const KEEP_TAIL = 40
const CONTEXT = 2
const MAX_TRACE_LINES = 30
const MAX_OUTPUT_LINES = 400

const important = (line: string) => ERROR_LINE.test(line) || EXCEPTION_NAME.test(line) || SUMMARY_HINT.test(line)

type Segment =
  | { readonly kind: "line"; readonly index: number }
  | { readonly kind: "omission"; readonly count: number; readonly from: number; readonly to: number }

const traceKeep = (lines: ReadonlyArray<string>) => {
  const kept = new Set<number>()
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    const starts = TRACEBACK_START.test(line) || (EXCEPTION_NAME.test(line) && STACK_FRAME.test(lines[index + 1] ?? ""))
    if (!starts) continue
    let end = index
    while (end < lines.length && end - index < MAX_TRACE_LINES) {
      const current = lines[end] ?? ""
      if (end > index && current.trim() !== "" && !STACK_FRAME.test(current) && !EXCEPTION_NAME.test(current)) break
      kept.add(end)
      end++
    }
    index = end - 1
  }
  return kept
}

export const compressLog = (text: string): Compressed | undefined => {
  const lines = text.split(/\r?\n/)
  const kept = traceKeep(lines)
  for (let index = 0; index < lines.length; index++) {
    if (kept.has(index) || !important(lines[index] ?? "")) continue
    for (let offset = -CONTEXT; offset <= CONTEXT; offset++) {
      const target = index + offset
      if (target >= 0 && target < lines.length) kept.add(target)
    }
  }
  for (let index = 0; index < Math.min(KEEP_HEAD, lines.length); index++) kept.add(index)
  for (let index = Math.max(0, lines.length - KEEP_TAIL); index < lines.length; index++) kept.add(index)

  const segments: Segment[] = []
  const pushOmission = (from: number, to: number) => {
    if (to >= from) segments.push({ kind: "omission", count: to - from + 1, from, to })
  }

  let index = 0
  let skippedFrom = -1
  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (!kept.has(index)) {
      skippedFrom = skippedFrom < 0 ? index : skippedFrom
      index++
      continue
    }
    if (skippedFrom >= 0) {
      pushOmission(skippedFrom, index - 1)
      skippedFrom = -1
    }
    const trimmed = line.trim()
    let runEnd = index + 1
    while (runEnd < lines.length && (lines[runEnd] ?? "").trim() === trimmed && trimmed !== "") runEnd++
    const runLength = runEnd - index
    if (runLength >= 4) {
      segments.push({ kind: "line", index })
      if (runLength > 1) segments.push({ kind: "line", index: index + 1 })
      pushOmission(index + 2, runEnd - 1)
      index = runEnd
      continue
    }
    if (NOISY_LINE.test(line)) {
      let noisyEnd = index + 1
      while (noisyEnd < lines.length && NOISY_LINE.test(lines[noisyEnd] ?? "")) noisyEnd++
      const noisyLength = noisyEnd - index
      if (noisyLength >= 6) {
        segments.push({ kind: "line", index })
        segments.push({ kind: "line", index: noisyEnd - 1 })
        pushOmission(index + 1, noisyEnd - 2)
        index = noisyEnd
        continue
      }
    }
    segments.push({ kind: "line", index })
    index++
  }
  if (skippedFrom >= 0) pushOmission(skippedFrom, lines.length - 1)

  const lineSegments = segments.filter((segment) => segment.kind === "line")
  if (lineSegments.length > MAX_OUTPUT_LINES) {
    const overflow = lineSegments.length - 370
    const keptSegments: Segment[] = [...lineSegments.slice(0, 220), ...lineSegments.slice(-150)]
    keptSegments.push({ kind: "omission", count: overflow, from: -1, to: -1 })
    segments.length = 0
    segments.push(...keptSegments.sort((a, b) => (a.kind === "omission" ? 1 : b.kind === "omission" ? -1 : a.index - b.index)))
  }

  const totalOmitted = segments.reduce((total, segment) => (segment.kind === "omission" ? total + segment.count : total), 0)
  if (totalOmitted === 0) return undefined

  const ranges: string[] = []
  for (const segment of segments) {
    if (segment.kind !== "omission" || ranges.length >= 24) continue
    ranges.push(segment.from < 0 ? "kept-line overflow" : `original lines ${segment.from + 1}-${segment.to + 1}`)
  }

  const parts: string[] = [`[compressed log view: kept ${lineSegments.length} of ${lines.length} lines]`]
  for (const segment of segments) {
    if (segment.kind === "line") {
      parts.push(lines[segment.index] ?? "")
      continue
    }
    parts.push(
      segment.from < 0
        ? `[... ${segment.count} additional kept lines omitted for size; retrieve the stored original artifact ...]`
        : `[... ${segment.count} log lines omitted (original lines ${segment.from + 1}-${segment.to + 1}); retrieve the stored original artifact for the full output ...]`,
    )
  }

  const omissions: Omission[] = [{ kind: "log-lines", count: totalOmitted, ranges }]
  return { processor: "logs", text: parts.join("\n"), omissions }
}
