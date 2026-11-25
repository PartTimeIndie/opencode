import { describe, expect, mock, test } from "bun:test"
import { registrationError, stateError } from "./plugin-desktop-services-validation"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { createWindowsDoubleTapObserver } from "./windows-double-tap-observer"

const shortcuts = new Map<string, () => void>()
const clipboardWrites: string[] = []
const overlayStates: unknown[] = []
const insertedText: string[] = []
let overlayOptions: Record<string, unknown> | undefined
let nextInsertError = ""
let pendingClipboardRead: (() => Promise<string>) | undefined
let nextClipboardWriteError = ""
const overlays: FakeOverlay[] = []

class FakeOverlay {
  private destroyed = false
  private bounds: { x: number; y: number; width: number; height: number }
  webContents = {
    isDestroyed: () => this.destroyed,
    once: (event: string, callback: (...args: unknown[]) => void) => {
      if (event === "did-finish-load") queueMicrotask(callback)
    },
    send: (_channel: string, state: unknown) => overlayStates.push(state),
  }

  constructor(options: Record<string, unknown>) {
    overlays.push(this)
    overlayOptions = options
    this.bounds = { x: 0, y: 0, width: Number(options.width), height: Number(options.height) }
  }

  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    this.destroyed = true
  }
  setIgnoreMouseEvents() {}
  setAlwaysOnTop() {}
  loadFile() {
    return Promise.resolve()
  }
  getBounds() {
    return this.bounds
  }
  setPosition(x: number, y: number) {
    this.bounds = { ...this.bounds, x, y }
  }
  showInactive() {}
  hide() {}
  isVisible() {
    return true
  }
  isFocusable() {
    return false
  }
}

mock.module("electron", () => ({
  BrowserWindow: FakeOverlay,
  clipboard: {
    readText: () => pendingClipboardRead?.() ?? Promise.resolve(clipboardWrites.at(-1) ?? ""),
    writeText: async (text: string) => {
      await Promise.resolve()
      if (nextClipboardWriteError) throw new Error(nextClipboardWriteError)
      clipboardWrites.push(text)
    },
  },
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => {
      if (accelerator === "Ctrl+Alt+Conflict" || shortcuts.has(accelerator)) return false
      shortcuts.set(accelerator, callback)
      return true
    },
    unregister: (accelerator: string) => shortcuts.delete(accelerator),
  },
  screen: {
    getDisplayMatching: () => ({ workArea: { x: 10, y: 20, width: 1_000, height: 800 } }),
    getDisplayNearestPoint: () => ({ workArea: { x: 10, y: 20, width: 1_000, height: 800 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
}))

mock.module("./windows-foreground-input", () => ({
  captureForegroundWindow: async () => ({
    ok: true as const,
    target: {
      handle: "123",
      processID: 456,
      processStartedAt: "638000000000000000",
      application: "notepad",
      bounds: { x: 20, y: 30, width: 600, height: 400 },
    },
  }),
  insertForegroundText: async (_target: unknown, text: string, signal?: AbortSignal) => {
    insertedText.push(text)
    if (text === "cancel pending") {
      return new Promise<{ ok: false; error: string }>((resolve) => {
        const cancel = () => resolve({ ok: false, error: "The Windows input helper was cancelled." })
        if (signal?.aborted) return cancel()
        signal?.addEventListener("abort", cancel, { once: true })
      })
    }
    if (nextInsertError) return { ok: false as const, error: nextInsertError }
    return { ok: true as const }
  },
}))

const { createPluginDesktopServices } = await import("./plugin-desktop-services")

describe("plugin desktop services validation", () => {
  test("destroying the owning renderer releases the hidden overlay and global shortcut", async () => {
    const sender = createSender(99)
    const manager = createPluginDesktopServices({ getMainWindow: () => null, logger: { warn() {}, error() {} } })
    const registration = await manager.register(sender, {
      pluginID: "speech-to-text-app",
      serviceID: "global-dictation",
      accelerator: "Ctrl+Shift+Space",
    })
    if (!registration.ok) throw new Error(registration.error)
    shortcuts.get("Ctrl+Shift+Space")?.()
    await Bun.sleep(5)
    manager.update(sender, registration.registrationID, sender.sent[0]!.payload.invocation.id, { phase: "active", label: "Preparing export" })
    const overlay = overlays.at(-1)!
    expect(overlay.isDestroyed()).toBe(false)
    sender.destroy()
    expect(shortcuts.has("Ctrl+Shift+Space")).toBe(false)
    expect(overlay.isDestroyed()).toBe(true)
    manager.dispose()
  })

  test("accepts a scoped speech registration", () => {
    expect(
      registrationError({
        pluginID: "speech-to-text-app",
        serviceID: "global-dictation",
        accelerator: "Ctrl+Shift+Space",
      }),
    ).toBeUndefined()
    expect(
      registrationError({ pluginID: "@example/speech", serviceID: "global-dictation", accelerator: "Ctrl+Shift+Space" }),
    ).toBeUndefined()
  })

  test("rejects malformed runtime values without throwing", () => {
    expect(registrationError({ pluginID: "../speech", serviceID: "dictation", accelerator: "Ctrl+Space" })).toBe(
      "Invalid plugin ID.",
    )
    expect(registrationError({ pluginID: "speech", serviceID: "../dictation", accelerator: "Ctrl+Space" })).toBe(
      "Invalid desktop service ID.",
    )
    expect(registrationError({ pluginID: "speech", serviceID: "dictation", accelerator: "" })).toBe(
      "Invalid global shortcut.",
    )
    expect(
      registrationError({ pluginID: "speech", serviceID: "dictation", accelerator: 42 } as never),
    ).toBe("Invalid global shortcut.")
  })

  test("bounds structured overlay state", () => {
    for (const progress of [-1, 1.01, NaN, Infinity])
      expect(stateError({ phase: "active", label: "Export", progress })).toBe("Invalid desktop service progress.")
    expect(stateError({ phase: "active", label: "Export", progress: 0 })).toBeUndefined()
    expect(stateError({ phase: "active", label: "Export", progress: 1 })).toBeUndefined()
    expect(stateError({ phase: "active", label: " " })).toBe("Invalid desktop service label.")
    expect(stateError({ phase: "active", label: "Export", actionLabel: "x".repeat(65) })).toBe("Invalid desktop service action label.")
    expect(stateError({ phase: "recording", label: "Legacy" } as never)).toBe("Invalid desktop service phase.")

    expect(stateError({ phase: "active", label: "Preparing export", elapsedMs: 1_000, detail: "System default" })).toBeUndefined()
    expect(stateError({ phase: "active", label: "Preparing export", elapsedMs: -1 })).toBe("Invalid elapsed time.")
    expect(stateError({ phase: "error", label: "x".repeat(513) })).toBe(
      "Invalid desktop service label.",
    )
    expect(stateError({ phase: "active", label: "Preparing export", detail: 42 } as never)).toBe("Invalid desktop service detail.")
  })
})

describe("plugin desktop service lifecycle", () => {
  test("rechecks ownership after an asynchronous clipboard read and propagates failed writes", async () => {
    const sender = createSender(103)
    const manager = createPluginDesktopServices({ getMainWindow: () => null, logger: { warn() {}, error() {} } })
    const registration = await manager.register(sender, { pluginID: "speech", serviceID: "clipboard", accelerator: "Ctrl+Shift+Space" })
    if (!registration.ok) throw new Error(registration.error)
    try {
      shortcuts.get("Ctrl+Shift+Space")?.()
      await Bun.sleep(5)
      const invocationID = sender.sent[0]!.payload.invocation.id
      nextClipboardWriteError = "Clipboard unavailable"
      await expect(manager.writeClipboard(sender, registration.registrationID, invocationID, "text"))
        .rejects.toThrow("Clipboard unavailable")
      nextInsertError = "Cannot insert"
      await expect(manager.insertText(sender, registration.registrationID, invocationID, "fallback text"))
        .rejects.toThrow("Clipboard unavailable")
      clipboardWrites.push("x".repeat(200_001))
      await expect(manager.readClipboard(sender, registration.registrationID, invocationID))
        .rejects.toThrow("Clipboard text is too large")
      const pending = Promise.withResolvers<string>()
      pendingClipboardRead = () => pending.promise
      const reading = manager.readClipboard(sender, registration.registrationID, invocationID)
      manager.update(sender, registration.registrationID, invocationID, { phase: "success", label: "Completed" })
      pending.resolve("stale clipboard content")
      await expect(reading).rejects.toThrow("already settled")
    } finally {
      pendingClipboardRead = undefined
      nextClipboardWriteError = ""
      nextInsertError = ""
      clipboardWrites.length = 0
      manager.dispose()
    }
  })

  test("routes pass-through double taps to the owner and releases them on destruction", async () => {
    const helpers: Array<ReturnType<typeof createHelper>> = []
    const manager = createPluginDesktopServices({
      getMainWindow: () => null, logger: { warn() {}, error() {} },
      observeDoubleTap: (input) => {
        const child = createHelper()
        helpers.push(child)
        const observer = createWindowsDoubleTapObserver({ ...input, spawn: () => child as unknown as ChildProcessWithoutNullStreams })
        queueMicrotask(() => child.stdout.write('{"type":"ready"}\n'))
        return observer
      },
    })
    const sender = createSender(101)
    const other = createSender(102)
    const first = await manager.register(sender, { pluginID: "speech", serviceID: "clipboard", accelerator: "Ctrl+C Ctrl+C" })
    if (!first.ok) throw new Error(first.error)
    expect(shortcuts.has("Ctrl+C")).toBe(false)
    expect(shortcuts.has("Ctrl+C Ctrl+C")).toBe(false)
    expect((await manager.register(other, { pluginID: "export", serviceID: "export", accelerator: "Control+C Ctrl+C" })).ok).toBe(false)
    expect(helpers).toHaveLength(1)
    const tap = (time: number) => helpers[0]!.stdout.write(JSON.stringify({ type: "tap", time, window: "123" }) + "\n")
    tap(1)
    await Bun.sleep(5)
    expect(sender.sent).toHaveLength(0)
    tap(100)
    await Bun.sleep(5)
    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0]!.payload.registrationID).toBe(first.registrationID)
    expect(other.sent).toHaveLength(0)
    clipboardWrites.push("copied external selection")
    const invocationID = sender.sent[0]!.payload.invocation.id
    expect(await manager.readClipboard(sender, first.registrationID, invocationID)).toBe("copied external selection")
    await expect(manager.readClipboard(other, first.registrationID, invocationID)).rejects.toThrow()
    expect(() => manager.writeClipboard(other, first.registrationID, invocationID, "wrong owner")).toThrow()
    expect(() => manager.writeClipboard(sender, first.registrationID, invocationID, "x".repeat(200_001))).toThrow()
    await manager.writeClipboard(sender, first.registrationID, invocationID, "polished selection")
    expect(clipboardWrites.at(-1)).toBe("polished selection")
    manager.update(sender, first.registrationID, invocationID, { phase: "success", label: "Completed" })
    await expect(manager.readClipboard(sender, first.registrationID, invocationID)).rejects.toThrow("already settled")
    expect(() => manager.writeClipboard(sender, first.registrationID, invocationID, "late write")).toThrow("already settled")
    tap(150); tap(180)
    await Bun.sleep(5)
    expect(sender.sent).toHaveLength(2)
    expect(sender.sent[1]!.payload.invocation).toMatchObject({ action: "start" })
    expect(sender.sent[1]!.payload.invocation.id).not.toBe(invocationID)
    manager.unregister(other, first.registrationID)
    expect(helpers[0]!.killed).toBe(false)
    expect(() => manager.update(other, first.registrationID, sender.sent[0]!.payload.invocation.id, { phase: "active", label: "wrong owner" })).toThrow()
    sender.destroy()
    expect(helpers[0]!.killed).toBe(true)
    expect(manager.snapshot().registrations).toEqual([])
    tap(200); tap(300)
    await Bun.sleep(5)
    expect(sender.sent).toHaveLength(2)
    manager.dispose()
  })

  test("keeps prior registration on observer startup failure and cancels pending registration on dispose", async () => {
    const helpers: Array<ReturnType<typeof createHelper>> = []
    const manager = createPluginDesktopServices({
      getMainWindow: () => null, logger: { warn() {}, error() {} },
      observeDoubleTap: (input) => {
        const child = createHelper()
        helpers.push(child)
        return createWindowsDoubleTapObserver({ ...input, spawn: () => child as unknown as ChildProcessWithoutNullStreams })
      },
    })
    const sender = createSender(103)
    await manager.register(sender, { pluginID: "speech", serviceID: "clipboard", accelerator: "Ctrl+Alt+C" })
    const failed = manager.register(sender, { pluginID: "speech", serviceID: "clipboard", accelerator: "Ctrl+C Ctrl+C" })
    await Bun.sleep(5)
    helpers[0]!.emit("exit", 1)
    expect((await failed).ok).toBe(false)
    expect(shortcuts.has("Ctrl+Alt+C")).toBe(true)
    const pending = manager.register(sender, { pluginID: "speech", serviceID: "clipboard", accelerator: "Ctrl+C Ctrl+C" })
    await Bun.sleep(5)
    manager.dispose()
    expect((await pending).ok).toBe(false)
    expect(helpers[1]!.killed).toBe(true)
    expect(manager.snapshot().registrations).toEqual([])
    expect((await manager.register(sender, { pluginID: "speech", serviceID: "clipboard", accelerator: "Ctrl+C Ctrl+C" })).ok).toBe(false)
  })

  test("supports a neutral export plugin with its own progress and action", async () => {
    const sender = createSender(42)
    const manager = createPluginDesktopServices({ getMainWindow: () => null, logger: { warn() {}, error() {} } })
    const registration = await manager.register(sender, { pluginID: "archive-export", serviceID: "export", accelerator: "Ctrl+Alt+E" })
    if (!registration.ok) throw new Error(registration.error)
    shortcuts.get("Ctrl+Alt+E")?.()
    await Bun.sleep(5)
    const id = sender.sent[0]!.payload.invocation.id
    manager.update(sender, registration.registrationID, id, { phase: "active", label: "Exporting files", detail: "12 of 24 files", actionLabel: "Pause", progress: 0.5 })
    await Promise.resolve()
    expect(overlayStates.at(-1)).toMatchObject({ phase: "active", label: "Exporting files", detail: "12 of 24 files", actionLabel: "Pause", progress: 0.5 })
    shortcuts.get("Ctrl+Alt+E")?.()
    expect(sender.sent.at(-1)?.payload.invocation).toMatchObject({ id, action: "toggle" })
    manager.update(sender, registration.registrationID, id, { phase: "success", label: "Archive ready" })
    expect(() => manager.update(sender, registration.registrationID, id, { phase: "active", label: "Old update" })).toThrow("already settled")
    manager.dispose()
  })

  test("keeps the prior accelerator on conflict and cleans up renderer registrations", async () => {
    const sender = createSender(10)
    const manager = createPluginDesktopServices({ getMainWindow: () => null, logger: { warn() {}, error() {} } })
    const first = await manager.register(sender, {
      pluginID: "speech-to-text-app",
      serviceID: "global-dictation",
      accelerator: "Ctrl+Shift+Space",
    })
    expect(first.ok).toBe(true)

    const conflict = await manager.register(sender, {
      pluginID: "speech-to-text-app",
      serviceID: "global-dictation",
      accelerator: "Ctrl+Alt+Conflict",
    })
    expect(conflict).toEqual({ ok: false, error: "The global shortcut Ctrl+Alt+Conflict is unavailable or already registered." })
    expect(shortcuts.has("Ctrl+Shift+Space")).toBe(true)

    expect(() => sender.destroy()).not.toThrow()
    expect(shortcuts.has("Ctrl+Shift+Space")).toBe(false)
    expect(manager.snapshot().registrations).toEqual([])
    manager.dispose()
  })

  test("uses opaque invocations, rejects stale updates, and recovers failed insertion to the clipboard", async () => {
    clipboardWrites.length = 0
    insertedText.length = 0
    overlayStates.length = 0
    nextInsertError = "The target is elevated."
    const sender = createSender(11)
    const manager = createPluginDesktopServices({ getMainWindow: () => null, logger: { warn() {}, error() {} } })
    const registration = await manager.register(sender, {
      pluginID: "speech-to-text-app",
      serviceID: "global-dictation",
      accelerator: "Ctrl+Shift+Space",
    })
    if (!registration.ok) throw new Error(registration.error)

    shortcuts.get("Ctrl+Shift+Space")?.()
    await Bun.sleep(5)
    const event = sender.sent[0]?.payload
    expect(event?.registrationID).toBe(registration.registrationID)
    expect(event?.invocation.target).toEqual({
      kind: "external",
      application: "notepad",
      display: { x: 10, y: 20, width: 1_000, height: 800 },
    })
    expect(JSON.stringify(event)).not.toContain("123")
    expect(JSON.stringify(event)).not.toContain("456")

    manager.update(sender, registration.registrationID, event!.invocation.id, {
      phase: "active", label: "Preparing export",
      elapsedMs: 1_000,
      detail: "System default",
    })
    await Promise.resolve()
    expect(overlayStates.at(-1)).toMatchObject({ phase: "active", label: "Preparing export", application: "notepad" })
    expect(overlayOptions).toMatchObject({
      width: 400,
      height: 74,
      transparent: true,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
    })
    expect(() =>
      manager.update(createSender(12), registration.registrationID, event!.invocation.id, { phase: "active", label: "Preparing export" }),
    ).toThrow("registration is no longer active")
    expect(
      await manager.insertText(sender, registration.registrationID, event!.invocation.id, "x".repeat(200_001)),
    ).toEqual({ ok: false, error: "The text is empty or too large to insert." })

    const inserted = await manager.insertText(sender, registration.registrationID, event!.invocation.id, "private transcript")
    expect(inserted).toEqual({
      ok: false,
      error: "The target is elevated. The text was copied to the clipboard.",
      recoveredToClipboard: true,
    })
    expect(insertedText).toEqual(["private transcript"])
    expect(clipboardWrites).toEqual(["private transcript"])
    expect(
      await manager.insertText(sender, registration.registrationID, event!.invocation.id, "duplicate transcript"),
    ).toEqual({ ok: false, error: "Text insertion was already attempted for this invocation." })

    manager.update(sender, registration.registrationID, event!.invocation.id, { phase: "error", label: "Insertion failed" })
    expect(() => manager.update(sender, registration.registrationID, event!.invocation.id, { phase: "active", label: "Preparing export" })).toThrow(
      "already settled",
    )
    manager.unregister(sender, registration.registrationID)
    manager.dispose()
  })

  test("cancels in-flight insertion when the registration is disposed and preserves the text", async () => {
    clipboardWrites.length = 0
    nextInsertError = ""
    const sender = createSender(13)
    const manager = createPluginDesktopServices({ getMainWindow: () => null, logger: { warn() {}, error() {} } })
    const registration = await manager.register(sender, {
      pluginID: "speech-to-text-app",
      serviceID: "global-dictation",
      accelerator: "Ctrl+Shift+Space",
    })
    if (!registration.ok) throw new Error(registration.error)
    shortcuts.get("Ctrl+Shift+Space")?.()
    await Bun.sleep(5)
    const invocationID = sender.sent[0]!.payload.invocation.id

    const insertion = manager.insertText(sender, registration.registrationID, invocationID, "cancel pending")
    await Promise.resolve()
    manager.unregister(sender, registration.registrationID)

    expect(await insertion).toEqual({
      ok: false,
      error: "The Windows input helper was cancelled. The text was copied to the clipboard.",
      recoveredToClipboard: true,
    })
    expect(clipboardWrites).toEqual(["cancel pending"])
    manager.dispose()
  })

  test("logs a failed insertion once with the plugin and error, never the dictated text", async () => {
    clipboardWrites.length = 0
    insertedText.length = 0
    nextInsertError = "Windows did not allow the original application to regain focus."
    const warnings: Array<{ message: string; meta: unknown }> = []
    const sender = createSender(14)
    const manager = createPluginDesktopServices({
      getMainWindow: () => null,
      logger: {
        warn: (message, meta) => warnings.push({ message, meta }),
        error: (message, meta) => warnings.push({ message, meta }),
      },
    })
    const registration = await manager.register(sender, {
      pluginID: "speech-to-text-app",
      serviceID: "global-dictation",
      accelerator: "Ctrl+Shift+Space",
    })
    if (!registration.ok) throw new Error(registration.error)
    shortcuts.get("Ctrl+Shift+Space")?.()
    await Bun.sleep(5)
    const invocationID = sender.sent[0]!.payload.invocation.id

    const inserted = await manager.insertText(sender, registration.registrationID, invocationID, "secret dictated words")
    expect(inserted.ok).toBe(false)
    const logged = warnings.filter((entry) => entry.message === "desktop text insertion failed")
    expect(logged).toHaveLength(1)
    expect(logged[0]!.meta).toEqual({
      pluginID: "speech-to-text-app",
      error: "Windows did not allow the original application to regain focus.",
    })
    expect(JSON.stringify(warnings)).not.toContain("secret dictated words")
    expect(clipboardWrites).toEqual(["secret dictated words"])

    // Refusals before the helper runs are not insertion failures.
    expect(await manager.insertText(sender, registration.registrationID, invocationID, "secret dictated words")).toEqual({
      ok: false,
      error: "Text insertion was already attempted for this invocation.",
    })
    expect(warnings.filter((entry) => entry.message === "desktop text insertion failed")).toHaveLength(1)
    nextInsertError = ""
    manager.dispose()
  })
})

function createSender(id: number) {
  const destroyed: Array<() => void> = []
  let isDestroyed = false
  const sender = {
    id,
    sent: [] as Array<{ channel: string; payload: { registrationID: string; invocation: { id: string; target: unknown } } }>,
    isDestroyed: () => isDestroyed,
    setBackgroundThrottling() {
      if (isDestroyed) throw new TypeError("Object has been destroyed")
    },
    send(channel: string, payload: { registrationID: string; invocation: { id: string; target: unknown } }) {
      sender.sent.push({ channel, payload })
    },
    once(event: string, callback: () => void) {
      if (event === "destroyed") destroyed.push(callback)
    },
    removeListener(event: string, callback: () => void) {
      if (event !== "destroyed") return
      const index = destroyed.indexOf(callback)
      if (index >= 0) destroyed.splice(index, 1)
    },
    destroy() {
      isDestroyed = true
      destroyed.forEach((callback) => callback())
    },
  }
  return sender as never as Parameters<typeof createPluginDesktopServices>[0]["getMainWindow"] extends () => infer _Window
    ? typeof sender
    : never
}

function createHelper() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    kill() { this.killed = true; return true },
  })
}
