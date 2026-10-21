import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionFailure } from "@opencode-ai/core/session/failure"
import { SessionFailureCard } from "@opencode-ai/core/session/failure-card"
import { SessionAbortMetrics } from "@opencode-ai/core/session/abort-metrics"
import { SurfaceSchema } from "@opencode-ai/core/surface/schema"

describe("SessionFailureCard", () => {
  test("exposes code, cause, remediation and retry state without raw-only payloads", () => {
    const failure = SessionFailure.make("provider.transport", {
      cause: { raw: "stream was aborted by remote" },
      providerRef: "openai/gpt-5.5",
    })
    const card = SessionFailureCard.fromFailure(failure, { attempt: 3, maxAttempts: 5, nextRetryAt: 99 })
    expect(card.code).toBe("provider.transport")
    expect(card.remediation).toBe("retry")
    expect(card.cause?.raw).toBe("stream was aborted by remote")
    expect(card.retryState).toEqual({ attempt: 3, maxAttempts: 5, nextRetryAt: 99 })
  })
})

describe("SessionAbortMetrics", () => {
  test("excludes user.stop and owner.shutdown from the defect-abort rate", () => {
    const codes = [
      "user.stop",
      "owner.shutdown",
      "provider.transport",
      "lease.stale",
    ] as const
    expect(SessionAbortMetrics.defectRate(codes)).toBe(0.5)
    expect(SessionAbortMetrics.meetsTarget(["user.stop", "user.stop"] as const)).toBe(true)
    expect(SessionAbortMetrics.meetsTarget(Array.from({ length: 11 }, () => "provider.transport" as const))).toBe(
      false,
    )
  })
})

describe("SurfaceSchema", () => {
  test("roundtrips an error-card surface and rejects plugin html kinds", () => {
    const surface = SurfaceSchema.errorCard(
      "fail-1",
      SessionFailureCard.fromFailure(SessionFailure.make("lease.stale")),
    )
    const decoded = Schema.decodeUnknownSync(SurfaceSchema.Surface)(JSON.parse(JSON.stringify(surface)))
    expect(decoded.kind).toBe("error-card")
    expect(decoded.body[0]?.type).toBe("error_card")
    expect(() =>
      Schema.decodeUnknownSync(SurfaceSchema.Surface)({
        id: "x",
        kind: "html",
        body: [{ type: "html", props: { html: "<script>" } }],
      }),
    ).toThrow()
  })
})
