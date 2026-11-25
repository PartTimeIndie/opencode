import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, stat, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, nativeImage, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"

import type {
  DesktopServiceRegistrationInput,
  DesktopServiceState,
  FatalRendererError,
  ServerReadyData,
  TitlebarTheme,
} from "../preload/types"
import { getBrowserAutomationEnabled, setBrowserAutomationEnabled } from "./browser-automation"
import { registerBrowserTransferIpc } from "./browser-transfer-ipc"
import { installCli } from "./cli-install"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { parseFrameStallReport, reportFrameStallFromRenderer } from "./paint-recovery"
import { getStore } from "./store"
import { attentionBroker } from "./session-attention"
import type { AttentionCommand } from "@opencode-ai/app/session-attention/broker"
import { createMainWindow, getPinchZoomEnabled, setPinchZoomEnabled, setTitlebar, updateTitlebar } from "./windows"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"
import { openDesktopLink } from "./open-link"
import type { PluginDesktopServices } from "./plugin-desktop-services"
import type { ServerState } from "../preload/server-state"
import { readClipboardPng } from "./clipboard-image"
import { isOwningWindowSender, writeClipboardText } from "./clipboard-text"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

const pickedFiles = createPickedFileAuthorizations()

type Deps = {
  killSidecar: () => Promise<void> | void
  serverState: () => ServerState
  retryServer: () => void
  relaunch: (reason: string) => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
  desktopServices: PluginDesktopServices
}

export function registerIpcHandlers(deps: Deps) {
  registerBrowserTransferIpc()
  const updaterSubscriptions = createUpdaterSubscriptions()
  app.once("will-quit", updaterSubscriptions.clear)

  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("server-state", () => deps.serverState())
  ipcMain.handle("server-retry", () => deps.retryServer())
  ipcMain.handle("await-initialization", () => deps.awaitInitialization())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.handle("install-cli", () => installCli())
  ipcMain.handle("updater-subscribe", (event) => {
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  ipcMain.handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  ipcMain.handle("updater-check", () => deps.updater.check())
  ipcMain.handle("updater-install", () => deps.updater.install())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("export-debug-logs", () => deps.exportDebugLogs())
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.on("report-frame-stall", (event: IpcMainEvent, value: unknown) => {
    const report = parseFrameStallReport(value)
    if (report) reportFrameStallFromRenderer(event, report)
  })
  const attentionViews = new Map<number, string>()
  const attentionObserved = new WeakSet<object>()
  const attentionVisible = (key: string) => BrowserWindow.getAllWindows().some((win) =>
    !win.isDestroyed() && win.isFocused() && attentionViews.get(win.webContents.id) === key)
  const attention = attentionBroker({
    get: (name, key) => getStore(name).get(key),
    set: (name, key, value) => getStore(name).set(key, value),
  }, attentionVisible)
  ipcMain.handle("session-attention-visible", (event: IpcMainInvokeEvent, key: string | null) => {
    if (key && key.length <= 4096) attentionViews.set(event.sender.id, key)
    else attentionViews.delete(event.sender.id)
    if (!attentionObserved.has(event.sender)) {
      attentionObserved.add(event.sender)
      event.sender.once("destroyed", () => attentionViews.delete(event.sender.id))
    }
  })
  ipcMain.handle("session-attention-is-visible", (_event: IpcMainInvokeEvent, key: string) => attentionVisible(key))
  ipcMain.handle("session-attention-list", () => attention.list())
  ipcMain.handle("session-attention-update", (_event: IpcMainInvokeEvent, command: AttentionCommand) => {
    const result = attention.update(command)
    if (result.changed) BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send("session-attention-changed", command.key, result.entry)
    })
    return result
  })
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    try {
      getStore(name).set(key, value)
    } catch {}
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      getStore(name).delete(key)
    } catch {}
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    try {
      getStore(name).clear()
    } catch {}
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    try {
      return Object.keys(getStore(name).store)
    } catch {
      return []
    }
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    try {
      return Object.keys(getStore(name).store).length
    } catch {
      return 0
    }
  })

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  ipcMain.handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  ipcMain.handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.on("open-link", (_event: IpcMainEvent, url: string) => {
    void openDesktopLink(url, shell).catch((error) => {
      dialog.showErrorBox("Could not open link", error instanceof Error ? error.message : String(error))
    })
  })

  ipcMain.handle("open-app-window", (_event: IpcMainInvokeEvent, route: string) => {
    createMainWindow(route)
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("read-clipboard-image", async (_event: IpcMainInvokeEvent, options?: { includeBuffer?: boolean }) => {
    const image = await readClipboardPng(() => clipboard.read(), (buffer) => nativeImage.createFromBuffer(buffer))
    if (!image) return null
    const buffer = image.buffer
    const directory = join(app.getPath("userData"), "clipboard-attachments")
    await mkdir(directory, { recursive: true })
    const path = join(directory, `clipboard-${createHash("sha256").update(buffer).digest("hex")}.png`)
    await writeFile(path, buffer)
    return {
      ...(options?.includeBuffer === false
        ? {}
        : { buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) }),
      path,
      width: image.width,
      height: image.height,
    }
  })

  // The web Clipboard API rejects writes while the renderer is unfocused; plugins
  // dictating into other windows still need their transcript copy.
  ipcMain.handle("clipboard-write-text", (event: IpcMainInvokeEvent, text: unknown) => {
    if (!isOwningWindowSender(event.sender)) throw new Error("Clipboard writes require the owning window")
    return writeClipboardText(text, (value) => clipboard.writeText(value))
  })

  ipcMain.on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    deps.relaunch("renderer-ipc")
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  ipcMain.handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  ipcMain.handle("get-browser-automation-enabled", () => getBrowserAutomationEnabled())
  ipcMain.handle("set-browser-automation-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setBrowserAutomationEnabled(enabled)
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  ipcMain.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: () => deps.relaunch("renderer-menu"),
    })
  })
  ipcMain.handle("desktop-service-register", (event: IpcMainInvokeEvent, input: DesktopServiceRegistrationInput) =>
    deps.desktopServices.register(event.sender, input),
  )
  ipcMain.handle("desktop-service-unregister", (event: IpcMainInvokeEvent, registrationID: string) =>
    deps.desktopServices.unregister(event.sender, registrationID),
  )
  ipcMain.handle("desktop-service-read-clipboard", (event: IpcMainInvokeEvent, registrationID: string, invocationID: string) =>
    deps.desktopServices.readClipboard(event.sender, registrationID, invocationID),
  )
  ipcMain.handle("desktop-service-write-clipboard", (event: IpcMainInvokeEvent, registrationID: string, invocationID: string, text: string) =>
    deps.desktopServices.writeClipboard(event.sender, registrationID, invocationID, text),
  )
  ipcMain.handle(
    "desktop-service-update",
    (event: IpcMainInvokeEvent, registrationID: string, invocationID: string, state: DesktopServiceState) =>
      deps.desktopServices.update(event.sender, registrationID, invocationID, state),
  )
  ipcMain.handle(
    "desktop-service-insert-text",
    (event: IpcMainInvokeEvent, registrationID: string, invocationID: string, text: string) =>
      deps.desktopServices.insertText(event.sender, registrationID, invocationID, text),
  )
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
