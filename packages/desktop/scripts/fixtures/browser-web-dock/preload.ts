import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("__OPENCODE_TEST_PLATFORM__", {
  platform: "desktop",
  os: "windows",
  embeddedBrowser: "webview",
  version: "isolated-web-dock-fixture",
  openLink() {},
  async restart() { throw new Error("Fixture restart is not supported") },
  back() {},
  forward() {},
  async notify() {},
  browserTransfer: (action: string, id: number, ticket?: string) => ipcRenderer.invoke("browser-transfer", action, id, ticket),
})
