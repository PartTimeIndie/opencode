import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { BrowserWindow, IpcMainEvent } from "electron"

const windows = new Map<number, ReturnType<typeof fixture>>()
const logs: { message: string; extra?: Record<string, unknown> }[] = []

mock.module("electron", () => ({
  BrowserWindow: {
    fromWebContents: (sender: { id: number }) => windows.get(sender.id)?.win ?? null,
    getAllWindows: () => [...windows.values()].map((item) => item.win),
  },
}))
mock.module("./logging", () => ({
  write: (_scope: string, message: string, extra?: Record<string, unknown>) => logs.push({ message, extra }),
}))

const { createPaintRecovery, parseFrameStallReport, reportFrameStallFromRenderer, invalidateAllWindows } =
  await import("./paint-recovery")

let nextID = 0
function fixture() {
  const state = { visible: true, minimized: false, destroyed: false, contentsDestroyed: false }
  const events = new EventEmitter()
  const id = ++nextID
  const win = Object.assign(events, {
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isFocused: () => true,
    isMaximized: () => false,
    isFullScreen: () => false,
    getBounds: () => ({ x: -1920, y: 4, width: 1280, height: 800 }),
    setBounds: mock(() => {}),
    focus: mock(() => {}),
    restore: mock(() => {}),
    webContents: {
      id,
      isDestroyed: () => state.contentsDestroyed,
      invalidate: mock(() => {}),
      reload: mock(() => {}),
    },
  })
  const result = { state, win, window: win as unknown as BrowserWindow }
  windows.set(id, result)
  return result
}

afterEach(() => {
  for (const { win } of windows.values()) win.emit("closed")
  windows.clear()
  logs.length = 0
})

const stall = { stallMs: 9000, focused: true, visibility: "visible" }

describe("event-only paint recovery", () => {
  test("parses finite well-formed reports including resume", () => {
    expect(parseFrameStallReport(stall)).toEqual(stall)
    expect(parseFrameStallReport({ ...stall, stallMs: 0 })?.stallMs).toBe(0)
    for (const value of [undefined, null, { ...stall, stallMs: -1 }, { ...stall, stallMs: NaN },
      { ...stall, stallMs: Infinity }, { ...stall, focused: "yes" }, { ...stall, visibility: 4 }])
      expect(parseFrameStallReport(value)).toBeUndefined()
  })

  test("focus/show/restore request a repaint without polling or moving the window", () => {
    const item = fixture()
    const interval = spyOn(globalThis, "setInterval").mockImplementation((() => ({ unref() {} })) as never)
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation((() => ({ unref() {} })) as never)
    try {
      createPaintRecovery(item.window, "main")
      expect(item.win.webContents.invalidate).not.toHaveBeenCalled()
      for (const event of ["focus", "show", "restore"]) item.win.emit(event)
      expect(item.win.webContents.invalidate).toHaveBeenCalledTimes(3)
      expect(interval).not.toHaveBeenCalled()
      expect(timeout).not.toHaveBeenCalled()
      expect(item.win.setBounds).not.toHaveBeenCalled()
      expect(item.win.focus).not.toHaveBeenCalled()
      expect(item.win.restore).not.toHaveBeenCalled()
      expect(item.win.webContents.reload).not.toHaveBeenCalled()
    } finally {
      interval.mockRestore()
      timeout.mockRestore()
    }
  })

  test("repeated real stall reports never escalate to bounds changes or timers", () => {
    const item = fixture()
    let now = 0
    const recovery = createPaintRecovery(item.window, "main", () => now)
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation((() => ({ unref() {} })) as never)
    try {
      for (let count = 0; count < 5; count++) {
        recovery.reportStall(stall)
        now += 4000
      }
      expect(item.win.webContents.invalidate).toHaveBeenCalledTimes(5)
      expect(item.win.setBounds).not.toHaveBeenCalled()
      expect(item.win.webContents.reload).not.toHaveBeenCalled()
      expect(timeout).not.toHaveBeenCalled()
    } finally {
      timeout.mockRestore()
    }
  })

  test("rate-limits reports, logs resume once, and does not repaint a resume", () => {
    const item = fixture()
    let now = 10000
    const recovery = createPaintRecovery(item.window, "main", () => now)
    recovery.reportStall(stall)
    now += 3999
    recovery.reportStall(stall)
    expect(item.win.webContents.invalidate).toHaveBeenCalledTimes(1)
    now++
    recovery.reportStall(stall)
    expect(item.win.webContents.invalidate).toHaveBeenCalledTimes(2)
    recovery.reportStall({ ...stall, stallMs: 0 })
    recovery.reportStall({ ...stall, stallMs: 0 })
    expect(logs.filter((log) => log.message === "renderer frames resumed")).toHaveLength(1)
    expect(item.win.webContents.invalidate).toHaveBeenCalledTimes(2)
    now += 4000
    recovery.reportStall(stall)
    expect(item.win.webContents.invalidate).toHaveBeenCalledTimes(3)
  })

  test("wall-clock changes do not suppress the default stall cooldown", () => {
    const item = fixture()
    let elapsed = 10000
    const clock = spyOn(performance, "now").mockImplementation(() => elapsed)
    const wall = spyOn(Date, "now").mockReturnValue(3600000)
    try {
      const recovery = createPaintRecovery(item.window, "main")
      recovery.reportStall(stall)
      wall.mockReturnValue(0)
      elapsed += 3999
      recovery.reportStall(stall)
      expect(item.win.webContents.invalidate).toHaveBeenCalledTimes(1)
      elapsed++
      recovery.reportStall(stall)
      expect(item.win.webContents.invalidate).toHaveBeenCalledTimes(2)
    } finally {
      clock.mockRestore()
      wall.mockRestore()
    }
  })

  for (const state of ["visible", "minimized", "destroyed", "contentsDestroyed"] as const) {
    test(`does not repaint a non-presentable window (${state})`, () => {
      const item = fixture()
      const recovery = createPaintRecovery(item.window, "main")
      item.state[state] = state !== "visible"
      recovery.invalidate("system-resume")
      recovery.reportStall(stall)
      item.win.emit("focus")
      expect(item.win.webContents.invalidate).not.toHaveBeenCalled()
      expect(item.win.setBounds).not.toHaveBeenCalled()
    })
  }

  test("ignores hidden/prerender reports without consuming the report cooldown", () => {
    const item = fixture()
    const recovery = createPaintRecovery(item.window, "main", () => 0)
    for (const visibility of ["hidden", "prerender"]) recovery.reportStall({ ...stall, visibility })
    expect(item.win.webContents.invalidate).not.toHaveBeenCalled()
    recovery.reportStall(stall)
    expect(item.win.webContents.invalidate).toHaveBeenCalledTimes(1)
  })

  test("native state wins over a stale visible renderer report", () => {
    const item = fixture()
    const recovery = createPaintRecovery(item.window, "main", () => 0)
    item.state.visible = false
    recovery.reportStall(stall)
    item.state.visible = true
    recovery.reportStall(stall)
    expect(item.win.webContents.invalidate).toHaveBeenCalledTimes(1)
  })

  test("closed recovery detaches its events and ignores late actions", () => {
    const item = fixture()
    const recovery = createPaintRecovery(item.window, "main")
    item.win.emit("closed")
    for (const event of ["focus", "show", "restore"]) {
      expect(item.win.listenerCount(event)).toBe(0)
      item.win.emit(event)
    }
    recovery.invalidate("late")
    recovery.reportStall(stall)
    expect(item.win.webContents.invalidate).not.toHaveBeenCalled()
  })

  test("routes reports to the sender's window, never another recovery", () => {
    const first = fixture()
    const second = fixture()
    createPaintRecovery(first.window, "first")
    createPaintRecovery(second.window, "second")
    reportFrameStallFromRenderer({ sender: second.win.webContents } as unknown as IpcMainEvent, stall)
    expect(first.win.webContents.invalidate).not.toHaveBeenCalled()
    expect(second.win.webContents.invalidate).toHaveBeenCalledTimes(1)
    reportFrameStallFromRenderer({ sender: { id: -1 } } as IpcMainEvent, stall)
    expect(first.win.webContents.invalidate).not.toHaveBeenCalled()
  })

  test("unregistered reports ignore resume/hidden and only repaint a live visible sender", () => {
    const item = fixture()
    const event = { sender: item.win.webContents } as unknown as IpcMainEvent
    reportFrameStallFromRenderer(event, { ...stall, stallMs: 0 })
    reportFrameStallFromRenderer(event, { ...stall, visibility: "hidden" })
    item.state.minimized = true
    reportFrameStallFromRenderer(event, stall)
    expect(item.win.webContents.invalidate).not.toHaveBeenCalled()
    item.state.minimized = false
    reportFrameStallFromRenderer(event, stall)
    expect(item.win.webContents.invalidate).toHaveBeenCalledTimes(1)
  })

  test("GPU/resume/display events repaint only live visible registered or unregistered windows", () => {
    const registered = fixture()
    const unregistered = fixture()
    const hidden = fixture()
    const minimized = fixture()
    const dead = fixture()
    createPaintRecovery(registered.window, "main")
    hidden.state.visible = false
    minimized.state.minimized = true
    dead.state.contentsDestroyed = true
    for (const trigger of ["gpu-process-gone", "system-resume", "display-metrics-changed"])
      invalidateAllWindows(trigger)
    expect(registered.win.webContents.invalidate).toHaveBeenCalledTimes(3)
    expect(unregistered.win.webContents.invalidate).toHaveBeenCalledTimes(3)
    expect(hidden.win.webContents.invalidate).not.toHaveBeenCalled()
    expect(minimized.win.webContents.invalidate).not.toHaveBeenCalled()
    expect(dead.win.webContents.invalidate).not.toHaveBeenCalled()
    for (const { win } of windows.values()) expect(win.setBounds).not.toHaveBeenCalled()
  })
})
