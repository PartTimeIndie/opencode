import { contextBridge, ipcRenderer, webUtils } from "electron"
import type { DesktopServiceInvocationEvent, DesktopTestingRequest, ElectronAPI, WslServersEvent } from "./types"
import type { UpdaterState } from "@opencode-ai/app/updater"

const updaterCallbacks = new Set<(state: UpdaterState) => void>()
let updaterState: UpdaterState | undefined
let updaterSubscription: Promise<void> | undefined
const updaterHandler = (_: unknown, state: UpdaterState) => {
  updaterState = state
  updaterCallbacks.forEach((callback) => callback(state))
}

const api: ElectronAPI = {
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  installCli: () => ipcRenderer.invoke("install-cli"),
  awaitInitialization: () => ipcRenderer.invoke("await-initialization"),
  wslServers: {
    getState: () => ipcRenderer.invoke("wsl-servers-get-state"),
    subscribe: (cb) => {
      const handler = (_: unknown, event: WslServersEvent) => cb(event)
      ipcRenderer.on("wsl-servers-event", handler)
      void ipcRenderer.invoke("wsl-servers-subscribe")
      return () => {
        ipcRenderer.removeListener("wsl-servers-event", handler)
        void ipcRenderer.invoke("wsl-servers-unsubscribe")
      }
    },
    probeRuntime: () => ipcRenderer.invoke("wsl-servers-probe-runtime"),
    refreshDistros: () => ipcRenderer.invoke("wsl-servers-refresh-distros"),
    installWsl: () => ipcRenderer.invoke("wsl-servers-install-wsl"),
    installDistro: (name) => ipcRenderer.invoke("wsl-servers-install-distro", name),
    probeDistro: (name) => ipcRenderer.invoke("wsl-servers-probe-distro", name),
    probeOpencode: (name) => ipcRenderer.invoke("wsl-servers-probe-opencode", name),
    installOpencode: (name) => ipcRenderer.invoke("wsl-servers-install-opencode", name),
    openTerminal: (name) => ipcRenderer.invoke("wsl-servers-open-terminal", name),
    addServer: (distro) => ipcRenderer.invoke("wsl-servers-add", distro),
    removeServer: (id) => ipcRenderer.invoke("wsl-servers-remove", id),
    startServer: (id) => ipcRenderer.invoke("wsl-servers-start", id),
  },
  updater: {
    subscribe: async (cb) => {
      updaterCallbacks.add(cb)
      if (updaterState) cb(updaterState)
      if (!updaterSubscription) {
        ipcRenderer.on("updater-state", updaterHandler)
        updaterSubscription = ipcRenderer.invoke("updater-subscribe")
      }
      await updaterSubscription
      return () => {
        updaterCallbacks.delete(cb)
        if (updaterCallbacks.size > 0) return
        ipcRenderer.removeListener("updater-state", updaterHandler)
        updaterSubscription = undefined
        void ipcRenderer.invoke("updater-unsubscribe")
      }
    },
    check: () => ipcRenderer.invoke("updater-check"),
    install: () => ipcRenderer.invoke("updater-install"),
  },
  consumeInitialDeepLinks: () => ipcRenderer.invoke("consume-initial-deep-links"),
  getDefaultServerUrl: () => ipcRenderer.invoke("get-default-server-url"),
  setDefaultServerUrl: (url) => ipcRenderer.invoke("set-default-server-url", url),
  getDisplayBackend: () => ipcRenderer.invoke("get-display-backend"),
  setDisplayBackend: (backend) => ipcRenderer.invoke("set-display-backend", backend),
  parseMarkdownCommand: (markdown) => ipcRenderer.invoke("parse-markdown", markdown),
  checkAppExists: (appName) => ipcRenderer.invoke("check-app-exists", appName),
  resolveAppPath: (appName) => ipcRenderer.invoke("resolve-app-path", appName),
  storeGet: (name, key) => ipcRenderer.invoke("store-get", name, key),
  storeSet: (name, key, value) => ipcRenderer.invoke("store-set", name, key, value),
  storeDelete: (name, key) => ipcRenderer.invoke("store-delete", name, key),
  storeClear: (name) => ipcRenderer.invoke("store-clear", name),
  storeKeys: (name) => ipcRenderer.invoke("store-keys", name),
  storeLength: (name) => ipcRenderer.invoke("store-length", name),

  getWindowCount: () => ipcRenderer.invoke("get-window-count"),
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on("menu-command", handler)
    return () => ipcRenderer.removeListener("menu-command", handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, urls: string[]) => cb(urls)
    ipcRenderer.on("deep-link", handler)
    return () => ipcRenderer.removeListener("deep-link", handler)
  },

  openDirectoryPicker: (opts) => ipcRenderer.invoke("open-directory-picker", opts),
  openFilePicker: (opts) => ipcRenderer.invoke("open-file-picker", opts),
  readPickedFile: (token, path) => ipcRenderer.invoke("read-picked-file", token, path),
  releasePickedFiles: (token) => ipcRenderer.invoke("release-picked-files", token),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  saveFilePicker: (opts) => ipcRenderer.invoke("save-file-picker", opts),
  openLink: (url) => ipcRenderer.send("open-link", url),
  openAppWindow: (route) => ipcRenderer.invoke("open-app-window", route),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  readClipboardImage: (options) => ipcRenderer.invoke("read-clipboard-image", options),
  showNotification: (title, body) => ipcRenderer.send("show-notification", title, body),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  getZoomFactor: () => ipcRenderer.invoke("get-zoom-factor"),
  setZoomFactor: (factor) => ipcRenderer.invoke("set-zoom-factor", factor),
  getPinchZoomEnabled: () => ipcRenderer.invoke("get-pinch-zoom-enabled"),
  setPinchZoomEnabled: (enabled) => ipcRenderer.invoke("set-pinch-zoom-enabled", enabled),
  getBrowserAutomationEnabled: () => ipcRenderer.invoke("get-browser-automation-enabled"),
  setBrowserAutomationEnabled: (enabled) => ipcRenderer.invoke("set-browser-automation-enabled", enabled),
  onPinchZoomEnabledChanged: (cb) => {
    const handler = (_: unknown, enabled: boolean) => cb(enabled)
    ipcRenderer.on("pinch-zoom-enabled-changed", handler)
    return () => ipcRenderer.removeListener("pinch-zoom-enabled-changed", handler)
  },
  onZoomFactorChanged: (cb) => {
    const handler = (_: unknown, factor: number) => cb(factor)
    ipcRenderer.on("zoom-factor-changed", handler)
    return () => ipcRenderer.removeListener("zoom-factor-changed", handler)
  },
  setTitlebar: (theme) => ipcRenderer.invoke("set-titlebar", theme),
  runDesktopMenuAction: (action) => ipcRenderer.invoke("run-desktop-menu-action", action),
  registerDesktopService: (input) => ipcRenderer.invoke("desktop-service-register", input),
  unregisterDesktopService: (registrationID) => ipcRenderer.invoke("desktop-service-unregister", registrationID),
  readDesktopServiceClipboard: (registrationID, invocationID) =>
    ipcRenderer.invoke("desktop-service-read-clipboard", registrationID, invocationID),
  writeDesktopServiceClipboard: (registrationID, invocationID, text) =>
    ipcRenderer.invoke("desktop-service-write-clipboard", registrationID, invocationID, text),
  updateDesktopService: (registrationID, invocationID, state) =>
    ipcRenderer.invoke("desktop-service-update", registrationID, invocationID, state),
  insertDesktopServiceText: (registrationID, invocationID, text) =>
    ipcRenderer.invoke("desktop-service-insert-text", registrationID, invocationID, text),
  onDesktopServiceInvocation: (callback) => {
    const handler = (_event: unknown, payload: DesktopServiceInvocationEvent) => callback(payload)
    ipcRenderer.on("desktop-service-invoked", handler)
    return () => ipcRenderer.removeListener("desktop-service-invoked", handler)
  },
  desktopTesting: {
    onRequest: (cb) => {
      const handler = (_: unknown, request: DesktopTestingRequest) => {
        void Promise.resolve()
          .then(() => cb(request))
          .then((result) =>
            ipcRenderer.invoke("desktop-testing-response", request.id, {
              ok: true,
              result: jsonSafe(result),
            }),
          )
          .catch((error) =>
            ipcRenderer.invoke("desktop-testing-response", request.id, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          )
      }
      ipcRenderer.on("desktop-testing-request", handler)
      return () => ipcRenderer.removeListener("desktop-testing-request", handler)
    },
  },
  setBackgroundColor: (color: string) => ipcRenderer.invoke("set-background-color", color),
  exportDebugLogs: () => ipcRenderer.invoke("export-debug-logs"),
  recordFatalRendererError: (error) => ipcRenderer.invoke("record-fatal-renderer-error", error),
  reportFrameStall: (report) => ipcRenderer.send("report-frame-stall", report),
}

function jsonSafe(value: unknown) {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value)) as unknown
}

contextBridge.exposeInMainWorld("api", api)
