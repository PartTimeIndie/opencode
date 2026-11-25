import { onCleanup, onMount } from "solid-js"

// This monitors renderer animation callbacks, not whether Windows actually
// presents a frame. The desktop process may request a repaint on a stall;
// neither a report nor a repaint request proves or fixes a presentation failure.

const STALL_MS = 8000
const CHECK_INTERVAL_MS = 2000
const REPORT_COOLDOWN_MS = 4000

export type FrameStallDecision = {
  report: boolean
  stallMs: number
}

export function nextFrameStallReport(input: {
  now: number
  lastFrameAt: number
  lastReportAt: number | undefined
  visibility: string
}): FrameStallDecision {
  if (input.visibility !== "visible") return { report: false, stallMs: 0 }
  const stallMs = input.now - input.lastFrameAt
  if (stallMs < STALL_MS) return { report: false, stallMs }
  if (input.lastReportAt !== undefined && input.now - input.lastReportAt < REPORT_COOLDOWN_MS) {
    return { report: false, stallMs }
  }
  return { report: true, stallMs }
}

export function PresentationWatchdog() {
  onMount(() => {
    const reportFrameStall = window.api?.reportFrameStall
    if (!reportFrameStall) return

    let lastFrameAt = performance.now()
    let lastReportAt: number | undefined
    let stalled = false
    let frame = 0

    // A single self-rescheduling chain tracks animation callback liveness.
    const armFrame = () => {
      frame = requestAnimationFrame(() => {
        lastFrameAt = performance.now()
        armFrame()
      })
    }
    armFrame()

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") lastFrameAt = performance.now()
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)

    const timer = setInterval(() => {
      const decision = nextFrameStallReport({
        now: performance.now(),
        lastFrameAt,
        lastReportAt,
        visibility: document.visibilityState,
      })
      if (!decision.report) {
        if (!stalled || document.visibilityState !== "visible" || decision.stallMs >= STALL_MS) return
        stalled = false
        reportFrameStall({ stallMs: 0, focused: document.hasFocus(), visibility: document.visibilityState })
        return
      }
      lastReportAt = performance.now()
      stalled = true
      reportFrameStall({
        stallMs: Math.round(decision.stallMs),
        focused: document.hasFocus(),
        visibility: document.visibilityState,
      })
    }, CHECK_INTERVAL_MS)

    onCleanup(() => {
      cancelAnimationFrame(frame)
      clearInterval(timer)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    })
  })
  return null
}
