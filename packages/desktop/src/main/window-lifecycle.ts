import type { BrowserWindow } from "electron"

export function liveWindow(win: BrowserWindow | null | undefined) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null
  return win
}
