import { describe, expect, test } from "bun:test"
import { anonymizeModelRef, sttAttemptDiagnostic, sttJobDiagnostic } from "@/stt/diagnostics"

describe("stt diagnostics", () => {
  test("splits and sanitizes provider and model identifiers", () => {
    expect(anonymizeModelRef("openrouter/qwen/qwen3-asr-flash")).toEqual({
      providerID: "openrouter",
      modelID: "qwen/qwen3-asr-flash",
    })
    expect(anonymizeModelRef("openai")).toEqual({ providerID: "openai", modelID: "unknown" })
    expect(anonymizeModelRef("")).toEqual({ providerID: "unknown", modelID: "unknown" })
    expect(anonymizeModelRef("provider/")).toEqual({ providerID: "provider", modelID: "unknown" })
  })

  test("strips control characters and truncates oversized identifiers", () => {
    expect(anonymizeModelRef("pro\nvider/mod\tel")).toEqual({ providerID: "provider", modelID: "model" })
    const longProvider = `${"p".repeat(120)}/model`
    const anonymized = anonymizeModelRef(longProvider)
    expect(anonymized.providerID).toBe("p".repeat(96))
    expect(anonymized.modelID).toBe("model")
  })

  test("attempt diagnostics expose exactly the whitelisted structural fields", () => {
    const diagnostic = sttAttemptDiagnostic({
      correlationID: "00000000-0000-4000-8000-000000000001",
      attempt: 2,
      attempts: 3,
      providerID: "openrouter",
      modelID: "qwen/qwen3-asr-0.6b",
      startedAt: "2026-09-08T14:45:00.000Z",
      timeoutMs: 55_000,
      durationMs: 1_234,
      outcome: "fallback",
      errorCode: "timeout",
    })
    expect(Object.keys(diagnostic).sort()).toEqual([
      "attempt",
      "attempts",
      "correlationID",
      "durationMs",
      "errorCode",
      "event",
      "modelID",
      "outcome",
      "providerID",
      "startedAt",
      "timeoutMs",
    ])
    expect(diagnostic.event).toBe("stt_attempt")
    expect(diagnostic.outcome).toBe("fallback")
    expect(diagnostic.errorCode).toBe("timeout")
  })

  test("missing budgets and error classes are recorded as null, not free text", () => {
    const diagnostic = sttAttemptDiagnostic({
      correlationID: "00000000-0000-4000-8000-000000000002",
      attempt: 1,
      attempts: 1,
      providerID: "openrouter",
      modelID: "qwen/qwen3-asr-flash",
      startedAt: "2026-09-08T14:45:00.000Z",
      timeoutMs: undefined,
      durationMs: 42,
      outcome: "succeeded",
      errorCode: undefined,
    })
    expect(diagnostic.timeoutMs).toBeNull()
    expect(diagnostic.errorCode).toBeNull()
  })

  test("job diagnostics carry the correlation ID and the served model reference", () => {
    const job = sttJobDiagnostic({
      correlationID: "00000000-0000-4000-8000-000000000003",
      attempts: 2,
      startedAt: "2026-09-08T14:45:00.000Z",
      durationMs: 9_000,
      outcome: "succeeded",
      providerID: "openrouter",
      modelID: "qwen/qwen3-asr-1.7b",
      errorCode: undefined,
    })
    expect(Object.keys(job).sort()).toEqual([
      "attempts",
      "correlationID",
      "durationMs",
      "errorCode",
      "event",
      "modelID",
      "outcome",
      "providerID",
      "startedAt",
    ])
    expect(job.event).toBe("stt_job")
    expect(job.modelID).toBe("qwen/qwen3-asr-1.7b")
    expect(job.errorCode).toBeNull()
  })

  test("failed jobs keep the terminal error class without a served model", () => {
    const job = sttJobDiagnostic({
      correlationID: "00000000-0000-4000-8000-000000000004",
      attempts: 1,
      startedAt: "2026-09-08T14:45:00.000Z",
      durationMs: 500,
      outcome: "aborted",
      providerID: undefined,
      modelID: undefined,
      errorCode: "cancelled",
    })
    expect(job.outcome).toBe("aborted")
    expect(job.providerID).toBeNull()
    expect(job.modelID).toBeNull()
    expect(job.errorCode).toBe("cancelled")
  })

  test("diagnostics cannot carry request audio, transcripts, or credentials", () => {
    const audio = Buffer.from([1, 2, 3]).toString("base64")
    const transcript = "geheime gesprochene nachricht"
    const credential = "sk-server-secret-0123456789"
    const attempt = sttAttemptDiagnostic({
      correlationID: "00000000-0000-4000-8000-000000000005",
      attempt: 1,
      attempts: 1,
      providerID: "openrouter",
      modelID: "qwen/qwen3-asr-flash",
      startedAt: "2026-09-08T14:45:00.000Z",
      timeoutMs: 110_000,
      durationMs: 10,
      outcome: "succeeded",
      errorCode: undefined,
    })
    const job = sttJobDiagnostic({
      correlationID: "00000000-0000-4000-8000-000000000005",
      attempts: 1,
      startedAt: "2026-09-08T14:45:00.000Z",
      durationMs: 12,
      outcome: "succeeded",
      providerID: "openrouter",
      modelID: "qwen/qwen3-asr-flash",
      errorCode: undefined,
    })
    const serialized = JSON.stringify([attempt, job])
    expect(serialized).not.toContain(audio)
    expect(serialized).not.toContain(transcript)
    expect(serialized).not.toContain(credential)
  })
})
