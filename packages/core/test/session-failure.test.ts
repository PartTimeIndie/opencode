import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionFailure } from "@opencode-ai/core/session/failure"

const roundtrip = (value: SessionFailure.Failure) =>
  Schema.decodeUnknownSync(SessionFailure.Failure)(JSON.parse(JSON.stringify(value)))

describe("SessionFailure contract", () => {
  test("roundtrips through JSON with optional keys omitted", () => {
    const failure = SessionFailure.make("provider.transport", {
      cause: { raw: "stream was aborted by remote", detail: "streamStep" },
      providerRef: "openai/gpt-5.5",
    })
    const encoded = Schema.encodeUnknownSync(SessionFailure.Failure)(failure)
    expect(encoded).toEqual(failure)
    expect(roundtrip(failure)).toEqual(failure)

    const minimal = SessionFailure.make("user.stop")
    expect("cause" in minimal).toBe(false)
    expect("providerRef" in minimal).toBe(false)
    expect(roundtrip(minimal)).toEqual(minimal)
  })

  test("every registered code carries card-ready defaults and roundtrips", () => {
    expect(SessionFailure.codes.length).toBeGreaterThan(0)
    for (const code of SessionFailure.codes) {
      const failure = SessionFailure.make(code)
      expect(failure.message.length).toBeGreaterThan(0)
      expect(failure.retryability).toBeDefined()
      expect(failure.remediation).toBeDefined()
      expect(roundtrip(failure)).toEqual(failure)
    }
  })

  test("defaults keep remediation coherent with retryability", () => {
    for (const code of SessionFailure.codes) {
      const failure = SessionFailure.make(code)
      if (failure.remediation === "resume") expect(failure.retryability).not.toBe("none")
      if (failure.retryability === "auto-retry") expect(failure.remediation).toBe("retry")
    }
  })

  test("rejects unknown codes instead of passing them through", () => {
    const unknown = { code: "provider.stream-aborted", message: "x", retryability: "none", remediation: "report" }
    expect(() => Schema.decodeUnknownSync(SessionFailure.Failure)(unknown)).toThrow()
    expect(() => Schema.decodeUnknownSync(SessionFailure.Failure)({ code: "user.stop" })).toThrow()
  })

  test("maps every canonical interrupt reason to exactly one registered code", () => {
    const expected: Record<SessionFailure.InterruptReason, SessionFailure.Code> = {
      "user-stop": "user.stop",
      "owner-interrupted": "owner.interrupted",
      "owner-shutdown": "owner.shutdown",
      "stale-lease": "lease.stale",
      rollback: "rollback.requested",
    }
    for (const reason of Object.keys(expected) as SessionFailure.InterruptReason[]) {
      expect(SessionFailure.fromInterruptReason(reason).code).toBe(expected[reason])
      expect(roundtrip(SessionFailure.fromInterruptReason(reason))).toEqual(SessionFailure.fromInterruptReason(reason))
    }
  })

  test("every legacy classification site maps onto a registered code", () => {
    // Coverage table for the E2 cutover: each site that classifies errors by
    // string or interrupt label today must land on exactly one code above.
    const legacySites: Array<{ site: string; code: SessionFailure.Code }> = [
      { site: "ai-chain stream abort regex", code: "provider.transport" },
      { site: "ai-chain stream inactivity (stalled / no events)", code: "provider.transport" },
      { site: "runner/llm failUnsettledTools source=provider", code: "provider.transport" },
      { site: "runner/llm failUnsettledTools source=session", code: "user.stop" },
      { site: "runner/llm failUnsettledTools source=recovery", code: "lease.stale" },
      { site: "projector/message-updater 'Tool execution aborted/interrupted' metadata", code: "user.stop" },
      { site: "question.ts recovery interruption", code: "lease.stale" },
      { site: "task-job process-restart interrupted", code: "lease.stale" },
      { site: "activity interruptReason user-stop", code: "user.stop" },
      { site: "activity interruptReason owner-interrupted", code: "owner.interrupted" },
      { site: "activity interruptReason owner-shutdown", code: "owner.shutdown" },
      { site: "activity interruptReason stale-lease", code: "lease.stale" },
      { site: "activity interruptReason rollback", code: "rollback.requested" },
      { site: "unclassifiable provider error fallback", code: "internal.defect" },
      { site: "empty or structurally invalid provider response", code: "provider.invalid-response" },
    ]
    const registered = new Set(SessionFailure.codes)
    for (const entry of legacySites) expect(registered.has(entry.code)).toBe(true)
  })
})
