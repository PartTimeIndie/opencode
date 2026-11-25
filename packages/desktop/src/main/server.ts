import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import type { Details } from "electron"
import { getLogger } from "./logging"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"
import { DEFAULT_SERVER_URL_KEY } from "./store-keys"
import { setTimeout } from "node:timers/promises"
import { createServerSupervisor, type ServerState } from "./server-supervisor"
import { createSidecarStop, forceSidecarStop } from "./sidecar-stop"
import { formatSidecarFatalError } from "./sidecar-fatal-error"
import { createSidecarActivityLog, parseSidecarDiagnostic, type SidecarActivityUpdate, type SidecarDiagnostic } from "./sidecar-diagnostics"

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "execution-owner"; ownerID: string }
  | { type: "diagnostic"; sample: SidecarDiagnostic }
  | { type: "activity"; update: SidecarActivityUpdate }
  | { type: "error"; error: { message: string; stack?: string } }

export type SidecarListener = {
  stop: () => Promise<void>
  forceStop: () => Promise<void>
  retry: () => void
  snapshot: () => ServerState
}

export type SidecarExit = {
  pid: number | undefined
  uptimeMs: number
  activity?: ReturnType<ReturnType<typeof createSidecarActivityLog>["snapshot"]>
  lastSample?: SidecarDiagnostic & { sampledAt: number }
}

const SIDECAR_SERVICE_NAME = "opencode server"

type SpawnLocalServerOptions = {
  userDataPath: string
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onSpawn?: (pid: number | undefined) => void
  onDiagnostic?: (sample: SidecarDiagnostic & { pid: number | undefined }) => void
  onExit?: (code: number, detail: SidecarExit) => void
  onState?: (state: ServerState) => void
}

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export function preferAppEnv(userDataPath: string, browserAutomationEnabled: boolean) {
  const shell = process.platform === "win32" ? null : getUserShell()
  Object.assign(process.env, {
    ...(shell ? loadShellEnv(shell, getLogger()) : null),
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    // The Windows native watcher can terminate the entire desktop sidecar (watcher.node / 0xc0000409).
    ...(process.platform === "win32" ? { OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true" } : {}),
    OPENCODE_CLIENT: "desktop",
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
  if (browserAutomationEnabled) {
    process.env.OPENCODE_DESKTOP_BRIDGE_FILE = join(userDataPath, "desktop-testing.json")
    return
  }
  delete process.env.OPENCODE_DESKTOP_BRIDGE_FILE
}

export async function spawnLocalServer(
  hostname: string,
  port: number,
  password: string,
  options: SpawnLocalServerOptions,
) {
  const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
  const previousOwners = new Set<string>()
  const supervisor = createServerSupervisor({
    changed: (state) => options.onState?.(state),
    error: (error) => options.onStderr?.(`sidecar recovery failed: ${serializeError(error).message}`),
    spawn: () => {
      const ownerID = `desktop_${randomUUID()}`
      const spawnedAt = Date.now()
      let acknowledged = false
      const child = utilityProcess.fork(sidecar, [], {
        cwd: process.cwd(),
        env: createSidecarEnv(),
        serviceName: SIDECAR_SERVICE_NAME,
        stdio: "pipe",
      })
      let pid = child.pid
      const activity = createSidecarActivityLog()
      let lastSample: (SidecarDiagnostic & { sampledAt: number }) | undefined
      child.once("spawn", () => { pid = child.pid; options.onSpawn?.(pid) })
      const exit = defer<number>()
      let ended = false
      const onProcessGone = (_event: unknown, details: Details) => {
        if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
        options.onStderr?.(`utility process gone pid=${pid ?? "unknown"} reason=${details.reason} exitCode=${details.exitCode}`)
      }
      app.on("child-process-gone", onProcessGone)
      child.on("message", (message: SidecarMessage) => {
        if (ended) return
        if (message.type === "execution-owner" && message.ownerID === ownerID) acknowledged = true
        if (message.type === "activity") activity.accept(message.update)
        if (message.type === "diagnostic") {
          const sample = parseSidecarDiagnostic(message.sample)
          if (!sample) return
          lastSample = { ...sample, sampledAt: Date.now() }
          options.onDiagnostic?.({ pid, ...sample })
        }
      })
      // Keep an error observer after the startup listener is removed.
      child.on("error", (type, location, report) => options.onStderr?.(formatSidecarFatalError(type, location, report)))
      child.once("exit", (code) => {
        ended = true
        if (acknowledged && supervisor.snapshot().phase !== "stopped") {
          previousOwners.add(ownerID)
          const oldest = previousOwners.values().next().value
          if (previousOwners.size > 32 && oldest) previousOwners.delete(oldest)
        }
        app.off("child-process-gone", onProcessGone)
        exit.resolve(code)
        options.onExit?.(code, {
          pid,
          uptimeMs: Date.now() - spawnedAt,
          ...(code !== 0 ? { activity: activity.snapshot(), lastSample } : {}),
        })
      })
      child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
      child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))
      return {
        exited: exit.promise,
        ready: async (signal: AbortSignal) => {
          signal.throwIfAborted()
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              child.off("message", message)
              child.off("error", fail)
              signal.removeEventListener("abort", aborted)
            }
            const fail = (error: unknown) => { cleanup(); reject(error) }
            const aborted = () => fail(signal.reason)
            const message = (value: SidecarMessage) => {
              if (value.type === "ready") { cleanup(); resolve() }
              if (value.type === "error") fail(new Error(value.error.message))
            }
            signal.addEventListener("abort", aborted, { once: true })
            child.on("message", message)
            child.on("error", fail)
            child.postMessage({ type: "start", hostname, port, password, userDataPath: options.userDataPath,
              recovery: { ownerID, previousOwners: [...previousOwners] },
            })
          })
          while (!signal.aborted) {
            if (await checkHealth(`http://${hostname}:${port}`, password, 3000, signal)) return
            await setTimeout(100, undefined, { signal })
          }
          signal.throwIfAborted()
        },
        stop: createSidecarStop({ requestStop: () => child.postMessage({ type: "stop" }), exited: exit.promise, isExited: () => ended }),
        forceStop: () => forceSidecarStop({ kill: () => { child.kill() }, exited: exit.promise, isExited: () => ended }),
      }
    },
  })
  // Publish the listener immediately so quitting during startup can cancel it.
  const health = supervisor.start()
  return { listener: supervisor, health: { wait: health } }
}

export async function checkHealth(url: string, password?: string | null, timeoutMs = 3000, signal?: AbortSignal): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`opencode:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

function createSidecarEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  if (process.platform === "linux") delete env.LD_PRELOAD
  if (!app.isPackaged) env.OPENCODE_DISABLE_CHANNEL_DB = "1"
  if (app.isPackaged) {
    env.OPENCODE_PROVIDER_PLUGIN_DIR = join(process.resourcesPath, "plugin-packages", "provider")
    env.OPENCODE_TUI_PLUGIN_DIR = join(process.resourcesPath, "plugin-packages", "tui")
  }
  // The desktop renderer must become usable even when an older OpenCode
  // process holds SQLite's writer lock. Startup repairs remain available to
  // explicit maintenance, but must not block the sidecar handshake or Bun's
  // request loop.
  env.OPENCODE_DEFER_DB_STARTUP_REPAIRS = "1"
  // Turn-completion and stale-session maintenance are durable background work.
  // Do not let an older writer lock the central DB before the desktop handshake.
  env.OPENCODE_DEFER_BACKGROUND_STARTUP = "1"
  env.OPENCODE_NODE_WORKER = join(dirname(fileURLToPath(import.meta.url)), "storage-worker.js")
  return env
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
