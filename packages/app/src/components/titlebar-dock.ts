type Area = "top" | "left" | "right" | "bottom"

// The dock is global; review and terminal state belongs only to the active session.
export function toggleTitlebarDock(input: {
  area: Area
  dock: {
    area: (area: Area) => { visible: () => boolean }
    setVisible: (area: Area, visible: boolean) => void
    item: (id: string) => { area: () => string }
  }
  fileTreeOpened: boolean
  session?: {
    reviewPanel: { opened: () => boolean; open: () => void }
    terminal: { open: () => void; close: () => void }
  }
}) {
  const next = !input.dock.area(input.area).visible()
  input.dock.setVisible(input.area, next)
  if (!input.session) return
  if (input.area === "right" && next && !input.session.reviewPanel.opened() && !input.fileTreeOpened)
    input.session.reviewPanel.open()
  if (input.area !== "bottom" || input.dock.item("terminal").area() !== "bottom") return
  if (next) return input.session.terminal.open()
  input.session.terminal.close()
}
