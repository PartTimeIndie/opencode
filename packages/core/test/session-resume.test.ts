import { describe, expect, test } from "bun:test"
import { SessionFailure } from "@opencode-ai/core/session/failure"
import { SessionResume } from "@opencode-ai/core/session/resume"

describe("SessionResume", () => {
  test("a shared activity recovery budget issues each attempt once and never resets", () => {
    const budget = SessionResume.recoveryBudget()
    expect(Array.from({ length: 7 }, () => budget.next())).toEqual([1, 2, 3, 4, 5, undefined, undefined])
    expect(SessionResume.recoveryBudget().next()).toBe(1)
  })

  test("every failure code has a policy matching retryability", () => {
    for (const code of SessionFailure.codes) {
      const failure = SessionFailure.make(code)
      const next = SessionResume.policy(code)
      if (failure.retryability === "none") {
        expect(next.action).toBe("terminal")
        expect(next.maxAttempts).toBe(0)
      } else {
        expect(next.action).toBe(failure.retryability)
        expect(next.maxAttempts).toBeGreaterThan(0)
      }
    }
  })

  test("resume-after-provider-abort: transport auto-retries then remains counted", () => {
    const failure = SessionFailure.make("provider.transport")
    const first = SessionResume.decide({ failure, attempt: 0 })
    expect(first).toMatchObject({ action: "auto-retry", attempt: 1, remaining: 4 })
    if (first.action === "auto-retry") expect(first.delayMs).toBe(2_000)
    const last = SessionResume.decide({ failure, attempt: 4 })
    expect(last).toMatchObject({ action: "auto-retry", attempt: 5, remaining: 0 })
  })

  test("retry-exhaustion-terminal: sixth transport failure settles the error card", () => {
    const failure = SessionFailure.make("provider.transport")
    const decided = SessionResume.decide({ failure, attempt: 5 })
    expect(decided).toEqual({ action: "terminal", failure })
  })

  test("user-stop-no-retry: user.stop never auto-retries or resumes", () => {
    const failure = SessionFailure.make("user.stop")
    expect(SessionResume.policy("user.stop").action).toBe("terminal")
    expect(SessionResume.decide({ failure, attempt: 0 })).toEqual({ action: "terminal", failure })
    expect(SessionResume.decide({ failure, attempt: 3 })).toEqual({ action: "terminal", failure })
  })

  test("explicit terminal failure retryability overrides a normally retryable code", () => {
    const failure = SessionFailure.make("provider.rate-limit", {
      retryability: "none",
      remediation: "report",
    })

    expect(SessionResume.decide({ failure, attempt: 0, retryAfterMs: 0 })).toEqual({ action: "terminal", failure })
  })

  test("lease.stale auto-resumes while a checkpoint exists", () => {
    const failure = SessionFailure.make("lease.stale")
    const decided = SessionResume.decide({ failure, attempt: 0, hasCheckpoint: true })
    expect(decided).toMatchObject({ action: "resume", attempt: 1, remaining: 2 })
  })

  test("resume without a checkpoint becomes internal.defect terminal", () => {
    const failure = SessionFailure.make("lease.stale")
    const decided = SessionResume.decide({ failure, attempt: 0, hasCheckpoint: false })
    expect(decided.action).toBe("terminal")
    if (decided.action === "terminal") {
      expect(decided.failure.code).toBe("internal.defect")
      expect(decided.failure.cause?.detail).toContain("no durable step checkpoint")
    }
  })

  test("Retry-After is preserved even beyond the normal backoff ceiling", () => {
    expect(SessionResume.delayMs("provider.rate-limit", 1, 5_000)).toBe(5_000)
    expect(SessionResume.delayMs("provider.rate-limit", 1, 60_000)).toBe(60_000)
  })

  test("a Retry-After beyond five minutes settles terminally instead of sleeping or retrying early", () => {
    const failure = SessionFailure.make("provider.rate-limit")
    expect(SessionResume.decide({ failure, attempt: 0, retryAfterMs: 300_000 }).action).toBe("auto-retry")
    expect(SessionResume.decide({ failure, attempt: 0, retryAfterMs: 300_001 }).action).toBe("terminal")
    expect(SessionResume.decide({ failure, attempt: 0, retryAfterMs: 86_400_000 }).action).toBe("terminal")
    expect(SessionResume.delayMs("provider.rate-limit", 1, 86_400_000)).toBe(86_400_000)
  })

  test("owner.interrupted and rollback never retry", () => {
    for (const code of ["owner.interrupted", "rollback.requested", "permission.denied"] as const) {
      const failure = SessionFailure.make(code)
      expect(SessionResume.decide({ failure, attempt: 0 }).action).toBe("terminal")
    }
  })

  test("retryBudget keeps unclassified internal.defect retryable at the historic cap", () => {
    expect(SessionResume.retryBudget("provider.transport")).toBe(5)
    expect(SessionResume.retryBudget("internal.defect")).toBe(5)
    expect(SessionResume.retryBudget("user.stop")).toBe(0)
  })
})
