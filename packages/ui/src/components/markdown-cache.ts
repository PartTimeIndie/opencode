type Entry = { raw: string; hash: string; html: string }

export function createMarkdownCache<T extends Entry>(input: { maxEntries: number; maxBytes: number }) {
  const entries = new Map<string, T>()
  let retainedBytes = 0

  // Raw Markdown and sanitized HTML are both retained, so entry count alone is not a useful bound.
  const sizeOf = (entry: Entry) => (entry.raw.length + entry.hash.length + entry.html.length) * 2

  return {
    get(key: string) {
      const entry = entries.get(key)
      if (!entry) return
      entries.delete(key)
      entries.set(key, entry)
      return entry
    },
    set(key: string, entry: T) {
      const previous = entries.get(key)
      if (previous) {
        entries.delete(key)
        retainedBytes -= sizeOf(previous)
      }

      const entryBytes = sizeOf(entry)
      if (input.maxEntries < 1 || entryBytes > input.maxBytes) return

      while (entries.size >= input.maxEntries || retainedBytes + entryBytes > input.maxBytes) {
        const first = entries.keys().next().value
        if (first === undefined) break
        const victim = entries.get(first)
        if (victim === undefined) break
        retainedBytes -= sizeOf(victim)
        entries.delete(first)
      }

      entries.set(key, entry)
      retainedBytes += entryBytes
    },
  }
}
