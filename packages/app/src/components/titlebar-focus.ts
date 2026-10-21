// Pointer and keyboard focus in pane content need not activate a tab or resize a dock.
export function observeTitlebarFocus(document: Document, changed: (pane: string) => void) {
  const listener = (event: Event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const pane = target.closest("[data-dock-pane], [data-dock-tab]")
    const id = pane?.getAttribute("data-dock-pane") ?? pane?.getAttribute("data-dock-tab")
    if (id) changed(id)
  }
  document.addEventListener("pointerdown", listener)
  document.addEventListener("focusin", listener)
  return () => {
    document.removeEventListener("pointerdown", listener)
    document.removeEventListener("focusin", listener)
  }
}
