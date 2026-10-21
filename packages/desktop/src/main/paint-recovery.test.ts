import { describe, expect, mock, test } from "bun:test"

mock.module("electron", () => ({
  app: {
    getPath: () => "",
  },
  BrowserWindow: {
    fromWebContents: () => null,
    getAllWindows: () => [],
  },
  crashReporter: {
    start: () => undefined,
  },
  netLog: {
    currentlyLogging: false,
  },
  shell: {},
}))

const { createPaintRecovery, nextPaintRecoveryAction, parseFrameStallReport } = await import("./paint-recovery")

describe("paint recovery decisions", () => {
  test("escalates from invalidate to bounds nudge as stall reports repeat", () => {
    expect(nextPaintRecoveryAction({ stallReports: 0, visibility: "visible" })).toBe("none")
    expect(nextPaintRecoveryAction({ stallReports: 1, visibility: "visible" })).toBe("invalidate")
    expect(nextPaintRecoveryAction({ stallReports: 2, visibility: "visible" })).toBe("nudge")
    expect(nextPaintRecoveryAction({ stallReports: 5, visibility: "visible" })).toBe("nudge")
  })

  test("never acts on reports from hidden windows", () => {
    expect(nextPaintRecoveryAction({ stallReports: 3, visibility: "hidden" })).toBe("none")
    expect(nextPaintRecoveryAction({ stallReports: 3, visibility: "prerender" })).toBe("none")
  })

  test("parses only well-formed frame stall reports", () => {
    expect(parseFrameStallReport({ stallMs: 9000, focused: true, visibility: "visible" })).toEqual({
      stallMs: 9000,
      focused: true,
      visibility: "visible",
    })
    expect(parseFrameStallReport(undefined)).toBeUndefined()
    expect(parseFrameStallReport({ stallMs: -1, focused: true, visibility: "visible" })).toBeUndefined()
    expect(parseFrameStallReport({ stallMs: Number.NaN, focused: true, visibility: "visible" })).toBeUndefined()
    expect(parseFrameStallReport({ stallMs: 9000, focused: "yes", visibility: "visible" })).toBeUndefined()
    expect(parseFrameStallReport({ stallMs: 9000, focused: true, visibility: 4 })).toBeUndefined()
  })

  test("first stall invalidates, second stall nudges bounds, resume report resets", () => {
    const actions: string[] = []
    const boundsCall: Record<string, unknown>[] = []
    let virtualNow = 100000
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 1,
        isDestroyed: () => false,
        invalidate: () => actions.push("invalidate"),
      },
      on: () => {},
      once: () => {},
      getBounds: () => ({ x: 10, y: 20, width: 1280, height: 800 }),
      setBounds: (next: Record<string, unknown>) => {
        actions.push("setBounds")
        boundsCall.push(next)
      },
    } as never

    const recovery = createPaintRecovery(win, "test", () => virtualNow)

    recovery.reportStall({ stallMs: 9000, focused: true, visibility: "visible" })
    expect(actions).toEqual(["invalidate"])

    virtualNow += 5000
    recovery.reportStall({ stallMs: 13000, focused: true, visibility: "visible" })
    expect(actions).toEqual(["invalidate", "setBounds", "setBounds"])
    // Nudge moves one pixel, then restores the original position.
    expect(boundsCall[0]).toMatchObject({ x: 11, y: 20, width: 1280, height: 800 })
    expect(boundsCall[1]).toMatchObject({ x: 10, y: 20, width: 1280, height: 800 })

    recovery.reportStall({ stallMs: 0, focused: true, visibility: "visible" })
    virtualNow += 5000
    recovery.reportStall({ stallMs: 9000, focused: true, visibility: "visible" })
    expect(actions.filter((action) => action === "invalidate")).toHaveLength(2)
  })

  test("invalidates on focus and nudges a still-focused surface", () => {
    const actions: string[] = []
    const listeners = new Map<string, () => void>()
    let check: (() => void) | undefined
    let cancelled = 0
    let intervalMs = 0
    const win = {
      isDestroyed: () => false,
      isVisible: () => true,
      isFocused: () => true,
      webContents: { id: 3, isDestroyed: () => false, invalidate: () => actions.push("invalidate") },
      on: (event: string, callback: () => void) => listeners.set(event, callback),
      once: () => {},
      getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      setBounds: () => actions.push("setBounds"),
    } as never

    createPaintRecovery(
      win,
      "test",
      Date.now,
      ((callback: () => void, ms: number) => {
        check = callback
        intervalMs = ms
        return { unref: () => {} }
      }) as never,
      (() => {
        cancelled += 1
      }) as never,
    )
    expect(actions).toEqual([])

    listeners.get("focus")?.()
    expect(actions).toEqual(["invalidate"])
    expect(intervalMs).toBe(15_000)

    check?.()
    expect(actions).toEqual(["invalidate", "setBounds", "setBounds"])

    listeners.get("blur")?.()
    expect(cancelled).toBe(1)
  })

  test("ignores stall reports from hidden windows and stalls inside the cooldown", () => {
    const actions: string[] = []
    let virtualNow = 100000
    const win = {
      isDestroyed: () => false,
      webContents: { id: 2, isDestroyed: () => false, invalidate: () => actions.push("invalidate") },
      on: () => {},
      once: () => {},
      getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      setBounds: () => actions.push("setBounds"),
    } as never

    const recovery = createPaintRecovery(win, "test", () => virtualNow)

    recovery.reportStall({ stallMs: 9000, focused: false, visibility: "hidden" })
    expect(actions).toEqual([])

    recovery.reportStall({ stallMs: 9000, focused: true, visibility: "visible" })
    expect(actions).toEqual(["invalidate"])

    // Immediate repeat stays inside the action cooldown and must not nudge.
    recovery.reportStall({ stallMs: 12000, focused: true, visibility: "visible" })
    expect(actions).toEqual(["invalidate"])
  })
})
