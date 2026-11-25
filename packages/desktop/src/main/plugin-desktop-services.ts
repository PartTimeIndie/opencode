import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { BrowserWindow, clipboard, globalShortcut, screen, type WebContents } from "electron"
import type {
  DesktopServiceInvocation,
  DesktopServiceRegistrationInput,
  DesktopServiceRegistrationResult,
  DesktopServiceState,
} from "../preload/types"
import { captureForegroundWindow, insertForegroundText, type ForegroundWindowTarget } from "./windows-foreground-input"
import { registrationError, stateError } from "./plugin-desktop-services-validation"
import { parseDesktopAccelerator } from "./desktop-accelerator"
import { createWindowsDoubleTapObserver } from "./windows-double-tap-observer"

const terminalPhases = new Set(["success", "cancelled", "error"])
const maximumTextLength = 200_000
const targetLifetimeMs = 15 * 60 * 1000

type Registration = {
  key: string
  id: string
  pluginID: string
  serviceID: string
  accelerator: string
  sender: WebContents
  activeInvocationID?: string
  capturePending?: boolean
  release: () => void
}

type Invocation = DesktopServiceInvocation & {
  registrationID: string
  createdAt: number
  targetWindow?: ForegroundWindowTarget
  controller: AbortController
  terminal?: boolean
  insertionAttempted?: boolean
}

type Logger = {
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
}

export function createPluginDesktopServices(input: {
  getMainWindow: () => BrowserWindow | null
  logger: Logger
  observeDoubleTap?: typeof createWindowsDoubleTapObserver
}) {
  const registrations = new Map<string, Registration>()
  const invocations = new Map<string, Invocation>()
  const senderCleanup = new Map<number, () => void>()
  const doubleTaps = new Map<string, string>()
  const pending = new Map<string, { sender: WebContents; stop: () => void }>()
  let disposed = false
  let overlay: BrowserWindow | undefined
  let overlayLoaded = false
  let overlayState: (DesktopServiceState & { application: string; accelerator: string }) | undefined
  let overlayInvocationID: string | undefined

  const register = async (sender: WebContents, value: DesktopServiceRegistrationInput): Promise<DesktopServiceRegistrationResult> => {
    const error = registrationError(value)
    if (error) return { ok: false, error }
    if (process.platform !== "win32") return { ok: false, error: "Desktop services are currently supported on Windows only." }
    if (disposed || sender.isDestroyed()) return { ok: false, error: "The desktop service owner is no longer active." }
    const key = `${sender.id}:${value.pluginID}:${value.serviceID}`
    if (pending.has(key)) return { ok: false, error: "A desktop service registration is already pending." }
    const previous = registrations.get(key)
    if (previous?.accelerator === value.accelerator) {
      return { ok: true, registrationID: previous.id, accelerator: previous.accelerator }
    }
    const id = randomUUID()
    const accelerator = parseDesktopAccelerator(value.accelerator)!
    let release: () => void
    if (accelerator.kind === "double-tap") {
      if (doubleTaps.has(accelerator.id)) return { ok: false, error: `The double-tap shortcut ${value.accelerator} is already registered.` }
      // Reserve before awaiting native readiness so another renderer cannot acquire the same binding.
      doubleTaps.set(accelerator.id, id)
      const observer = (input.observeDoubleTap ?? createWindowsDoubleTapObserver)({
        key: accelerator.key,
        modifiers: accelerator.modifiers,
        onInvoke: () => {
          if (registrations.get(key)?.id === id) void invoke(key)
        },
        onFailure: (error) => {
          input.logger.warn("desktop double-tap observer failed", { pluginID: value.pluginID, error })
          const current = registrations.get(key)
          if (current?.id === id) removeRegistration(current)
        },
      })
      release = () => {
        observer.stop()
        if (doubleTaps.get(accelerator.id) === id) doubleTaps.delete(accelerator.id)
      }
      pending.set(key, { sender, stop: release })
      ensureSenderCleanup(sender)
      const result = await observer.ready
      pending.delete(key)
      if (!result.ok || disposed || sender.isDestroyed()) {
        release()
        return { ok: false, error: result.ok ? "The desktop service owner is no longer active." : result.error }
      }
    } else {
      const registered = (() => {
        try {
          return globalShortcut.register(value.accelerator, () => void invoke(key))
        } catch {
          return false
        }
      })()
      if (!registered) return { ok: false, error: `The global shortcut ${value.accelerator} is unavailable or already registered.` }
      release = () => globalShortcut.unregister(value.accelerator)
    }
    const registration = {
      key,
      id,
      pluginID: value.pluginID,
      serviceID: value.serviceID,
      accelerator: value.accelerator,
      sender,
      release,
    }
    registrations.set(key, registration)
    if (previous) {
      previous.release()
      clearRegistrationInvocations(previous)
    }
    ensureSenderCleanup(sender)
    updateBackgroundThrottling()
    return { ok: true, registrationID: id, accelerator: value.accelerator }
  }

  const unregister = (sender: WebContents, registrationID: string) => {
    const registration = [...registrations.values()].find((item) => item.sender === sender && item.id === registrationID)
    if (!registration) return
    removeRegistration(registration)
  }

  const update = (sender: WebContents, registrationID: string, invocationID: string, state: DesktopServiceState) => {
    const registration = requireRegistration(sender, registrationID)
    const invocation = requireInvocation(registration, invocationID)
    const error = stateError(state)
    if (error) throw new Error(error)
    if (invocation.target.kind === "external") showOverlay(invocation, registration, state)
    if (!terminalPhases.has(state.phase)) return
    invocation.terminal = true
    if (registration.activeInvocationID === invocation.id) registration.activeInvocationID = undefined
    if (state.phase === "success") setTimeout(() => settleInvocation(invocation.id), 1_200).unref()
    if (state.phase === "cancelled") setTimeout(() => settleInvocation(invocation.id), 500).unref()
    if (state.phase === "error") setTimeout(() => settleInvocation(invocation.id), 6_000).unref()
  }

  const insertText = async (sender: WebContents, registrationID: string, invocationID: string, text: string) => {
    const registration = requireRegistration(sender, registrationID)
    const invocation = requireInvocation(registration, invocationID)
    if (invocation.target.kind !== "external" || !invocation.targetWindow)
      return { ok: false, error: "The invocation does not have an external target." }
    if (invocation.insertionAttempted) return { ok: false, error: "Text insertion was already attempted for this invocation." }
    if (typeof text !== "string" || !text || text.length > maximumTextLength)
      return { ok: false, error: "The text is empty or too large to insert." }
    invocation.insertionAttempted = true
    if (Date.now() - invocation.createdAt > targetLifetimeMs) return recoverText(text, "The original target expired before insertion.")
    const inserted = await insertForegroundText(invocation.targetWindow, text, invocation.controller.signal)
    if (inserted.ok) return inserted
    // The overlay only shows the recovered clipboard hint; the main log must
    // still name the cause. The dictated text itself never reaches the log.
    input.logger.warn("desktop text insertion failed", { pluginID: registration.pluginID, error: inserted.error })
    return recoverText(text, inserted.error)
  }

  const readClipboard = async (sender: WebContents, registrationID: string, invocationID: string) => {
    const invocation = requireInvocation(requireRegistration(sender, registrationID), invocationID)
    if (Date.now() - invocation.createdAt > targetLifetimeMs) throw new Error("The desktop service invocation expired.")
    const text = await clipboard.readText()
    requireInvocation(requireRegistration(sender, registrationID), invocationID)
    if (Date.now() - invocation.createdAt > targetLifetimeMs) throw new Error("The desktop service invocation expired.")
    if (text.length > maximumTextLength) throw new Error("Clipboard text is too large.")
    return text
  }

  const writeClipboard = (sender: WebContents, registrationID: string, invocationID: string, text: string) => {
    const invocation = requireInvocation(requireRegistration(sender, registrationID), invocationID)
    if (Date.now() - invocation.createdAt > targetLifetimeMs) throw new Error("The desktop service invocation expired.")
    if (typeof text !== "string" || !text || text.length > maximumTextLength) throw new Error("The clipboard text is empty or too large.")
    return clipboard.writeText(text)
  }

  const dispose = () => {
    disposed = true
    const senders = new Set([...registrations.values(), ...pending.values()].map((item) => item.sender))
    for (const item of pending.values()) item.stop()
    for (const registration of [...registrations.values()]) removeRegistration(registration)
    for (const sender of senders) {
      const cleanup = senderCleanup.get(sender.id)
      if (cleanup && !sender.isDestroyed()) sender.removeListener("destroyed", cleanup)
      senderCleanup.delete(sender.id)
    }
    destroyOverlay()
  }

  const snapshot = () => ({
    registrations: [...registrations.values()].map((item) => ({ pluginID: item.pluginID, serviceID: item.serviceID, accelerator: item.accelerator })),
    overlay:
      overlayState && overlay && !overlay.isDestroyed()
        ? {
            ...overlayState,
            bounds: overlay.getBounds(),
            visible: overlay.isVisible(),
            focusable: overlay.isFocusable(),
          }
        : undefined,
  })

  const overlayWindow = () => (overlay && !overlay.isDestroyed() && overlay.isVisible() ? overlay : undefined)

  async function invoke(key: string) {
    const registration = registrations.get(key)
    if (!registration || registration.sender.isDestroyed()) return
    if (registration.activeInvocationID) {
      const active = invocations.get(registration.activeInvocationID)
      if (active) sendInvocation(registration, { ...active, action: "toggle" })
      return
    }
    if (registration.capturePending) return
    registration.capturePending = true
    const captured = await captureForegroundWindow()
    registration.capturePending = false
    if (registrations.get(key)?.id !== registration.id) return
    if (!captured.ok) {
      input.logger.warn("desktop service could not capture foreground target", { pluginID: registration.pluginID, error: captured.error })
      return
    }
    const display = screen.getDisplayMatching(captured.target.bounds).workArea
    const target = captured.target.processID === process.pid
      ? { kind: "opencode" as const, application: "OpenCode", display }
      : { kind: "external" as const, application: captured.target.application, display }
    const invocation: Invocation = {
      id: randomUUID(),
      registrationID: registration.id,
      action: "start",
      target,
      createdAt: Date.now(),
      controller: new AbortController(),
      targetWindow: target.kind === "external" ? captured.target : undefined,
    }
    invocations.set(invocation.id, invocation)
    registration.activeInvocationID = invocation.id
    sendInvocation(registration, invocation)
  }

  function sendInvocation(registration: Registration, invocation: DesktopServiceInvocation) {
    if (registration.sender.isDestroyed()) return removeRegistration(registration)
    registration.sender.send("desktop-service-invoked", {
      registrationID: registration.id,
      invocation: {
        id: invocation.id,
        action: invocation.action,
        target: invocation.target,
      },
    })
  }

  function ensureSenderCleanup(sender: WebContents) {
    if (senderCleanup.has(sender.id)) return
    const cleanup = () => {
      for (const item of pending.values()) if (item.sender === sender) item.stop()
      for (const registration of [...registrations.values()].filter((item) => item.sender === sender)) removeRegistration(registration)
      senderCleanup.delete(sender.id)
    }
    sender.once("destroyed", cleanup)
    senderCleanup.set(sender.id, cleanup)
  }

  function removeRegistration(registration: Registration) {
    if (registrations.get(registration.key)?.id !== registration.id) return
    registrations.delete(registration.key)
    registration.release()
    clearRegistrationInvocations(registration)
    // A hidden BrowserWindow still prevents Electron's window-all-closed event.
    if (registrations.size === 0) destroyOverlay()
    if (
      !registration.sender.isDestroyed() &&
      ![...registrations.values()].some((item) => item.sender === registration.sender)
    )
      registration.sender.setBackgroundThrottling(true)
    updateBackgroundThrottling()
  }

  function clearRegistrationInvocations(registration: Registration) {
    for (const invocation of [...invocations.values()].filter((item) => item.registrationID === registration.id)) {
      invocation.controller.abort()
      invocations.delete(invocation.id)
      hideOverlay(invocation.id)
    }
    registration.activeInvocationID = undefined
  }

  function settleInvocation(id: string) {
    const invocation = invocations.get(id)
    if (!invocation) return
    invocation.controller.abort()
    invocations.delete(id)
    hideOverlay(id)
  }

  function showOverlay(invocation: Invocation, registration: Registration, state: DesktopServiceState) {
    overlayState = { ...state, application: invocation.target.application, accelerator: registration.accelerator }
    overlayInvocationID = invocation.id
    if (!overlay || overlay.isDestroyed()) {
      overlayLoaded = false
      overlay = new BrowserWindow({
        width: 400,
        height: 74,
        show: false,
        transparent: true,
        frame: false,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: true,
        backgroundColor: "#00000000",
        webPreferences: {
          preload: join(import.meta.dirname, "../preload/speech-overlay.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      overlay.setIgnoreMouseEvents(true)
      overlay.setAlwaysOnTop(true, "screen-saver")
      const currentOverlay = overlay
      currentOverlay.webContents.once("did-finish-load", () => {
        if (
          overlay !== currentOverlay ||
          currentOverlay.isDestroyed() ||
          currentOverlay.webContents.isDestroyed()
        )
          return
        overlayLoaded = true
        publishOverlay()
      })
      currentOverlay.webContents.once("did-fail-load", (_event, code, description) => {
        input.logger.warn("desktop service overlay failed to load", { code, description })
      })
      void currentOverlay.loadFile(join(import.meta.dirname, "../renderer/speech-overlay.html"))
    }
    if (!overlay || overlay.isDestroyed() || overlay.webContents.isDestroyed()) return
    const target = invocation.targetWindow?.bounds
    const display = target ? screen.getDisplayMatching(target) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const bounds = overlay.getBounds()
    overlay.setPosition(display.workArea.x + display.workArea.width - bounds.width - 16, display.workArea.y + 16, false)
    publishOverlay()
  }

  function publishOverlay() {
    if (!overlay || overlay.isDestroyed() || overlay.webContents.isDestroyed() || !overlayState || !overlayLoaded) return
    overlay.webContents.send("speech-overlay-state", overlayState)
    overlay.showInactive()
  }

  function hideOverlay(expectedInvocationID?: string) {
    if (expectedInvocationID && overlayInvocationID !== expectedInvocationID) return
    overlayState = undefined
    overlayInvocationID = undefined
    if (overlay && !overlay.isDestroyed()) overlay.hide()
  }

  function destroyOverlay() {
    const current = overlay
    overlay = undefined
    overlayLoaded = false
    overlayState = undefined
    overlayInvocationID = undefined
    if (current && !current.isDestroyed()) current.destroy()
  }

  function updateBackgroundThrottling() {
    const senders = new Set([...registrations.values()].map((item) => item.sender).filter((sender) => !sender.isDestroyed()))
    for (const sender of senders) sender.setBackgroundThrottling(false)
    const mainWindow = input.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed() || senders.has(mainWindow.webContents)) return
    mainWindow.webContents.setBackgroundThrottling(registrations.size === 0)
  }

  function requireRegistration(sender: WebContents, id: string) {
    const registration = [...registrations.values()].find((item) => item.sender === sender && item.id === id)
    if (!registration) throw new Error("The desktop service registration is no longer active.")
    return registration
  }

  function requireInvocation(registration: Registration, id: string) {
    const invocation = invocations.get(id)
    if (!invocation || invocation.registrationID !== registration.id) throw new Error("The desktop service invocation is stale or invalid.")
    if (invocation.terminal) throw new Error("The desktop service invocation already settled.")
    return invocation
  }

  async function recoverText(text: string, error: string) {
    await clipboard.writeText(text)
    return { ok: false as const, error: `${error} The text was copied to the clipboard.`, recoveredToClipboard: true }
  }

  return { register, unregister, update, insertText, readClipboard, writeClipboard, dispose, snapshot, overlayWindow }
}

export type PluginDesktopServices = ReturnType<typeof createPluginDesktopServices>
