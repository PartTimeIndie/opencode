import { createSignal } from "solid-js"

/** Keep the large management catalog off the settings page until requested.
 * One in-flight read is shared by rapid reopen/search actions. */
export function createSkillBrowser<T>(load: () => Promise<T[]>) {
  const [expanded, setExpanded] = createSignal(false)
  const [items, setItems] = createSignal<T[]>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  let disposed = false
  let reload = false
  const refresh = async () => {
    if (disposed) return
    if (loading()) {
      reload = true
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const result = await load()
      if (!disposed) setItems(result)
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : "Skills could not be loaded.")
    } finally {
      if (!disposed) setLoading(false)
    }
    if (reload && !disposed) {
      reload = false
      await refresh()
    }
  }
  return {
    expanded, items, error, loading, refresh,
    reveal() {
      setExpanded(true)
      if (items() === undefined && !loading()) void refresh()
    },
    collapse() { setExpanded(false) },
    dispose() { disposed = true },
  }
}
