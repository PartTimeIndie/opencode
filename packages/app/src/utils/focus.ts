type RestorableFocusElement = HTMLElement & {
  restorePromptFocus?: () => void
}

export function canFocusWithoutStealing(scope?: HTMLElement | null) {
  if (typeof document === "undefined") return false
  if (!document.hasFocus()) return false

  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return true
  if (active === document.body || active === document.documentElement) return true

  return scope ? scope.contains(active) : false
}

export function focusWithPromptRestore(element: HTMLElement | undefined) {
  if (!element) return false
  const restore = (element as RestorableFocusElement).restorePromptFocus
  if (restore) {
    restore()
    return element.contains(document.activeElement)
  }
  element.focus({ preventScroll: true })
  return element.contains(document.activeElement)
}

export function focusWithoutStealing(element: HTMLElement | undefined) {
  if (!element) return false
  if (!canFocusWithoutStealing(element)) return false
  if (element.contains(document.activeElement)) return true
  return focusWithPromptRestore(element)
}

export function focusDockPromptInputForSession(sessionID: string, attempts = 200, force = false) {
  if (typeof document === "undefined") return
  window.setTimeout(() => {
    let forcePending = force
    const focusCurrentPrompt = () => {
      const middle = Array.from(document.querySelectorAll('[data-dock-area="middle"]')).find((area) =>
        Array.from(area.querySelectorAll("[data-dock-tab][data-session-id]")).some(
          (item) =>
            item.getAttribute("data-session-id") === sessionID &&
            item.querySelector('[role="tab"][aria-selected="true"]') !== null,
        ),
      )
      const input = Array.from(middle?.querySelectorAll('[data-component="prompt-input"]') ?? []).find(
        (element) => element.getAttribute("data-session-id") === sessionID,
      )
      if (!(middle && input instanceof HTMLElement)) return false
      if (!force) return focusWithoutStealing(input)

      const active = document.activeElement
      const activeIsNeutral =
        !(active instanceof HTMLElement) ||
        active === document.body ||
        active === document.documentElement ||
        !active.isConnected
      if (!forcePending && !activeIsNeutral && !input.contains(active)) return true

      const focused = focusWithPromptRestore(input) || input.focus({ preventScroll: true })
      if (focused || input.contains(document.activeElement)) forcePending = false
      return focused || input.contains(document.activeElement)
    }

    if (!focusCurrentPrompt()) {
      if (attempts > 1) focusDockPromptInputForSession(sessionID, attempts - 1, force)
      return
    }
    if (!force) return

    const retryDelays = [50, 150, 300, 600]
    retryDelays.forEach((delay) => window.setTimeout(focusCurrentPrompt, delay))
  }, 25)
}
