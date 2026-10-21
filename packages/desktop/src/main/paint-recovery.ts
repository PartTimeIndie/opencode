import type { IpcMainEvent } from "electron"
import { BrowserWindow } from "electron"
import { write as writeLog } from "./logging"
import { liveWindow } from "./window-lifecycle"

// Windows can stop presenting a window's composited surface while the
// renderer process stays alive and responsive: the window turns into the
// native background color (gray in the light tone, near-black in the dark
// tone) and only recovers when the user moves or resizes it. Moving the
// window reallocates the DWM surface, so recovery mirrors that manual fix:
// invalidate the surface first and nudge the window bounds by one pixel if
// the renderer still reports stalled frames.

export type FrameStallReport = {
  stallMs: number
  focused: boolean
  visibility: string
}

export type PaintRecoveryAction = "none" | "invalidate" | "nudge"

const actionCooldownMs = 4000
const focusedSurfaceCheckMs = 15_000

export function nextPaintRecoveryAction(input: { stallReports: number; visibility: string }): PaintRecoveryAction {
  if (input.visibility !== "visible") return "none"
  if (input.stallReports <= 0) return "none"
  return input.stallReports === 1 ? "invalidate" : "nudge"
}
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
  nudge: (trigger: string) => void
}

const recoveries = new Map<number, WindowPaintRecovery>()

export function createPaintRecovery(
  win: BrowserWindow,
  name: string,
  now: () => number = Date.now,
  schedule: typeof setInterval = setInterval,
  cancel: typeof clearInterval = clearInterval,
) {
  let stallReports = 0
  let nudging = false
  let lastActionAt = 0
  let focusedSurfaceCheck: ReturnType<typeof setInterval> | undefined
  let focusedSurfaceChecks = 0

  const invalidate = (trigger: string) => {
    const target = liveWindow(win)
    if (!target) return
    writeLog("window", "invalidating window surface", { window: name, trigger })
    target.webContents.invalidate()
  }

  const nudge = (trigger: string) => {
    const target = liveWindow(win)
    if (!target || nudging) return
    nudging = true
    try {
      const bounds = target.getBounds()
      target.setBounds({ ...bounds, x: bounds.x + 1 })
      target.setBounds(bounds)
      writeLog("window", "nudged window bounds to force surface repaint", { window: name, trigger, bounds })
    } finally {
      nudging = false
    }
  }

  const stopFocusedSurfaceCheck = () => {
    if (focusedSurfaceCheck === undefined) return
    cancel(focusedSurfaceCheck)
    focusedSurfaceCheck = undefined
    focusedSurfaceChecks = 0
  }

  const startFocusedSurfaceCheck = () => {
    if (focusedSurfaceCheck !== undefined) return
    focusedSurfaceCheck = schedule(() => {
      const target = liveWindow(win)
      if (!target || !target.isVisible() || !target.isFocused()) {
        stopFocusedSurfaceCheck()
        return
      }
      // Chromium continues to run requestAnimationFrame while DWM presents a
      // stale surface, so renderer liveness cannot distinguish this failure.
      // Invalidate on focus/show, then alternate the resize-equivalent nudge
      // with a cheap invalidate while the window remains focused.
      focusedSurfaceChecks += 1
      if (focusedSurfaceChecks % 2 === 1) {
        nudge("focused-surface-watchdog")
        return
      }
      invalidate("focused-surface-watchdog")
    }, focusedSurfaceCheckMs)
    focusedSurfaceCheck.unref?.()
  }

  const reportStall = (report: FrameStallReport) => {
    if (report.stallMs === 0) {
      if (stallReports === 0) return
      stallReports = 0
      writeLog("window", "renderer frames resumed", { window: name, focused: report.focused })
      return
    }
    if (report.visibility !== "visible") return
    const current = now()
    if (current - lastActionAt < actionCooldownMs) return
    stallReports += 1
    lastActionAt = current
    const action = nextPaintRecoveryAction({ stallReports, visibility: report.visibility })
    writeLog("window", "renderer frame stall reported", { window: name, ...report, stallReports, action }, "error")
    if (action === "invalidate") return invalidate("frame-stall")
    if (action === "nudge") return nudge("frame-stall")
  }

  win.on("show", () => {
    stallReports = 0
    invalidate("window-show")
    if (win.isFocused()) startFocusedSurfaceCheck()
  })
  // A stale DWM surface can survive while the renderer and BrowserWindow stay
  // healthy. Focusing the window is the first native presentation transition
  // after the user notices the blank surface, so invalidate it immediately and
  // keep a sparse invalidate-only watchdog while the window remains focused.
  win.on("focus", () => {
    invalidate("window-focus")
    startFocusedSurfaceCheck()
  })
  win.on("blur", stopFocusedSurfaceCheck)
  win.on("restore", () => {
    stallReports = 0
    invalidate("window-restore")
    if (win.isFocused()) startFocusedSurfaceCheck()
  })
  const contentsId = win.webContents.id
  win.once("closed", () => {
    stopFocusedSurfaceCheck()
    recoveries.delete(contentsId)
  })

  const instance = { reportStall, invalidate, nudge }
  recoveries.set(win.webContents.id, instance)
  return instance
}

export function reportFrameStallFromRenderer(event: IpcMainEvent, report: FrameStallReport) {
  const recovery = recoveries.get(event.sender.id)
  if (recovery) return recovery.reportStall(report)
  const win = liveWindow(BrowserWindow.fromWebContents(event.sender))
  if (win) win.webContents.invalidate()
}

export function invalidateAllWindows(trigger: string) {
  for (const win of BrowserWindow.getAllWindows()) {
    const recovery = recoveries.get(win.webContents.id)
    if (recovery) {
      recovery.invalidate(trigger)
      continue
    }
    if (liveWindow(win)) win.webContents.invalidate()
  }
}
