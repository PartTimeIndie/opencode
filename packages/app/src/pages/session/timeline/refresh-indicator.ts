import { createComputed, createSignal, on, onCleanup, type Accessor } from "solid-js"

export function createRefreshIndicator(input: {
  sessionID: Accessor<string | undefined>
  refreshing: Accessor<boolean>
  ready: Accessor<boolean>
  delay?: number
}) {
  const [visible, setVisible] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  createComputed(
    on(
      () => [input.sessionID(), input.refreshing(), input.ready()] as const,
      ([sessionID, refreshing, ready]) => {
        clear()
        setVisible(false)
        if (!sessionID || !refreshing) return
        if (!ready) {
          setVisible(true)
          return
        }

        // Loaded timelines stay usable during refresh, so avoid flashing the overlay for quick updates.
        timer = setTimeout(() => {
          timer = undefined
          if (input.sessionID() !== sessionID || !input.refreshing()) return
          setVisible(true)
        }, input.delay ?? 600)
      },
    ),
  )

  onCleanup(clear)
  return visible

  function clear() {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }
}
