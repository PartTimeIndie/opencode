import { app, BrowserWindow } from "electron"
import { join } from "node:path"
import { registerBrowserTransferIpc } from "../../../src/main/browser-transfer-ipc"
import { browserTransferGuard } from "../../../src/main/browser-transfer-guard"

const root = process.env.OPENCODE_WEB_DOCK_FIXTURE_ROOT
const preload = process.env.OPENCODE_WEB_DOCK_FIXTURE_PRELOAD
if (!root || !preload) throw new Error("An isolated user-data root and fixture preload are required")
app.setPath("userData", join(root, "user-data"))
app.on("window-all-closed", () => app.quit())
void app.whenReady().then(() => {
  registerBrowserTransferIpc()
  Object.defineProperty(globalThis, "webDockFixtureGuard", { value: browserTransferGuard })
  const window = new BrowserWindow({
    width: 1280,
    height: 760,
    show: true,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: true },
  })
  window.webContents.on("will-attach-webview", (event, preferences, params) => {
    if (params.partition !== "persist:opencode-session-browser" || !/^https?:\/\//.test(params.src)) return event.preventDefault()
    delete preferences.preload
    preferences.nodeIntegration = false
    preferences.contextIsolation = true
    preferences.sandbox = true
  })
  // Playwright installs the fixture routes and storage before navigating.
  void window.loadURL("about:blank")
})
