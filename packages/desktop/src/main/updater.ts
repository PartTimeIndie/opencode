import { app, dialog } from "electron"
import pkg from "electron-updater"
import { UPDATER_ENABLED } from "./constants"
import { createUpdaterController, type UpdaterReadyRecord } from "./updater-controller"
import { getLogger } from "./logging"
import { getStore } from "./store"

const key = "ready"
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export function setupAutoUpdater(stop: () => Promise<void>) {
  const logger = getLogger()
  const currentVersion = app.getVersion()
  if (!UPDATER_ENABLED) {
    logger.log("auto updater disabled", { currentVersion })
    return createDisabledUpdaterController(currentVersion, stop, (message, data) => logger.log(message, data))
  }
  if (!semverPattern.test(currentVersion)) {
    logger.warn("auto updater disabled because app version is not semver", { currentVersion })
    return createDisabledUpdaterController(currentVersion, stop, (message, data) => logger.log(message, data))
  }

  const { autoUpdater } = pkg
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion,
  })

  const store = getStore("opencode.updater")
  return createUpdaterController({
    enabled: UPDATER_ENABLED,
    currentVersion,
    backend: autoUpdater,
    persistence: {
      get() {
        const value = store.get(key)
        if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "string") return
        return { version: value.version } satisfies UpdaterReadyRecord
      },
      set: (value) => store.set(key, value),
      clear: () => store.delete(key),
    },
    stop,
    log: (message, data) => logger.log(message, data),
  })
}

export async function showUpdaterDialog(controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  const state = await controller.check()
  if (state.status === "error") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "error", message: "Update check failed.", title: "Update Error" })
    return
  }
  if (state.status === "up-to-date") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "info", message: "You're up to date.", title: "No Updates" })
    return
  }
  if (state.status !== "ready") return

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${state.version} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  if (response.response === 0) await controller.install()
}

function createDisabledUpdaterController(
  currentVersion: string,
  stop: () => Promise<void>,
  log: (message: string, data?: object) => void,
) {
  return createUpdaterController({
    enabled: false,
    currentVersion,
    backend: {
      checkForUpdates: async () => null,
      downloadUpdate: async () => undefined,
      quitAndInstall() {},
    },
    persistence: {
      get: () => undefined,
      set: () => undefined,
      clear: () => undefined,
    },
    stop,
    log,
  })
}
