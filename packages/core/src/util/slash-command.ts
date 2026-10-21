export type SlashCommandRange = { start: number; end: number }

// Match the same whitespace/colon-delimited expression used by slash search.
// Exact catalog membership keeps paths and unknown prefixes unstyled, while
// trimming only terminal sentence punctuation supports prose such as "/review.".
const SLASH_COMMAND_TOKEN = /(^|\s)\/([^\s:]*)/g
const TRAILING_PUNCTUATION = /[,.!?;)\]}]+$/u

export function findSlashCommandRanges(text: string, commandNames: ReadonlySet<string>): SlashCommandRange[] {
  if (!text || commandNames.size === 0) return []
  const ranges: SlashCommandRange[] = []
  for (const match of text.matchAll(SLASH_COMMAND_TOKEN)) {
    const lead = match[1] ?? ""
    const token = match[2] ?? ""
    const name = commandNames.has(token) ? token : token.replace(TRAILING_PUNCTUATION, "")
    if (!commandNames.has(name)) continue
    const start = (match.index ?? 0) + lead.length
    ranges.push({ start, end: start + name.length + 1 })
  }
  return ranges
}
