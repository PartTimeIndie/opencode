import { BrowserWindow, Menu, Tray, nativeImage } from "electron"
import { isAppQuitting } from "./app-state"
import { closeToTray } from "./tray-lifecycle"

export interface TrayAutomation {
  id: string
  name: string
}

export interface TrayHandlers {
  onShow: () => void
  onQuit: () => void
  onRun?: (id: string) => void
  onRetry?: () => void
}

export function createTray(iconPath: string, automations: TrayAutomation[], handlers: TrayHandlers) {
  const image = nativeImage.createFromPath(iconPath)
  // Never hide a window when packaging failed to supply its recovery entrypoint.
  if (image.isEmpty()) return null
  const tray = new Tray(image.resize({ width: 16, height: 16 }))
  let status = "Lokaler Server startet"
  let retry = false
  let entries = automations
  const rebuild = (next: TrayAutomation[]) => {
    entries = next
    tray.setToolTip(`OpenCode — ${status}`)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Öffnen", click: handlers.onShow },
      { label: status, enabled: false },
      ...(retry ? [{ label: "Server erneut starten", click: () => handlers.onRetry?.() }] : []),
      { type: "separator" },
      ...next.map((item) => ({ label: item.name, click: () => handlers.onRun?.(item.id) })),
      { label: "OpenCode beenden", click: handlers.onQuit },
    ]))
  }
  rebuild(entries)
  tray.on("click", handlers.onShow)
  return {
    rebuild,
    setStatus: (text: string, canRetry: boolean) => {
      status = text
      retry = canRetry
      rebuild(entries)
    },
    destroy: () => tray.destroy(),
  }
}

export function applyCloseToTray(window: BrowserWindow, enabled: () => boolean) {
  window.on("close", (event) => {
    closeToTray({
      available: enabled(),
      quitting: isAppQuitting(),
      preventDefault: () => event.preventDefault(),
      hide: () => window.hide(),
    })
  })
}
