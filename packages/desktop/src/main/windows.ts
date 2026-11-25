import windowState from "electron-window-state"
import { resolveThemeVariant } from "@opencode-ai/ui/theme/resolve"
import type { DesktopTheme } from "@opencode-ai/ui/theme/types"
import oc2ThemeJson from "../../../ui/src/theme/themes/oc-2.json"
import { app, BrowserWindow, dialog, net, nativeImage, nativeTheme, protocol, session, shell, type Session } from "electron"
import type { MediaAccessPermissionRequest } from "electron"
import { Buffer } from "node:buffer"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { TitlebarTheme } from "../preload/types"
import { createPaintRecovery } from "./paint-recovery"
import { exportDebugLogs, write as writeLog } from "./logging"
import { getStore } from "./store"
import { PINCH_ZOOM_ENABLED_KEY } from "./store-keys"
import { createUnresponsiveSampler } from "./unresponsive"
import { isAllowedBrowserUrl } from "./url-policy"
import { ownsSidecarLogin, sidecarBrowserAuthorization } from "./browser-sidecar-auth"
import { pluginAssetTarget } from "./plugin-asset-url"
import { rendererPermissionAllowed } from "./renderer-permissions"

const root = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(root, "../renderer")
const rendererProtocol = "oc"
const rendererHost = "renderer"
const pluginHost = "plugin"
const oc2Theme = oc2ThemeJson as DesktopTheme
const oc2Background = {
  light: resolveThemeVariant(oc2Theme.light, false)["background-base"],
  dark: resolveThemeVariant(oc2Theme.dark, true)["background-base"],
}
const documentPolicyHeader = "Document-Policy"
const jsCallStacksDocumentPolicy = "include-js-call-stacks-in-crash-reports"
const rendererCacheControl = "no-store, no-cache, must-revalidate, max-age=0"

protocol.registerSchemesAsPrivileged([
  {
    scheme: rendererProtocol,
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
])

let backgroundColor: string | undefined
let pluginAssetServer:
  | {
      url: string
      username?: string
      password?: string
    }
  | undefined
const browserWebviewPartition = "persist:opencode-session-browser"
const browserSidecarSessions = new WeakSet<Session>()
let relaunchHandler: (reason: string) => void = (reason) => {
  writeLog("window", "app relaunch requested", { reason, fallbackHandler: true })
  app.relaunch()
  app.exit(0)
}
const titlebarThemes = new WeakMap<BrowserWindow, Partial<TitlebarTheme>>()
const pinchZoomEnabled = new WeakMap<BrowserWindow, boolean>()
const titlebarHeight = 40
const maxZoomLevel = 10
const minZoomLevel = 0.2

export function setRelaunchHandler(handler: (reason: string) => void) {
  relaunchHandler = handler
}

export function setBackgroundColor(color: string) {
  backgroundColor = color
  BrowserWindow.getAllWindows().forEach((win) => win.setBackgroundColor(color))
}

export function getBackgroundColor(): string | undefined {
  return backgroundColor
}

export function setPluginAssetServer(server: typeof pluginAssetServer) {
  pluginAssetServer = server
}

function iconsDir() {
  return app.isPackaged ? join(process.resourcesPath, "icons") : join(root, "../../resources/icons")
}

export function iconPath() {
  const ext = process.platform === "win32" ? "ico" : "png"
  return join(iconsDir(), `icon.${ext}`)
}

function tone() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light"
}

function defaultBackgroundColor() {
  return oc2Background[tone()]
}

function overlay(theme: Partial<TitlebarTheme> = {}, zoom = 1) {
  const mode = theme.mode ?? tone()
  return {
    color: "#00000000",
    symbolColor: mode === "dark" ? "white" : "black",
    height: Math.max(titlebarHeight, Math.round(titlebarHeight * zoom)),
  }
}

export function setTitlebar(win: BrowserWindow, theme: Partial<TitlebarTheme> = {}) {
  titlebarThemes.set(win, theme)
  updateTitlebar(win)
}

export function updateTitlebar(win: BrowserWindow) {
  if (process.platform !== "win32") return
  win.setTitleBarOverlay(overlay(titlebarThemes.get(win), win.webContents.getZoomFactor()))
}

export function setPinchZoomEnabled(enabled: boolean) {
  getStore().set(PINCH_ZOOM_ENABLED_KEY, enabled)
  for (const win of BrowserWindow.getAllWindows()) {
    pinchZoomEnabled.set(win, enabled)
    win.webContents.send("pinch-zoom-enabled-changed", enabled)
    if (!enabled && win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1)
    updateZoom(win)
  }
}

export function getPinchZoomEnabled() {
  return getStore().get(PINCH_ZOOM_ENABLED_KEY) === true
}

export function setDockIcon() {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(join(iconsDir(), "dock.png"))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

export function createMainWindow(route = "/") {
  const state = windowState({
    defaultWidth: 1280,
    defaultHeight: 800,
  })

  const mode = tone()
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: false,
    autoHideMenuBar: true,
    title: "OpenCode",
    icon: iconPath(),
    backgroundColor: backgroundColor ?? defaultBackgroundColor(),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: { x: 12, y: 14 },
        }
      : {}),
    ...(process.platform === "win32"
      ? {
          frame: false,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: overlay({ mode }),
        }
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  })

  allowRendererPermissions(win)
  wireWebviewSecurity(win)
  wireWindowRecovery(win, "main")
  createPaintRecovery(win, "main")

  win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    const { requestHeaders } = details
    upsertKeyValue(requestHeaders, "Access-Control-Allow-Origin", ["*"])
    callback({ requestHeaders })
  })

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const { responseHeaders = {} } = details
    addRendererHeaders(details.url, responseHeaders)
    callback({ responseHeaders })
  })

  state.manage(win)
  loadWindowWhenCacheIsFresh(win, rendererEntry(route))
  wireZoom(win)

  const show = () => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }
  win.once("ready-to-show", show)
  win.webContents.once("did-finish-load", show)
  win.webContents.once("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    writeLog("window", "main window failed to load", { errorCode, errorDescription, validatedURL }, "error")
    show()
  })
  setTimeout(show, 5_000).unref()

  return win
}

function rendererEntry(route: string) {
  const value = route.trim()
  if (!value || value === "/") return "index.html"
  if (value.startsWith("//")) return "index.html"
  if (!value.startsWith("/") && !value.startsWith("?")) return "index.html"

  try {
    const url = new URL(value.startsWith("?") ? `/${value}` : value, "https://renderer")
    if (url.pathname !== "/") return "index.html"
    return `index.html${url.search}${url.hash}`
  } catch {
    return "index.html"
  }
}

export function registerRendererProtocol() {
  if (protocol.isProtocolHandled(rendererProtocol)) return

  protocol.handle(rendererProtocol, async (request) => {
    const url = new URL(request.url)
    if (url.host === pluginHost) return fetchPluginAsset(request)

    if (url.host !== rendererHost) {
      writeLog("protocol", "rejected host", { url: request.url }, "warn")
      return new Response("Not found", { status: 404 })
    }

    if (url.pathname.startsWith("/app/plugin/")) return fetchPluginAsset(request)

    const file = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`)
    const rel = relative(rendererRoot, file)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      writeLog("protocol", "rejected path", { url: request.url, file }, "warn")
      return new Response("Not found", { status: 404 })
    }

    try {
      const response = await net.fetch(pathToFileURL(file).toString())
      if (response.status >= 400) {
        writeLog(
          "protocol",
          "fetch failed",
          {
            url: request.url,
            file,
            status: response.status,
            statusText: response.statusText,
          },
          "error",
        )
      }
      return addRendererResponseHeaders(response, file)
    } catch (error) {
      writeLog("protocol", "fetch error", { url: request.url, file, error }, "error")
      return new Response("Not found", { status: 404 })
    }
  })
}

async function fetchPluginAsset(request: Request) {
  const server = pluginAssetServer
  if (!server) return new Response("Plugin asset server not ready", { status: 503 })

  const target = pluginAssetTarget(server.url, request.url)
  if (!target) {
    writeLog("protocol", "rejected plugin asset path", { url: request.url }, "warn")
    return new Response("Not found", { status: 404 })
  }

  const headers = new Headers()
  if (server.password) {
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")}`,
    )
  }

  // Drop any renderer-supplied query/hash and the original request headers —
  // the destination URL is built strictly from the trusted server.url plus
  // the validated pathname segments, then re-encoded.
  try {
    return await net.fetch(target, { headers })
  } catch (error) {
    writeLog("protocol", "plugin asset fetch error", { url: request.url, target, error }, "error")
    return new Response("Not found", { status: 404 })
  }
}

function loadWindow(win: BrowserWindow, html: string) {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(html, devUrl)
    void win.loadURL(url.toString())
    return
  }

  void win.loadURL(`${rendererProtocol}://${rendererHost}/${html}`)
}

function loadWindowWhenCacheIsFresh(win: BrowserWindow, html: string) {
  // Local ASAR redeploys replace hashed Vite chunks while the Electron cache can
  // still point at the previous bundle. Clear it before loading the renderer so
  // lazy imports like the terminal's ghostty-web chunk resolve from this build.
  void (app.isPackaged
    ? win.webContents.session.clearCache().catch((error) => {
        writeLog("window", "failed to clear renderer cache", { error }, "warn")
      })
    : Promise.resolve()
  ).then(() => {
    if (win.isDestroyed()) return
    loadWindow(win, html)
  })
}

function wireWindowRecovery(win: BrowserWindow, name: string) {
  let showing = false
  const sampler = createUnresponsiveSampler(win, name)

  const handle = async (button: string | undefined, wait: boolean, reason: string) => {
    if (button === "Export Logs") {
      const sampling = sampler.stopAndFlush()
      await exportDebugLogs().catch((error) => writeLog("main", "failed to export debug logs", { error }, "error"))
      if (wait && sampling) sampler.start()
      return true
    }
    if (button === "Relaunch") {
      sampler.stopAndFlush()
      relaunchHandler(reason)
      return false
    }
    if (button === "Quit") {
      sampler.stopAndFlush()
      app.quit()
    }
    return false
  }

  const show = async (message: string, detail: string, wait: boolean, reason: string) => {
    if (showing || win.isDestroyed()) return
    showing = true
    try {
      while (!win.isDestroyed()) {
        const buttons = wait ? ["Relaunch", "Export Logs", "Keep Waiting"] : ["Relaunch", "Export Logs", "Quit"]
        const result = await dialog.showMessageBox(win, {
          type: "warning",
          buttons,
          defaultId: 0,
          cancelId: 2,
          message,
          detail,
        })
        if (await handle(buttons[result.response], wait, reason)) continue
        return
      }
    } finally {
      showing = false
    }
  }

  const failed = (
    event: string,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean,
  ) => {
    writeLog(
      "window",
      "renderer load failed",
      {
        window: name,
        event,
        errorCode,
        errorDescription,
        validatedURL,
        currentURL: win.webContents.getURL(),
        isMainFrame,
      },
      "error",
    )

    if (!isMainFrame || errorCode === -3) return
    void show(
      "OpenCode failed to load",
      [`Window: ${name}`, `URL: ${validatedURL}`, `Error: ${errorCode} ${errorDescription}`].join("\n"),
      false,
      "load-failed-dialog",
    )
  }

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    failed("did-fail-load", errorCode, errorDescription, validatedURL, isMainFrame)
  })
  win.webContents.on("did-fail-provisional-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    failed("did-fail-provisional-load", errorCode, errorDescription, validatedURL, isMainFrame)
  })
  win.webContents.on("render-process-gone", (_event, details) => {
    sampler.stopAndFlush()
    writeLog(
      "window",
      "renderer process gone",
      { window: name, currentURL: win.webContents.getURL(), details },
      "error",
    )
    void show(
      "OpenCode window terminated unexpectedly",
      [`Window: ${name}`, `Reason: ${details.reason}`, `Code: ${details.exitCode ?? "<unknown>"}`].join("\n"),
      false,
      "render-process-gone-dialog",
    )
  })
  win.on("unresponsive", () => {
    writeLog("window", "renderer unresponsive", { window: name, currentURL: win.webContents.getURL() }, "error")
    sampler.start()
    void show("OpenCode is not responding", "You can relaunch the app, open the logs, or keep waiting.", true, "unresponsive-dialog")
  })
  win.on("responsive", () => {
    writeLog("window", "renderer responsive", { window: name, currentURL: win.webContents.getURL() }, "error")
    sampler.stopAndFlush()
  })
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (message.toLowerCase().includes("terminal") || sourceId.toLowerCase().includes("terminal")) {
      writeLog("pty", "console", { window: name, level, message, line, sourceId })
    }
  })
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    writeLog("preload", "preload error", { window: name, preloadPath, error }, "error")
  })
}

function addRendererResponseHeaders(response: Response, file: string) {
  const headers = new Headers(response.headers)
  // The renderer is bundled into app.asar and addressed by hashed chunk names;
  // caching stale oc://renderer responses can make later lazy imports 404.
  setNoStoreHeaders(headers)
  if (file.toLowerCase().endsWith(".html")) headers.set(documentPolicyHeader, jsCallStacksDocumentPolicy)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function allowRendererPermissions(win: BrowserWindow) {
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      rendererPermissionAllowed({
        permission,
        trusted: isTrustedRendererUrl(details.requestingUrl),
        mainContents: webContents.id === win.webContents.id,
        mediaTypes: permission === "media" ? (details as MediaAccessPermissionRequest).mediaTypes : undefined,
      }),
    )
  })
  win.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return rendererPermissionAllowed({
      permission,
      trusted: isTrustedRendererUrl(details.requestingUrl) || isTrustedRendererUrl(requestingOrigin),
      mainContents: webContents?.id === win.webContents.id,
      mediaType: details.mediaType,
    })
  })
}

function wireWebviewSecurity(win: BrowserWindow) {
  // Register before the first guest is attached. `did-attach-webview` can run
  // after its first navigation has already begun, which loses the initial
  // sidecar Basic-auth request and leaves the browser on an empty 401 page.
  wireBrowserSidecarAuthorization(session.fromPartition(browserWebviewPartition))

  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!isAllowedBrowserUrl(params.src)) {
      event.preventDefault()
      return
    }

    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
  })

  win.webContents.on("did-attach-webview", (_event, contents) => {
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    contents.session.setPermissionCheckHandler(() => false)
    if (contents.session === session.fromPartition(browserWebviewPartition)) {
      wireBrowserSidecarAuthorization(contents.session)
    }
    contents.setWindowOpenHandler(({ url }) => {
      if (!isAllowedBrowserUrl(url)) return { action: "deny" }
      void shell.openExternal(url)
      return { action: "deny" }
    })
    contents.on("will-navigate", (event, url) => {
      if (isAllowedBrowserUrl(url)) return
      event.preventDefault()
    })
  })
}

function wireBrowserSidecarAuthorization(browserSession: Session) {
  if (browserSidecarSessions.has(browserSession)) return
  browserSidecarSessions.add(browserSession)
  browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const authorization = sidecarBrowserAuthorization(details.url, pluginAssetServer)
    if (authorization) upsertKeyValue(details.requestHeaders, "Authorization", [authorization])
    callback({ requestHeaders: details.requestHeaders })
  })
  app.on("login", (event, contents, request, authInfo, callback) => {
    if (!ownsSidecarLogin(contents, browserSession, authInfo.isProxy)) return
    if (!sidecarBrowserAuthorization(request.url, pluginAssetServer)) return
    event.preventDefault()
    callback(pluginAssetServer?.username ?? "opencode", pluginAssetServer?.password ?? "")
  })
}

function isTrustedRendererUrl(value?: string) {
  return isRendererUrl(value)
}

function addRendererHeaders(value: string, headers: Record<string, any>) {
  upsertKeyValue(headers, "Access-Control-Allow-Origin", ["*"])
  upsertKeyValue(headers, "Access-Control-Allow-Headers", ["*"])
  if (isRendererProtocolUrl(value)) setNoStoreHeaderRecord(headers)
  if (isRendererUrl(value, true)) upsertKeyValue(headers, documentPolicyHeader, [jsCallStacksDocumentPolicy])
}

function isRendererUrl(value?: string, html = false) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  if (html && !url.pathname.endsWith(".html")) return false
  if (url.protocol === `${rendererProtocol}:` && url.host === rendererHost) return true
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!devUrl || !URL.canParse(devUrl)) return false
  return url.origin === new URL(devUrl).origin
}

function isRendererProtocolUrl(value?: string) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === `${rendererProtocol}:` && url.host === rendererHost
}

function setNoStoreHeaders(headers: Headers) {
  headers.set("Cache-Control", rendererCacheControl)
  headers.set("Pragma", "no-cache")
  headers.set("Expires", "0")
}

function setNoStoreHeaderRecord(headers: Record<string, any>) {
  upsertKeyValue(headers, "Cache-Control", [rendererCacheControl])
  upsertKeyValue(headers, "Pragma", ["no-cache"])
  upsertKeyValue(headers, "Expires", ["0"])
}

function wireZoom(win: BrowserWindow) {
  pinchZoomEnabled.set(win, getPinchZoomEnabled())
  win.webContents.setZoomFactor(1)
  win.webContents.on("zoom-changed", (event, zoomDirection) => {
    event.preventDefault()
    if (pinchZoomEnabled.get(win)) {
      win.webContents.setZoomFactor(clampZoom(win.webContents.getZoomFactor() + (zoomDirection === "in" ? 0.2 : -0.2)))
      updateZoom(win)
      return
    }
    if (win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1)
    updateZoom(win)
  })
}

function clampZoom(value: number) {
  return Math.min(Math.max(value, minZoomLevel), maxZoomLevel)
}

function updateZoom(win: BrowserWindow) {
  updateTitlebar(win)
  win.webContents.send("zoom-factor-changed", win.webContents.getZoomFactor())
}

function upsertKeyValue(obj: Record<string, any>, keyToChange: string, value: any) {
  const keyToChangeLower = keyToChange.toLowerCase()
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === keyToChangeLower) {
      // Reassign old key
      obj[key] = value
      // Done
      return
    }
  }
  // Insert at end instead
  obj[keyToChange] = value
}
