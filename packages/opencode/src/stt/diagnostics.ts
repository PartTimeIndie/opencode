const maxIDLength = 96

export type STTAttemptOutcome = "succeeded" | "fallback" | "failed" | "aborted"

export type STTAttemptDiagnostic = {
  event: "stt_attempt"
  correlationID: string
  attempt: number
  attempts: number
  providerID: string
  modelID: string
  startedAt: string
  timeoutMs: number | null
  durationMs: number
  outcome: STTAttemptOutcome
  errorCode: string | null
}

export type STTJobDiagnostic = {
  event: "stt_job"
  correlationID: string
  attempts: number
  startedAt: string
  durationMs: number
  outcome: "succeeded" | "failed" | "aborted"
  providerID: string | null
  modelID: string | null
  errorCode: string | null
}

// Diagnostics are privacy-frozen by construction: these builders accept only
// structural identifiers and timing values, so request audio, transcripts,
// headers, credentials, and provider payloads have no field to leak into.
export function anonymizeModelRef(attempt: string): { providerID: string; modelID: string } {
  const separator = attempt.indexOf("/")
  if (separator <= 0) return { providerID: sanitizeID(attempt), modelID: "unknown" }
  return { providerID: sanitizeID(attempt.slice(0, separator)), modelID: sanitizeID(attempt.slice(separator + 1)) }
}

function sanitizeID(value: string) {
  const cleaned = value
    .replaceAll(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxIDLength)
  return cleaned || "unknown"
}

export function sttAttemptDiagnostic(input: {
  correlationID: string
  attempt: number
  attempts: number
  providerID: string
  modelID: string
  startedAt: string
  timeoutMs: number | undefined
  durationMs: number
  outcome: STTAttemptOutcome
  errorCode: string | undefined
}): STTAttemptDiagnostic {
  return {
    event: "stt_attempt",
    correlationID: input.correlationID,
    attempt: input.attempt,
    attempts: input.attempts,
    providerID: input.providerID,
    modelID: input.modelID,
    startedAt: input.startedAt,
    timeoutMs: input.timeoutMs ?? null,
    durationMs: input.durationMs,
    outcome: input.outcome,
    errorCode: input.errorCode ?? null,
  }
}

export function sttJobDiagnostic(input: {
  correlationID: string
  attempts: number
  startedAt: string
  durationMs: number
  outcome: STTJobDiagnostic["outcome"]
  providerID: string | undefined
  modelID: string | undefined
  errorCode: string | undefined
}): STTJobDiagnostic {
  return {
    event: "stt_job",
    correlationID: input.correlationID,
    attempts: input.attempts,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    outcome: input.outcome,
    providerID: input.providerID ?? null,
    modelID: input.modelID ?? null,
    errorCode: input.errorCode ?? null,
  }
}
