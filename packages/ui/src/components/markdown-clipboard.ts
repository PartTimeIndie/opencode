export async function copyMarkdownText(text: string) {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  try {
    if (navigator.clipboard?.writeText) {
      const copied = await navigator.clipboard.writeText(text).then(
        () => true,
        () => false,
      )
      if (copied) return true
    }
    const textarea = document.createElement("textarea")
    textarea.value = text
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    textarea.style.pointerEvents = "none"
    // Keep the fallback inside the active modal instead of its inert background.
    const parent = active?.closest('[role="dialog"]') ?? document.body
    parent.appendChild(textarea)
    try {
      textarea.select()
      return document.execCommand("copy")
    } finally {
      textarea.remove()
    }
  } catch {
    return false
  } finally {
    if (active?.isConnected) active.focus()
  }
}
