import { describe, expect, test } from "bun:test"
import { createBrowserTransferGuard } from "./browser-transfer-guard"

describe("browser transfer guard", () => {
  test("rejects a transfer while an action is resolving or using a guest", () => {
    const guard = createBrowserTransferGuard()
    const release = guard.beginAction()
    expect(guard.reserve(42)).toBeUndefined()
    release()
    const ticket = guard.reserve(42)
    expect(ticket).toBeDefined()
    expect(() => guard.beginAction()).toThrow("transfer")
    expect(guard.commit(42, ticket!)).toBe(true)
    const next = guard.beginAction()
    expect(() => guard.assertAccessible(42)).toThrow("dock")
    expect(() => guard.assertAccessible(43)).not.toThrow()
    next()
  })

  test("only the matching ticket can finish or cancel a reservation", () => {
    const guard = createBrowserTransferGuard()
    const ticket = guard.reserve(42)!
    expect(guard.commit(42, "wrong")).toBe(false)
    expect(guard.cancel(42, "wrong")).toBe(false)
    expect(() => guard.beginAction()).toThrow("transfer")
    expect(guard.cancel(42, ticket)).toBe(true)
    expect(guard.cancel(42, ticket)).toBe(false)
    const release = guard.beginAction()
    release()
    release()
    expect(guard.reserve(42)).toBeDefined()
  })

  test("returning a docked guest restores access without releasing other guests", () => {
    const guard = createBrowserTransferGuard()
    const first = guard.reserve(42)!
    expect(guard.commit(42, first)).toBe(true)
    const second = guard.reserve(43)!
    expect(guard.commit(43, second)).toBe(true)
    expect(guard.returnToBrowser(42, first)).toBe(true)
    const replacement = guard.reserve(42)!
    expect(guard.commit(42, replacement)).toBe(true)
    expect(guard.returnToBrowser(42, first)).toBe(false)
    expect(() => guard.assertAccessible(42)).toThrow("dock")
    expect(guard.returnToBrowser(42, replacement)).toBe(true)
    expect(() => guard.assertAccessible(42)).not.toThrow()
    expect(() => guard.assertAccessible(43)).toThrow("dock")
  })
})
