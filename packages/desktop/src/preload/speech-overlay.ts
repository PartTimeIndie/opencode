import { contextBridge, ipcRenderer } from "electron"
import type { DesktopServiceState } from "./types"

contextBridge.exposeInMainWorld("speechOverlay", {
  subscribe(callback: (state: DesktopServiceState & { application: string; accelerator: string }) => void) {
    const handler = (_event: unknown, state: DesktopServiceState & { application: string; accelerator: string }) => callback(state)
    ipcRenderer.on("speech-overlay-state", handler)
    return () => ipcRenderer.removeListener("speech-overlay-state", handler)
  },
})
