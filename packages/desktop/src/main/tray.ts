import { BrowserWindow, Menu, Tray, app, nativeImage } from "electron"
import { isAppQuitting } from "./app-state"

// Feature 3 — Desktop tray. Close minimizes to the tray instead of quitting, so
// the in-process scheduler keeps firing while the app is resident. Controlled
// by `config.automation.tray` (default on when automations are active).
//
// Wiring (desktop/src/main): call createTray() once the main window exists and
// applyCloseToTray() on the window; destroy the tray on app.before-quit. Kept
// self-contained so it can land behind the automations feature flag.

export interface TrayAutomation {
  id: string
  name: string
}

export interface TrayHandlers {
  onShow: () => void
  onQuit: () => void
  onRun?: (id: string) => void
}

let tray: Tray | null = null

export function createTray(iconPath: string, automations: TrayAutomation[], handlers: TrayHandlers) {
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    // A tray requires a non-empty image; fail soft rather than throw on a
    // missing icon resource so a packaging gap does not crash the app.
    return null
  }
  tray = new Tray(image.resize({ width: 16, height: 16 }))
  tray.setToolTip("OpenCode")

  const rebuild = (next: TrayAutomation[]) => {
    const automationItems = next.length
      ? ([{ label: "Quick run", enabled: false }, ...next.map((a) => ({ label: a.name, click: () => handlers.onRun?.(a.id) }))] as const)
      : []
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show OpenCode", click: () => handlers.onShow() },
        { type: "separator" },
        ...(automationItems as Array<{ label: string; enabled?: boolean; click?: () => void }>),
        ...(next.length ? ([{ type: "separator" }] as const) : []),
        { label: "Quit", click: () => handlers.onQuit() },
      ]),
    )
  }
  rebuild(automations)

  tray.on("click", () => handlers.onShow())
  return {
    rebuild,
    destroy: () => {
      tray?.destroy()
      tray = null
    },
  }
}

// Hide on close instead of quitting while tray mode is active. Callers read the
// `config.automation.tray` flag; flipping it at runtime takes effect on the next
// close since this re-evaluates `enabled()` per event.
export function applyCloseToTray(window: BrowserWindow, enabled: () => boolean) {
  window.on("close", (event) => {
    if (!enabled()) return
    if (isAppQuitting()) return
    event.preventDefault()
    window.hide()
  })
}
