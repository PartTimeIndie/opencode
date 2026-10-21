import { createRoot, getOwner, onCleanup } from "solid-js"

export function createRefCountMap<T>(
  create: (key: string) => T,
  remove?: (key: string) => void,
  identity: (key: string) => string = (key) => key,
) {
  const owner = getOwner()
  const items = new Map<string, { value: T; dispose: () => void }>()
  const refCounts = new Map<string, number>()

  return (key: string) => {
    const id = identity(key)
    onCleanup(() => {
      refCounts.set(id, (refCounts.get(id) ?? 0) - 1)
      if (refCounts.get(id) !== 0) return

      // Keyed Solid trees dispose the old branch before mounting its replacement.
      // Keep shared contexts alive through that synchronous handoff so switching
      // between sessions in one directory does not abort message loads or streams.
      queueMicrotask(() => {
        if (refCounts.get(id) !== 0) return
        const item = items.get(id)
        if (!item) return
        remove?.(id)
        item.dispose()
        items.delete(id)
        refCounts.delete(id)
      })
    })

    const cached = items.get(id)
    if (cached) {
      refCounts.set(id, (refCounts.get(id) ?? 0) + 1)
      return cached.value
    }
    const item = createRoot((dispose) => ({ value: create(key), dispose }), owner ?? undefined)
    items.set(id, item)
    refCounts.set(id, 1)
    return item.value
  }
}
