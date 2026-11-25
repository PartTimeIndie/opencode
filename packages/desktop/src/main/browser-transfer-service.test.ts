import { describe, expect, test } from "bun:test"
import { createBrowserTransferGuard } from "./browser-transfer-guard"
import { createBrowserTransferService } from "./browser-transfer-service"

describe("browser transfer service", () => {
  test("expires abandoned reservations but never expires committed dock ownership", async () => {
    const guard = createBrowserTransferGuard()
    const service = createBrowserTransferService(guard, () => true, 10)
    const stale = service.reserve(1, 42)
    const committed = service.reserve(1, 43)
    expect(service.commit(1, 43, committed)).toBe(true)
    await Bun.sleep(30)
    const release = guard.beginAction()
    release()
    expect(service.commit(1, 42, stale)).toBe(false)
    expect(() => guard.assertAccessible(43)).toThrow("dock")
    const fresh = service.reserve(1, 42)
    expect(service.release(1, 42, stale)).toBe(false)
    expect(() => guard.assertAccessible(42)).toThrow("dock")
    expect(service.release(1, 42, fresh)).toBe(true)
    service.closeHost(1)
  })

  test("accepts only the guest's host and fences stale transfer generations", () => {
    const guard = createBrowserTransferGuard()
    const service = createBrowserTransferService(guard, (host, guest) => host === 1 && guest === 42)
    expect(() => service.reserve(2, 42)).toThrow("owner")
    expect(() => service.reserve(1, 43)).toThrow("owner")
    const a = service.reserve(1, 42)
    expect(() => service.commit(2, 42, a)).toThrow("owner")
    expect(service.commit(1, 42, a)).toBe(true)
    expect(service.release(1, 42, a)).toBe(true)
    const b = service.reserve(1, 42)
    expect(service.commit(1, 42, b)).toBe(true)
    expect(service.release(1, 42, a)).toBe(false)
    expect(() => guard.assertAccessible(42)).toThrow("dock")
    expect(service.release(1, 42, b)).toBe(true)
  })

  test("cleans pending and committed ownership when a host or guest closes", () => {
    const guard = createBrowserTransferGuard()
    const service = createBrowserTransferService(guard, () => true)
    service.reserve(1, 42)
    expect(() => guard.beginAction()).toThrow("transfer")
    service.closeHost(1)
    const release = guard.beginAction()
    release()
    const ticket = service.reserve(1, 42)
    service.commit(1, 42, ticket)
    service.closeGuest(42)
    expect(() => guard.assertAccessible(42)).not.toThrow()
  })

  test("rejects reservations during an existing action without changing ownership", () => {
    const guard = createBrowserTransferGuard()
    const service = createBrowserTransferService(guard, () => true)
    const release = guard.beginAction()
    expect(() => service.reserve(1, 42)).toThrow("used")
    release()
    expect(service.reserve(1, 42)).toBeString()
  })
})
