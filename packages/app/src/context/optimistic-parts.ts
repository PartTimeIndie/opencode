import type { Part } from "@opencode-ai/sdk/v2/client"

export function missingOptimisticParts(parts: Part[] | undefined, optimistic: Part[]) {
  if (!parts) return optimistic
  const used = new Set<number>()
  return optimistic.filter((part) => {
    const exact = parts.findIndex((candidate, index) => !used.has(index) && candidate.id === part.id)
    const match =
      exact >= 0
        ? exact
        : parts.findIndex((candidate, index) => !used.has(index) && sameOptimisticPart(candidate, part))
    if (match < 0) return true
    used.add(match)
    return false
  })
}

function sameOptimisticPart(candidate: Part, optimistic: Part) {
  if (candidate.type !== optimistic.type) return false
  if (candidate.type === "text" && optimistic.type === "text") return candidate.text === optimistic.text
  if (candidate.type === "file" && optimistic.type === "file")
    return candidate.mime === optimistic.mime && candidate.filename === optimistic.filename
  return false
}
