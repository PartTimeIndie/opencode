import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import type { Details } from "electron"
import { getLogger } from "./logging"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"
import { DEFAULT_SERVER_URL_KEY } from "./store-keys"

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

export type SidecarListener = { stop: () => Promise<void> }

const SIDECAR_SERVICE_NAME = "opencode server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000

type SpawnLocalServerOptions = {
  userDataPath: string
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
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
  let child: ReturnType<typeof utilityProcess.fork> | undefined
  let currentExit: Promise<number> | undefined
  let stopping = false
  let restartTimer: NodeJS.Timeout | undefined
  let replacementRunning = false
  let replacementPromise: Promise<void> | undefined
  let restartAttempt = 0

  const startChild = async () => {
    const nextChild = utilityProcess.fork(sidecar, [], {
      cwd: process.cwd(),
      env: createSidecarEnv(),
      serviceName: SIDECAR_SERVICE_NAME,
      stdio: "pipe",
    })
    child = nextChild
    let ready = false
    const exit = defer<number>()
    currentExit = exit.promise

    const onProcessGone = (_event: unknown, details: Details) => {
      if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
      options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
    }

    app.on("child-process-gone", onProcessGone)
    nextChild.once("exit", (code) => {
      app.off("child-process-gone", onProcessGone)
      if (child === nextChild) child = undefined
      options.onExit?.(code)
      exit.resolve(code)
      if (ready && !stopping) scheduleRestart()
    })
    nextChild.on("error", (error) => options.onStderr?.(`utility process error: ${serializeError(error).message}`))

    nextChild.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
    nextChild.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))

    await new Promise<void>((resolve, reject) => {
      let done = false
      let timeout: NodeJS.Timeout

      const fail = (error: Error) => {
        if (done) return
        done = true
        cleanup()
        reject(error)
      }

      const refreshTimeout = () => {
        clearTimeout(timeout)
        timeout = setTimeout(() => {
          fail(new Error(`Sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms: ${sidecar}`))
        }, SIDECAR_START_STALL_TIMEOUT)
      }

      const onMessage = (message: SidecarMessage) => {
        if (message.type === "ready") {
          if (done) return
          done = true
          ready = true
          cleanup()
          resolve()
          return
        }
        if (message.type === "error") {
          fail(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
        }
      }
      const onExit = (code: number) => {
        fail(new Error(`Sidecar exited before ready with code ${code}`))
      }
      const cleanup = () => {
        clearTimeout(timeout)
        nextChild.off("message", onMessage)
        nextChild.off("exit", onExit)
      }

      nextChild.on("message", onMessage)
      nextChild.on("exit", onExit)
      refreshTimeout()
      nextChild.postMessage({
        type: "start",
        hostname,
        port,
        password,
        userDataPath: options.userDataPath,
      })
    }).catch((error) => {
      if (child === nextChild) child = undefined
      nextChild.kill()
      throw error
    })

    const url = `http://${hostname}:${port}`
    let healthy = false
    const gone = exit.promise.then((code) => {
      if (healthy) return
      throw new Error(`Sidecar exited before health check passed with code ${code}`)
    })
    const readyHealth = (async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, password)) {
          healthy = true
          return
        }
      }
    })()

    return { health: Promise.race([readyHealth, gone]) }
  }

  function scheduleRestart() {
    if (stopping || restartTimer || replacementRunning) return
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(restartAttempt, 5))
    restartAttempt++
    options.onStderr?.(`sidecar restart scheduled in ${delayMs}ms`)
    restartTimer = setTimeout(() => {
      restartTimer = undefined
      const nextReplacement = runReplacement()
      replacementPromise = nextReplacement
      void nextReplacement.finally(() => {
        if (replacementPromise === nextReplacement) replacementPromise = undefined
      })
    }, delayMs)
  }

  async function runReplacement() {
    if (stopping || replacementRunning) return
    replacementRunning = true
    try {
      const replacement = await startChild()
      await replacement.health
      restartAttempt = 0
      options.onStdout?.("sidecar restart completed")
    } catch (error) {
      options.onStderr?.(`sidecar restart failed: ${serializeError(error).message}`)
      if (!stopping) scheduleRestart()
    } finally {
      replacementRunning = false
      if (!stopping && !child) scheduleRestart()
    }
  }

  const initial = await startChild().catch((error) => {
    stopping = true
    child?.kill()
    throw error
  })

  let stoppingPromise: Promise<void> | undefined

  return {
    listener: {
      stop: () => {
        if (stoppingPromise) return stoppingPromise
        stopping = true
        if (restartTimer) clearTimeout(restartTimer)
        stoppingPromise = (async () => {
          const current = child
          const exit = currentExit
          if (!current || !exit) return
          current.postMessage({ type: "stop" })
          await Promise.race([
            exit.then(() => undefined),
            delay(SIDECAR_STOP_TIMEOUT).then(() => {
              current.kill()
            }),
          ])
        })()
        return stoppingPromise
      },
    },
    health: { wait: initial.health },
  }
}

export async function checkHealth(url: string, password?: string | null, timeoutMs = 3000): Promise<boolean> {
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
      signal: AbortSignal.timeout(timeoutMs),
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

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
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
