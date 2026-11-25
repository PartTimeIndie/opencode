// Keep the close policy independent of Electron so every quit boundary is testable.
export function closeToTray(input: {
  available: boolean
  quitting: boolean
  preventDefault: () => void
  hide: () => void
}) {
  if (!input.available || input.quitting) return false
  input.preventDefault()
  input.hide()
  return true
}

export function showFromTray(window: {
  isDestroyed: () => boolean
  isMinimized: () => boolean
  restore: () => void
  show: () => void
  focus: () => void
} | null) {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
