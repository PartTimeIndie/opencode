import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow, dialog, powerMonitor, screen } from "electron"

import { Deferred, Effect, Fiber } from "effect"
import contextMenu from "electron-context-menu"

import type { ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { markAppQuitting } from "./app-state"
import { deepLinkCorrelation, installedBuildIdentity, lifecycleIdentity, quitRequestedRecord, relaunchRequestedRecord } from "./app-lifecycle"
import { refreshManagedCli } from "./cli-install"
import { CHANNEL } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { getBrowserAutomationEnabled } from "./browser-automation"
import { startDesktopTestingServer } from "./desktop-testing"
import { collectDeepLinkArgs, createDeepLinkDelivery } from "./deep-links"
import { completeHealthyInitialization, forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import {
  createMainWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setBackgroundColor,
  setDockIcon,
  setPluginAssetServer,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { migrate } from "./migrate"
import { createPluginDesktopServices } from "./plugin-desktop-services"
import { invalidateAllWindows } from "./paint-recovery"
import { createShutdownCoordinator } from "./shutdown"
import { stopWithRecovery } from "./shutdown-recovery"
import { liveWindow } from "./window-lifecycle"
import { applyCloseToTray, createTray } from "./tray"
import { showFromTray } from "./tray-lifecycle"
import { iconPath } from "./windows"
import { serverStateLabel, type ServerState } from "../preload/server-state"

const APP_NAMES: Record<string, string> = {
  dev: "OpenCode Dev",
  beta: "OpenCode Beta",
  prod: "OpenCode",
}
const APP_IDS: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}
const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let mainWindow: BrowserWindow | null = null
let server: SidecarListener | null = null
let serverReadyData: ServerReadyData | null = null
let tray: ReturnType<typeof createTray> = null
let serverState: ServerState = { phase: "starting", attempt: 0 }

function updateServerState(state: ServerState) {
  serverState = state
  tray?.setStatus(serverStateLabel(state), state.phase === "exhausted")
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("server-state", state)
  }
}

const deepLinkDelivery = createDeepLinkDelivery(collectDeepLinkArgs(process.argv))

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

async function desktopCdpPort() {
  if (!getBrowserAutomationEnabled()) return
  const configured = process.env.OPENCODE_DESKTOP_CDP_PORT ?? process.env.OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT
  if (configured) {
    const port = Number.parseInt(configured, 10)
    if (Number.isInteger(port) && port > 0 && port <= 65_535) return String(port)
    throw new Error(`Invalid desktop CDP port: ${configured}`)
  }
  return new Promise<string>((resolve, reject) => {
    const reservation = createServer()
    reservation.once("error", reject)
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address()
      if (!address || typeof address !== "object") {
        reservation.close()
        reject(new Error("Failed to reserve a desktop CDP port"))
        return
      }
      reservation.close((error) => (error ? reject(error) : resolve(String(address.port))))
    })
  })
}

function emitDeepLinks(urls: string[]) {
  deepLinkDelivery.emit(urls, (pending) => {
    const win = liveWindow(mainWindow)
    if (win) sendDeepLinks(win, pending)
  })
}

let sidecarStop: Promise<void> | undefined
function killSidecar() {
  if (sidecarStop) return sidecarStop
  if (!server) return
  const current = server
  writeLog("utility", "sidecar stop requested", { ...quitRequestedRecord("sidecar-stop") })
  sidecarStop = stopWithRecovery({
    stop: () => current.stop(),
    choose: async (error) => {
      logger.error("local server shutdown blocked", error)
      const result = await dialog.showMessageBox({
        type: "warning",
        title: "Local server is not responding",
        message: "The local server has not stopped.",
        detail: "Wait and try again, or force it to stop. Forcing may interrupt active sessions and lose unfinished work or writes.",
        buttons: ["Try again", "Force quit", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      return result.response === 1 ? "force" : result.response === 0 ? "retry" : "cancel"
    },
    force: async () => {
      logger.warn("user requested forced local server shutdown")
      try {
        await current.forceStop()
      } catch (error) {
        await dialog.showMessageBox({ type: "error", title: "Server still running", message: "The server exit could not be confirmed. OpenCode will remain open." })
        throw error
      }
    },
  }).then(() => {
    if (server !== current) return
    server = null
    setPluginAssetServer(undefined)
  }).finally(() => { sidecarStop = undefined })
  return sidecarStop
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.opencode.desktop.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.OPENCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "OpenCode Dev")
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))

  if (!app.requestSingleInstanceLock()) {
    // A rejected secondary proves a launch was forwarded to the running primary;
    // without this record the launch mode stays invisible in lifecycle evidence.
    const secondary = initLogging()
    secondary.log("single instance lock rejected; forwarding to primary and exiting", {
      deepLinks: deepLinkCorrelation(collectDeepLinkArgs(process.argv)),
      build: installedBuildIdentity(dirname(app.getPath("exe"))),
      ...lifecycleIdentity(),
    })
    app.quit()
    return
  }

  logger = initLogging()
  initCrashReporter()
  logger.log("single instance lock acquired", lifecycleIdentity())
  logger.log("installed build identity", installedBuildIdentity(dirname(app.getPath("exe"))))

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  const stopSidecars = async () => {
    await killSidecar()
    wslServers.stopAll()
  }
  let stoppingSidecars: Promise<void> | undefined
  const stopSidecarsOnce = () => {
    if (stoppingSidecars) return stoppingSidecars
    stoppingSidecars = stopSidecars().catch((error) => {
      stoppingSidecars = undefined
      throw error
    })
    return stoppingSidecars
  }
  const desktopServices = createPluginDesktopServices({
    getMainWindow: () => liveWindow(mainWindow),
    logger: {
      warn: (message, meta) => logger.warn(message, meta),
      error: (message, meta) => logger.error(message, meta),
    },
  })
  const shutdown = createShutdownCoordinator({
    cleanup: async () => {
      await stopSidecarsOnce()
      // Keep tray and controls usable if the live writer did not confirm exit.
      // app.exit bypasses will-quit, so release them after successful cleanup.
      tray?.destroy()
      tray = null
      desktopServices.dispose()
    },
    onCleanupError: (error) => {
      markAppQuitting(false)
      logger.error("desktop shutdown cleanup failed; application exit blocked", error)
    },
  })
  const relaunch = (reason: string) => {
    logger.log("app relaunch requested", relaunchRequestedRecord(reason))
    void shutdown.request(() => {
      logger.log("app relaunch executing after cleanup", relaunchRequestedRecord(reason))
      app.relaunch()
      app.exit(0)
    })
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })
  // Cold starts launched via a scheduled deep link otherwise leave no trace of
  // their initial argv, which made the launch mode hard to attribute later.
  const initialDeepLinks = collectDeepLinkArgs(process.argv)
  if (initialDeepLinks.length) logger.log("initial deep link arguments", { links: deepLinkCorrelation(initialDeepLinks) })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  logger.log("resolving desktop automation port")
  const cdpPort = yield* Effect.promise(() => desktopCdpPort())
  logger.log("desktop automation port resolved", { enabled: Boolean(cdpPort) })
  if (cdpPort) {
    app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1")
    app.commandLine.appendSwitch("remote-debugging-port", cdpPort)
  }

  preferAppEnv(app.getPath("userData"), Boolean(cdpPort))

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = collectDeepLinkArgs(argv)
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      logger.log("deep link handoff correlation", { links: deepLinkCorrelation(urls) })
      emitDeepLinks(urls)
    }
    showFromTray(liveWindow(mainWindow))
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", (event) => {
    logger.log("app quit requested", quitRequestedRecord("before-quit"))
    event.preventDefault()
    void shutdown.request(() => app.exit(0))
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
    if (details.type !== "GPU") return
    // A GPU process loss can leave window surfaces stale even after Chromium
    // restarts the process; invalidate once the replacement has settled.
    setTimeout(() => {
      if (!app.isReady()) return
      writeLog("utility", "gpu feature status after process loss", { status: app.getGPUFeatureStatus() }, "error")
      invalidateAllWindows("gpu-process-gone")
    }, 1500)
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: webContents.getURL(), details }, "error")
  })

  setRelaunchHandler((reason) => {
    relaunch(reason)
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.log("app quit requested", quitRequestedRecord(signal))
      void shutdown.request(() => app.exit(0))
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()

  logger.log("waiting for Electron ready")
  yield* Effect.promise(() => app.whenReady())
  logger.log("Electron ready")

  // Request a repaint after system or display changes; this does not confirm
  // that a frame was presented. Renderer stalls are reported separately.
  powerMonitor.on("resume", () => invalidateAllWindows("system-resume"))
  screen.on("display-metrics-changed", (_event, _display, changedMetrics) => {
    if (changedMetrics.length === 0) return
    invalidateAllWindows("display-metrics-changed")
  })

  logger.log("refreshing managed CLI")
  void refreshManagedCli()
    .then(() => logger.log("managed CLI refresh finished"))
    .catch((error) => logger.warn("failed to refresh managed CLI", error))

  if (!TEST_ONBOARDING) migrate()
  app.setAsDefaultProtocolClient("opencode")
  registerRendererProtocol()
  setDockIcon()
  const updater = setupAutoUpdater(stopSidecarsOnce)
  app.once("will-quit", desktopServices.dispose)
  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    serverState: () => serverState,
    retryServer: () => server?.retry(),
    relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const res = yield* Deferred.await(serverReady)
        logger.log("server ready", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => deepLinkDelivery.consume(),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
    desktopServices,
  })
  registerWslIpcHandlers(wslServers)
  void updater.start()
  const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const port = yield* Effect.gen(function* () {
    const fromEnv = process.env.OPENCODE_PORT
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10)
      if (!Number.isNaN(parsed)) return parsed
    }

    const res = yield* Deferred.make<number, unknown>()
    const server = createServer()
    server.on("error", (e) => Deferred.failSync(res, () => e))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        Deferred.failSync(res, () => new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => Effect.runSync(Deferred.succeed(res, port)))
    })

    return yield* Deferred.await(res)
  })
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { url })

    ensureLoopbackNoProxy()
    useEnvProxy()

    logger.log("spawning sidecar", { url })
    const { listener, health } = yield* Effect.promise(() =>
      spawnLocalServer(hostname, port, password, {
        userDataPath: app.getPath("userData"),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onSpawn: (pid) => writeLog("utility", "sidecar spawned", { pid }),
        onDiagnostic: (sample) => writeLog("utility", "sidecar diagnostic", sample),
        onExit: (code, detail) => writeLog("utility", "sidecar exited", { code, ...detail }, "warn"),
        onState: (state) => {
          writeLog("utility", "sidecar state", state)
          updateServerState(state)
          Effect.runSync(completeHealthyInitialization(serverReady, { url, username: "opencode", password }, state))
        },
      }),
    )
    server = listener
    setPluginAssetServer({
      url,
      username: "opencode",
      password,
    })
    serverReadyData = {
      url,
      username: "opencode",
      password,
    }

    if (process.platform === "win32") {
      void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
    }

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catchTag("TimeoutError", () =>
        Effect.sync(() => logger.log("sidecar startup continues; renderer will wait for verified health")),
      ),
    )

    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  yield* Fiber.await(loadingTask)

  mainWindow = createMainWindow()
  if (mainWindow) {
    const createdWindow = mainWindow
    if (process.platform === "win32") {
      try {
        tray = createTray(iconPath(), [], {
          onShow: () => showFromTray(liveWindow(mainWindow)),
          onQuit: () => app.quit(),
          onRetry: () => server?.retry(),
        })
        updateServerState(serverState)
      } catch (error) {
        logger.warn("tray unavailable; retaining normal close behavior", error)
      }
      applyCloseToTray(createdWindow, () => tray !== null)
      createdWindow.on("query-session-end", () => markAppQuitting())
      createdWindow.on("session-end", () => { void shutdown.request(() => app.exit(0)) })
    }
    createdWindow.once("closed", () => {
      if (mainWindow === createdWindow) mainWindow = null
    })
    createdWindow.webContents.on("did-start-loading", () => deepLinkDelivery.suspend())
    void startDesktopTestingServer({
      app: {
        version: app.getVersion(),
        channel: CHANNEL,
        packaged: app.isPackaged,
        userDataPath: app.getPath("userData"),
        cdpPort,
      },
      getWindow: () => liveWindow(mainWindow),
      getSpeechOverlay: desktopServices.overlayWindow,
      getDesktopServices: desktopServices.snapshot,
      getSidecar: () => serverReadyData,
      quit: () => app.quit(),
      logger: {
        log: (message, meta) => logger.log(message, meta),
        warn: (message, meta) => logger.warn(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    }).catch((error) => logger.error("desktop testing bridge failed", error))
    createMenu({
      trigger: (id) => {
        const win = liveWindow(BrowserWindow.getFocusedWindow()) ?? liveWindow(mainWindow)
        if (win) sendMenuCommand(win, id)
      },
      checkForUpdates: () => {
        void showUpdaterDialog(updater, true)
      },
      relaunch: () => {
        relaunch("app-menu")
      },
    })
  }

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      logger.log("app quit requested", quitRequestedRecord("window-all-closed"))
      app.quit()
    }
  })
})

Effect.runFork(main)
