import { describe, expect, test } from "bun:test"
import { nextFrameStallReport } from "./presentation-watchdog"

describe("presentation watchdog frame stall decisions", () => {
  test("reports only after frames are stale beyond the stall window", () => {
    const base = { lastFrameAt: 0, lastReportAt: undefined, visibility: "visible" } as const

    expect(nextFrameStallReport({ ...base, now: 2000 })).toEqual({ report: false, stallMs: 2000 })
    expect(nextFrameStallReport({ ...base, now: 7999 })).toEqual({ report: false, stallMs: 7999 })
    expect(nextFrameStallReport({ ...base, now: 8001 })).toEqual({ report: true, stallMs: 8001 })
  })

  test("never reports while the document is hidden", () => {
    const decision = nextFrameStallReport({ now: 60000, lastFrameAt: 0, lastReportAt: undefined, visibility: "hidden" })
    expect(decision).toEqual({ report: false, stallMs: 0 })
  })

  test("rate-limits repeated reports while the stall continues", () => {
    const base = { lastFrameAt: 0, visibility: "visible" } as const

    expect(nextFrameStallReport({ ...base, now: 9000, lastReportAt: 8990 })).toEqual({ report: false, stallMs: 9000 })
    expect(nextFrameStallReport({ ...base, now: 13001, lastReportAt: 8990 })).toEqual({ report: true, stallMs: 13001 })
  })

  test("a fresh frame clears an existing stall", () => {
    const decision = nextFrameStallReport({
      now: 60000,
      lastFrameAt: 59900,
      lastReportAt: 50000,
      visibility: "visible",
    })
    expect(decision).toEqual({ report: false, stallMs: 100 })
  })
})
