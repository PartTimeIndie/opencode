import { randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import * as http from "node:http"
import { join } from "node:path"
import { BrowserWindow, desktopCapturer, ipcMain, nativeImage } from "electron"
import type { IpcMainInvokeEvent, NativeImage } from "electron"
import { getBrowserAutomationEnabled } from "./browser-automation"
import { createBrowserAutomation } from "./browser-control"
import { browserTransferGuard } from "./browser-transfer-guard"
import { resolveDesktopTestingCli } from "./desktop-testing-cli"
import {
  parseDesktopTestingSessionModel,
  resumeDesktopTestingSession,
  runDesktopTestingSession,
} from "./desktop-testing-session"
import { desktopTestingRendererTimeout } from "./desktop-testing-timeout"
import { checkHealth } from "./server"
import { liveWindow } from "./window-lifecycle"

type ServerReady = {
  url: string
  username: string | null
  password: string | null
}
type Logger = {
  log(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
}

type StartInput = {
  app: {
    version: string
    channel: string
    packaged: boolean
    userDataPath: string
    cdpPort?: string
  }
  getWindow: () => BrowserWindow | null
  getSpeechOverlay?: () => BrowserWindow | undefined
  getDesktopServices?: () => unknown
  getSidecar: () => ServerReady | null
  quit: () => void
  logger: Logger
}

type RendererResponse =
  | { ok: true; result: unknown }
  | {
      ok: false
      error: string
    }

type PendingRendererRequest = {
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

type CliRunInput = {
  agent?: string
  directory?: string
  model?: {
    providerID: string
    id: string
    variant?: string
  }
  prompt?: string
  visible?: boolean
  waitMs?: number
}

const pendingRendererRequests = new Map<string, PendingRendererRequest>()
let responseHandlerRegistered = false
let browserAutomation: ReturnType<typeof createBrowserAutomation> | undefined

export async function startDesktopTestingServer(input: StartInput) {
  if (!getBrowserAutomationEnabled()) return
  registerResponseHandler()
  browserAutomation = createBrowserAutomation({
    transferGuard: browserTransferGuard,
    status: () =>
      requestRenderer(input, "action", { type: "browser.status" }) as Promise<{ browser?: Record<string, unknown> }>,
  })

  const token = randomUUID()
  const server = http.createServer((request, response) => {
    void handleRequest(input, token, request, response).catch((error) => {
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address !== "object") throw new Error("Desktop testing server did not expose a TCP port")
  const url = `http://127.0.0.1:${address.port}`
  const tokenPath = join(input.app.userDataPath, "desktop-testing.json")
  await writeFile(
    tokenPath,
    JSON.stringify({ url, token, pid: process.pid, startedAt: new Date().toISOString(), ...cdpInfo(input) }, null, 2),
  )
  input.logger.log("desktop testing bridge started", { url, tokenPath })

  return {
    url,
    tokenPath,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

function registerResponseHandler() {
  if (responseHandlerRegistered) return
  responseHandlerRegistered = true
  ipcMain.handle("desktop-testing-response", (_event: IpcMainInvokeEvent, id: string, response: RendererResponse) => {
    const pending = pendingRendererRequests.get(id)
    if (!pending) return false
    pendingRendererRequests.delete(id)
    clearTimeout(pending.timeout)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(new Error(response.error))
    return true
  })
}

async function handleRequest(
  input: StartInput,
  token: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true })
    return
  }
  if (!authorized(request, token)) {
    sendJson(response, 401, { ok: false, error: "Unauthorized" })
    return
  }
  if (request.method === "GET" && url.pathname === "/status") {
    sendJson(response, 200, await status(input))
    return
  }
  if (request.method === "POST" && url.pathname === "/action") {
    const body = await readJson(request)
    const action = isRecord(body) && "action" in body ? body.action : body
    sendJson(response, 200, await actionRequest(input, action))
    return
  }
  if (request.method === "POST" && url.pathname === "/screenshot") {
    sendJson(response, 200, await screenshot(input, await readJson(request)))
    return
  }
  if (request.method === "POST" && url.pathname === "/screen-state") {
    const body = await readJson(request)
    const capture = await screenshot(input, body)
    const state = await requestRenderer(input, "screen-state").catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }))
    sendJson(response, 200, { ...capture, state })
    return
  }
  if (request.method === "POST" && url.pathname === "/cli/run") {
    sendJson(response, 200, await runCli(input, (await readJson(request)) as CliRunInput))
    return
  }
  if (request.method === "POST" && url.pathname === "/shutdown/prepare-recovery") {
    sendJson(response, 200, {
      ok: true,
      renderer: await requestRenderer(input, "prepare-recovery").catch((error) => ({ error: String(error) })),
    })
    return
  }
  sendJson(response, 404, { ok: false, error: "Not found" })
}

async function status(input: StartInput) {
  const win = liveWindow(input.getWindow())
  return {
    app: input.app,
    cdp: cdpInfo(input),
    window: {
      count: BrowserWindow.getAllWindows().length,
      focused: win?.isFocused() ?? false,
      visible: win?.isVisible() ?? false,
      url: win?.webContents.getURL() ?? null,
      title: win?.getTitle() ?? null,
    },
    sidecar: await redactSidecar(input.getSidecar()),
    desktopServices: input.getDesktopServices?.(),
    renderer: await requestRenderer(input, "action", { type: "app.status" }).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    })),
  }
}

async function actionRequest(input: StartInput, action: unknown) {
  if (!isRecord(action) || typeof action.type !== "string") throw new Error("Action requires a string type")
  if (action.type === "session.resume") {
    const sidecar = input.getSidecar()
    if (!sidecar) throw new Error("OpenCode sidecar is not available")
    if (typeof action.sessionID !== "string") throw new Error("session.resume requires sessionID")
    if (typeof action.directory !== "string") throw new Error("session.resume requires directory")
    return resumeDesktopTestingSession({ sidecar, sessionID: action.sessionID, directory: action.directory })
  }
  const browser = await handleBrowserAction(action)
  if (browser !== undefined) return browser
  const handled = handleWindowAction(input, action.type)
  if (handled) return handled
  return requestRenderer(input, "action", action)
}

async function handleBrowserAction(action: Record<string, unknown>) {
  if (!browserAutomation) return
  const timeout = optionalNumber(action.timeout)
  if (action.type === "browser.snapshot")
    return browserAutomation.snapshot({
      screenshot: action.screenshot === true,
      maxTextChars: optionalNumber(action.maxTextChars),
      maxElements: optionalNumber(action.maxElements),
      timeout,
      expectedOrigin: optionalString(action.expectedOrigin),
    })
  if (action.type === "browser.click")
    return browserAutomation.click({
      ...targetAction(action),
      button: action.button === "right" || action.button === "middle" ? action.button : "left",
      timeout,
      expectedOrigin: optionalString(action.expectedOrigin),
    })
  if (action.type === "browser.type") {
    if (typeof action.text !== "string") throw new Error("browser.type requires text")
    return browserAutomation.type({
      ...targetAction(action),
      text: action.text,
      clear: action.clear !== false,
      pressEnter: action.pressEnter === true,
      timeout,
      expectedOrigin: optionalString(action.expectedOrigin),
    })
  }
  if (action.type === "browser.wait")
    return browserAutomation.wait({
      ...targetAction(action, false),
      text: optionalString(action.text),
      state:
        action.state === "hidden" || action.state === "attached" || action.state === "detached"
          ? action.state
          : "visible",
      milliseconds: optionalNumber(action.milliseconds),
      timeout,
      expectedOrigin: optionalString(action.expectedOrigin),
    })
}

function targetAction(action: Record<string, unknown>, required = true) {
  const ref = optionalString(action.ref)
  const selector = optionalString(action.selector)
  if (ref && selector) throw new Error("Browser action accepts either ref or selector, not both")
  if (required && !ref && !selector) throw new Error("Browser action requires ref or selector")
  return { ref, selector }
}

function optionalString(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function optionalNumber(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function handleWindowAction(input: StartInput, type: string) {
  if (type === "app.quit") {
    // A bridge caller ends the whole desktop app; record the request origin so
    // shutdowns triggered through the testing bridge stay attributable.
    input.logger.log("app quit requested", { source: "desktop-testing-bridge" })
    setTimeout(input.quit, 0)
    return { ok: true }
  }
  const win = liveWindow(input.getWindow())
  if (!win) throw new Error("OpenCode window is not available")
  if (type === "window.show") {
    win.show()
    return { ok: true }
  }
  if (type === "window.hide") {
    win.hide()
    return { ok: true }
  }
  if (type === "window.focus") {
    win.focus()
    return { ok: true }
  }
  if (type === "window.reload") {
    win.webContents.reload()
    return { ok: true }
  }
  if (type === "window.toggleDevTools") {
    win.webContents.toggleDevTools()
    return { ok: true }
  }
}

async function screenshot(input: StartInput, body: unknown) {
  const overlay = isRecord(body) && body.target === "speech-overlay"
  const win = liveWindow(overlay ? input.getSpeechOverlay?.() : input.getWindow())
  if (!win) throw new Error("OpenCode window is not available")
  const capture = await captureWindowImage(win, !overlay)
  const dir = process.env.OPENCODE_DESKTOP_SCREENSHOT_DIR ?? join(input.app.userDataPath, "desktop-testing-screenshots")
  await mkdir(dir, { recursive: true })
  const screenshotPath = join(
    dir,
    `${overlay ? "speech-overlay" : "desktop"}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
  )
  await writeFile(screenshotPath, capture.image.toPNG())
  const includeBase64 = isRecord(body) && body.includeBase64 === true
  return {
    ok: true,
    screenshotPath,
    size: capture.image.getSize(),
    captureMethod: capture.method,
    probablyBlank: capture.probablyBlank,
    ...(includeBase64 ? { screenshotBase64: capture.image.toPNG().toString("base64") } : {}),
  }
}

async function captureWindowImage(win: BrowserWindow, focus: boolean) {
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  if (focus) win.focus()
  await delay(100)
  const captures = [
    () => captureWebContents(win),
    () => captureDevTools(win, true),
    () => captureDevTools(win, false),
    () => captureDesktopSource(win),
  ]
  let blankCapture: CapturedWindowImage | undefined
  let lastError: unknown
  for (const capture of captures) {
    try {
      const result = await capture()
      if (!result.probablyBlank) return result
      blankCapture ??= result
    } catch (error) {
      lastError = error
    }
  }
  if (blankCapture) return blankCapture
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Window capture failed"))
}

type CapturedWindowImage = {
  image: NativeImage
  method: string
  probablyBlank: boolean
}

async function captureWebContents(win: BrowserWindow): Promise<CapturedWindowImage> {
  const image = await win.webContents.capturePage()
  return { image, method: "webContents.capturePage", probablyBlank: isProbablyBlank(image) }
}

async function captureDevTools(win: BrowserWindow, fromSurface: boolean): Promise<CapturedWindowImage> {
  const debuggerApi = win.webContents.debugger
  const attached = debuggerApi.isAttached()
  try {
    if (!attached) debuggerApi.attach("1.3")
    const result = (await debuggerApi.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface,
      captureBeyondViewport: false,
    })) as { data?: string }
    if (!result.data) throw new Error("DevTools screenshot did not return image data")
    const image = nativeImage.createFromBuffer(Buffer.from(result.data, "base64"))
    return {
      image,
      method: `devtools.Page.captureScreenshot:${fromSurface ? "surface" : "view"}`,
      probablyBlank: isProbablyBlank(image),
    }
  } finally {
    if (!attached && debuggerApi.isAttached()) debuggerApi.detach()
  }
}

async function captureDesktopSource(win: BrowserWindow): Promise<CapturedWindowImage> {
  const bounds = win.getBounds()
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: {
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
    },
    fetchWindowIcons: false,
  })
  const title = win.getTitle()
  const source =
    sources.find((item) => item.name === title) ??
    sources.find((item) => title && item.name.includes(title)) ??
    sources.find((item) => item.name.includes("OpenCode"))
  if (!source || source.thumbnail.isEmpty()) throw new Error("Desktop source screenshot did not return image data")
  return { image: source.thumbnail, method: "desktopCapturer.window", probablyBlank: isProbablyBlank(source.thumbnail) }
}

function isProbablyBlank(image: NativeImage) {
  if (image.isEmpty()) return true
  const bitmap = image.resize({ width: 64, height: 64, quality: "good" }).toBitmap()
  if (bitmap.length === 0) return true
  const first = bitmap[0] ?? 0
  let min = first
  let max = first
  for (const value of bitmap) {
    min = Math.min(min, value)
    max = Math.max(max, value)
    if (max - min > 16) return false
  }
  return true
}

function requestRenderer(input: StartInput, type: "action" | "screen-state" | "prepare-recovery", payload?: unknown) {
  const win = liveWindow(input.getWindow())
  if (!win) return Promise.reject(new Error("OpenCode window is not available"))
  const id = randomUUID()
  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        pendingRendererRequests.delete(id)
        reject(new Error(`Desktop testing renderer request timed out: ${type}`))
      },
      desktopTestingRendererTimeout(type, payload),
    )
    pendingRendererRequests.set(id, { resolve, reject, timeout })
    win.webContents.send("desktop-testing-request", { id, type, payload })
  })
}

async function runCli(app: StartInput, input: CliRunInput) {
  const status = await desktopAppStatus(app)
  const directory = input.directory ?? activeWorkspaceDirectory(status)
  const sidecar = app.getSidecar()
  if (sidecar && directory && input.prompt !== undefined) {
    return runDesktopTestingSession({
      sidecar,
      directory,
      agent: input.agent,
      model: input.model ?? defaultDesktopTestingModel(status),
      prompt: input.prompt,
      waitMs: input.waitMs,
      openSession: input.visible
        ? (sessionID) => requestRenderer(app, "action", { type: "session.open", sessionID, directory })
        : undefined,
    })
  }

  const args = [
    "run",
    "--format",
    "json",
    ...(input.agent ? ["--agent", input.agent] : []),
    ...(input.model ? ["--model", `${input.model.providerID}/${input.model.id}`] : []),
    ...(input.model?.variant ? ["--variant", input.model.variant] : []),
  ]
  const cli = resolveDesktopTestingCli({ ...input, directory }, args)
  const child = spawn(cli.command, cli.args, {
    cwd: cli.cwd,
    env: { ...process.env, OPENCODE_CLIENT: "desktop-testing" },
    windowsHide: input.visible !== true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
  child.on("error", () => undefined)

  try {
    if (input.prompt !== undefined) child.stdin.write(input.prompt)
    child.stdin.end()
  } catch (error) {
    child.kill()
    return cliErrorResult(child.pid, error, stdout, stderr)
  }

  const waitMs = input.waitMs ?? 0
  if (waitMs <= 0) {
    return { ok: true, pid: child.pid }
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (value: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({
        ok: false,
        pid: child.pid,
        timedOut: true,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    }, waitMs)
    child.on("error", (error) => {
      finish(cliErrorResult(child.pid, error, stdout, stderr))
    })
    child.on("exit", (code) => {
      finish({
        ok: code === 0,
        pid: child.pid,
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    })
  })
}

async function desktopAppStatus(input: StartInput) {
  return requestRenderer(input, "action", { type: "app.status" }).catch(() => undefined)
}

function activeWorkspaceDirectory(status: unknown) {
  if (!isRecord(status)) return
  const route = status.route
  if (isRecord(route) && typeof route.dir === "string") return route.dir
}

function defaultDesktopTestingModel(status: unknown) {
  if (!isRecord(status) || !isRecord(status.defaultModel)) return
  return parseDesktopTestingSessionModel(status.defaultModel)
}

function cliErrorResult(pid: number | undefined, error: unknown, stdout: Buffer[], stderr: Buffer[]) {
  return {
    ok: false,
    pid,
    error: error instanceof Error ? error.message : String(error),
    code: isRecord(error) && typeof error.code === "string" ? error.code : undefined,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  }
}

async function readJson(request: http.IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    if (Buffer.concat(chunks).length > 1_000_000) throw new Error("Request body is too large")
  }
  const text = Buffer.concat(chunks).toString("utf8").trim()
  if (!text) return {}
  return JSON.parse(text) as unknown
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown) {
  const json = JSON.stringify(body)
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
  })
  response.end(json)
}

function authorized(request: http.IncomingMessage, token: string) {
  if (request.headers["x-opencode-desktop-token"] === token) return true
  return request.headers.authorization === `Bearer ${token}`
}

async function redactSidecar(sidecar: ServerReady | null) {
  if (!sidecar) return { healthy: false }
  const healthy = await checkHealth(sidecar.url, sidecar.password, 1_000)
  return {
    url: sidecar.url,
    username: sidecar.username ?? undefined,
    healthy,
    password: sidecar.password ? "<redacted>" : undefined,
  }
}

function cdpInfo(input: StartInput) {
  if (!input.app.cdpPort) return {}
  return {
    cdpPort: input.app.cdpPort,
    cdpUrl: `http://127.0.0.1:${input.app.cdpPort}`,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
