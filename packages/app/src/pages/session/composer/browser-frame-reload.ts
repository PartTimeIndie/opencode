type ReloadableFrame =
  | { mode: "webview"; ready: boolean; frame: { reload?: () => void } }
  | { mode: "iframe"; frame: { contentWindow: { location: { reload: () => void } } | null } }

export function reloadBrowserFrame(input: ReloadableFrame) {
  if (input.mode === "webview") {
    if (!input.ready || !input.frame.reload) throw new Error("The browser page is still loading")
    input.frame.reload()
    return
  }
  // Assigning iframe.src would lose an unreadable cross-origin live location.
  try {
    if (!input.frame.contentWindow) throw new Error("Missing embedded page")
    input.frame.contentWindow.location.reload()
  } catch {
    throw new Error("This embedded page cannot be reloaded here. Open the start address or use the desktop app.")
  }
}
