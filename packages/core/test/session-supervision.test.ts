import { describe, expect, test } from "bun:test"
import { SessionFailure } from "@opencode-ai/core/session/failure"
import { SessionSupervision } from "@opencode-ai/core/session/supervision"

describe("SessionSupervision", () => {
  test("ownsLease is exclusive to a future leaseUntil", () => {
    expect(SessionSupervision.ownsLease({ now: 100, leaseUntil: 101 })).toBe(true)
    expect(SessionSupervision.ownsLease({ now: 100, leaseUntil: 100 })).toBe(false)
    expect(SessionSupervision.ownsLease({ now: 100, leaseUntil: null })).toBe(false)
    expect(SessionSupervision.ownsLease({ now: 100 })).toBe(false)
  })

  test("stale jobs recover up to the resume budget then terminal lease.stale", () => {
    const first = SessionSupervision.recover({ now: 10, leaseUntil: 0, recoveryAttempts: 0 })
    expect(first).toMatchObject({ action: "recover", attempt: 1 })
    const last = SessionSupervision.recover({ now: 10, leaseUntil: 0, recoveryAttempts: 3 })
    expect(last.action).toBe("terminal")
    if (last.action === "terminal") expect(last.failure.code).toBe("lease.stale")
  })

  test("live leases heartbeat instead of recovering another instance's job", () => {
    const decided = SessionSupervision.recover({ now: 10, leaseUntil: 11 })
    expect(decided.action).toBe("heartbeat")
  })

  test("follow-up recovery waits just past an observed lease expiry", () => {
    expect(SessionSupervision.recoveryScanDelayMs({ now: 1_000, leaseUntil: 1_500 })).toBe(750)
    expect(SessionSupervision.recoveryScanDelayMs({ now: 1_000, leaseUntil: 1_500, guardMs: 10 })).toBe(510)
  })

  test("staleJobError is the typed lease.stale message", () => {
    expect(SessionSupervision.staleJobError()).toBe(SessionFailure.make("lease.stale").message)
  })
})
