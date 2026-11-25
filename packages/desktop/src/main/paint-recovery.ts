import type { IpcMainEvent } from "electron"
import { BrowserWindow } from "electron"
import { write } from "./logging"
import { liveWindow } from "./window-lifecycle"

// Request repaint only in response to an event. Never move/resize a window or
// poll its surface: neither renderer liveness nor invalidate() acknowledges a
// frame reaching the screen, so neither can diagnose or prevent a black window.
export type FrameStallReport = {
  stallMs: number
  focused: boolean
  visibility: string
}

const reportCooldownMs = 4000

export function parseFrameStallReport(value: unknown): FrameStallReport | undefined {
  if (typeof value !== "object" || value === null) return
  const report = value as Record<string, unknown>
  if (typeof report.stallMs !== "number" || !Number.isFinite(report.stallMs) || report.stallMs < 0) return
  if (typeof report.focused !== "boolean" || typeof report.visibility !== "string") return
  return { stallMs: report.stallMs, focused: report.focused, visibility: report.visibility }
}

type WindowPaintRecovery = {
  reportStall: (report: FrameStallReport) => void
  invalidate: (trigger: string) => void
}

const recoveries = new Map<number, WindowPaintRecovery>()

export function createPaintRecovery(win: BrowserWindow, name: string, now: () => number = () => performance.now()) {
  let closed = false
  let stalled = false
  let lastReportAt: number | undefined

  const invalidate = (trigger: string) => {
    if (closed) return
    const target = paintableWindow(win)
    if (!target) return
    write("window", "invalidating window surface", { window: name, trigger })
    target.webContents.invalidate()
  }

  const reportStall = (report: FrameStallReport) => {
    if (closed) return
    if (report.stallMs === 0) {
      if (!stalled) return
      stalled = false
      write("window", "renderer frames resumed", { window: name, focused: report.focused })
      return
    }
    if (report.visibility !== "visible" || !paintableWindow(win)) return
    const current = now()
    if (lastReportAt !== undefined && current - lastReportAt < reportCooldownMs) return
    lastReportAt = current
    stalled = true
    write("window", "renderer frame stall reported", { window: name, ...report }, "error")
    invalidate("frame-stall")
  }

  const show = () => invalidate("window-show")
  const focus = () => invalidate("window-focus")
  const restore = () => invalidate("window-restore")
  win.on("show", show)
  win.on("focus", focus)
  win.on("restore", restore)
  const contentsId = win.webContents.id
  win.once("closed", () => {
    closed = true
    win.removeListener("show", show)
    win.removeListener("focus", focus)
    win.removeListener("restore", restore)
    recoveries.delete(contentsId)
  })

  const instance = { reportStall, invalidate }
  recoveries.set(contentsId, instance)
  return instance
}

export function reportFrameStallFromRenderer(event: IpcMainEvent, report: FrameStallReport) {
  const recovery = recoveries.get(event.sender.id)
  if (recovery) return recovery.reportStall(report)
  if (report.stallMs <= 0 || report.visibility !== "visible") return
  const win = paintableWindow(BrowserWindow.fromWebContents(event.sender))
  win?.webContents.invalidate()
}

export function invalidateAllWindows(trigger: string) {
  for (const win of BrowserWindow.getAllWindows()) {
    const target = paintableWindow(win)
    if (!target) continue
    const recovery = recoveries.get(target.webContents.id)
    if (recovery) {
      recovery.invalidate(trigger)
      continue
    }
    target.webContents.invalidate()
  }
}

function paintableWindow(win: BrowserWindow | null) {
  const target = liveWindow(win)
  if (!target || !target.isVisible() || target.isMinimized()) return null
  return target
}
