export * as Wildcard from "./wildcard"

export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}

export function all<T>(input: string, patterns: Record<string, T>) {
  return sorted(patterns).reduce<T | undefined>((result, [pattern, value]) => (match(input, pattern) ? value : result), undefined)
}

export function allStructured<T>(input: { head: string; tail: string[] }, patterns: Record<string, T>) {
  return sorted(patterns).reduce<T | undefined>((result, [pattern, value]) => {
    const parts = pattern.split(/\s+/)
    if (!match(input.head, parts[0])) return result
    if (parts.length === 1 || matchSequence(input.tail, parts.slice(1))) return value
    return result
  }, undefined)
}

function sorted<T>(patterns: Record<string, T>) {
  return Object.entries(patterns).sort(
    (a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  )
}

function matchSequence(items: string[], patterns: string[]): boolean {
  if (patterns.length === 0) return true
  const [pattern, ...rest] = patterns
  if (pattern === "*") return matchSequence(items, rest)
  return items.some((item, index) => match(item, pattern) && matchSequence(items.slice(index + 1), rest))
}
