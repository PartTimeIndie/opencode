import type { Compressed, Omission } from "./types"

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/
const FILE_HEADER = /^(?:diff --git |Index: |--- (?:a\/|\S)|\+\+\+ (?:b\/|\S)|new file mode|deleted file mode|rename (?:from|to) |similarity index |Binary files )/
const CONTEXT_KEEP = 2
const CONTEXT_GAP = 6
const MAX_OUTPUT_LINES = 1200

type Line = { readonly kind: "keep" | "context"; readonly text: string }

export const compressDiff = (text: string): Compressed | undefined => {
  const lines = text.split(/\r?\n/)
  const hunkCount = lines.filter((line) => HUNK_HEADER.test(line)).length
  const headerCount = lines.filter((line) => FILE_HEADER.test(line)).length
  if (hunkCount === 0 || headerCount === 0) return undefined

  const parts: string[] = []
  const omissions: Omission[] = []
  let omittedContext = 0
  let changedLines = 0

  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (HUNK_HEADER.test(line) || FILE_HEADER.test(line) || line.startsWith("\\")) {
      parts.push(line)
      index++
      continue
    }
    if (line.startsWith("+") || line.startsWith("-")) {
      parts.push(line)
      changedLines++
      index++
      continue
    }
    if (line.startsWith(" ")) {
      let contextEnd = index
      while (contextEnd < lines.length && (lines[contextEnd] ?? "").startsWith(" ")) contextEnd++
      const contextLength = contextEnd - index
      const previousChanged = parts.at(-1) && !((parts.at(-1) ?? "").startsWith(" ") || (parts.at(-1) ?? "").startsWith("@@") || FILE_HEADER.test(parts.at(-1) ?? ""))
      if (contextLength >= CONTEXT_GAP) {
        for (const contextLine of lines.slice(index, index + CONTEXT_KEEP)) parts.push(contextLine)
        const interior = contextLength - CONTEXT_KEEP * 2
        if (interior > 0) {
          parts.push(`[... ${interior} unchanged context lines omitted ...]`)
          omittedContext += interior
        }
        for (const contextLine of lines.slice(Math.max(index, contextEnd - CONTEXT_KEEP), contextEnd)) parts.push(contextLine)
      } else {
        for (const contextLine of lines.slice(index, contextEnd)) parts.push(contextLine)
      }
      void previousChanged
      index = contextEnd
      continue
    }
    parts.push(line)
    index++
  }

  const outputLines = parts.join("\n").split(/\r?\n/).length
  if (changedLines === 0 || omittedContext === 0) return undefined

  const overflow = outputLines > MAX_OUTPUT_LINES
  const finalText = overflow
    ? [
        "[compressed diff index: output exceeded the view budget; hunk coordinates preserved, use the stored original artifact for full hunks]",
        ...parts.filter((line) => !line.startsWith(" ") && !line.startsWith("+") && !line.startsWith("-")),
      ].join("\n")
    : parts.join("\n")

  omissions.push({
    kind: overflow ? "diff-hunks" : "diff-context",
    count: overflow ? hunkCount : omittedContext,
    ranges: overflow ? ["all hunks; see original artifact"] : ["interior unchanged context ranges"],
  })
  return { processor: "diff", text: finalText, omissions }
}
