/**
 * Shared contract for the model-chain snapshot that app plugins send to the
 * host AI run endpoint. The chain definition itself lives exactly once in the
 * app models store; plugins only reference it by ID (or "default") and the
 * renderer sends this bounded snapshot with the request. Both sides validate
 * with the same rules so a corrupted or oversized chain can never silently
 * reorder the user's fallback path.
 */

import { SessionFailure } from "./session/failure"
import { isQuotaExceeded } from "@opencode-ai/llm/provider-quota"

export type AIChainStep = {
  providerID: string
  modelID: string
  variant?: string
}

export const AIChainLimits = {
  maxSteps: 5,
  maxProviderIDLength: 64,
  maxModelIDLength: 128,
  maxVariantLength: 32,
} as const

export type NormalizedAIChain =
  | { steps: AIChainStep[]; error?: undefined }
  | { steps?: undefined; error: string }
  | { steps?: undefined; error?: undefined }

/**
 * `undefined` input means "no chain requested" and keeps the legacy single-model
 * behavior. Every present chain must normalize to at least one valid step or the
 * caller must fail closed with the returned error.
 */
export function normalizeAIChainSteps(value: unknown): NormalizedAIChain {
  if (value === undefined) return {}
  if (!Array.isArray(value)) return { error: "chain steps must be an array" }
  if (value.length === 0) return { error: "chain must contain at least one step" }
  if (value.length > AIChainLimits.maxSteps)
    return { error: `chain must not exceed ${AIChainLimits.maxSteps} steps (got ${value.length})` }

  const steps: AIChainStep[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return { error: "chain steps must be objects with providerID and modelID" }
    const record = item as Record<string, unknown>
    const providerID = identifier(record.providerID, AIChainLimits.maxProviderIDLength, "providerID")
    if (!providerID.ok) return providerID
    const modelID = identifier(record.modelID, AIChainLimits.maxModelIDLength, "modelID")
    if (!modelID.ok) return modelID
    let variant: string | undefined
    if (record.variant !== undefined) {
      const normalized = identifier(record.variant, AIChainLimits.maxVariantLength, "variant")
      if (!normalized.ok) return normalized
      variant = normalized.value
    }
    const key = `${providerID.value}\u0000${modelID.value}`
    if (seen.has(key)) return { error: `chain contains duplicate step ${providerID.value}/${modelID.value}` }
    seen.add(key)
    // Order, model IDs, and variants are preserved exactly as configured.
    steps.push(
      variant === undefined
        ? { providerID: providerID.value, modelID: modelID.value }
        : {
            providerID: providerID.value,
            modelID: modelID.value,
            variant,
          },
    )
  }
  return { steps }
}

function identifier(
  value: unknown,
  maxLength: number,
  label: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: `${label} must be a string` }
  const trimmed = value.trim()
  if (!trimmed) return { ok: false, error: `${label} must not be empty` }
  if (trimmed.length > maxLength) return { ok: false, error: `${label} exceeds ${maxLength} characters` }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false, error: `${label} must not contain control characters` }
  return { ok: true, value: trimmed }
}

export function aiChainStepKey(step: AIChainStep) {
  return step.variant ? `${step.providerID}/${step.modelID} (${step.variant})` : `${step.providerID}/${step.modelID}`
}

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

export function isProviderStreamAbortError(error: unknown) {
  return [...errorCandidates(error)].some((candidate) =>
    /(?:provider|run|response)?\s*stream\s+(?:was\s+)?(?:aborted|abgebrochen)(?:\s+by\s+(?:the\s+)?remote)?/i.test(
      failureMessage(candidate),
    ),
  )
}

const transientChainFailure = new RegExp(
  [
    "resource_exhausted",
    "quota",
    "usage.?limit",
    "rate.?limit",
    "too many requests",
    "overloaded",
    "temporarily",
    "unavailable",
    "timeout",
    "econnreset",
    "econnrefused",
    "etimedout",
    "timed? out",
    "socket hang up",
    "fetch failed",
    "network",
    "bad gateway",
    "gateway timeout",
    "internal server",
    "server_error",
    "service_unavailable",
    "billing",
    "payment required",
    "exhausted",
    "insufficient[_ ](?:quota|credits)",
    "without assistant content",
    "without a finish reason",
    "without a terminal response event",
    "empty response",
    "no output generated",
    "produced no output",
    "stream.?inactivity",
    "stream stalled",
    "stream (?:was )?(?:aborted|abgebrochen)",
    "no events for",
    "websocket",
    "closed before the first event",
    "connection reset",
    "connection closed",
  ].join("|"),
  "i",
)

const invalidChainRequest = new RegExp(
  [
    "unauthorized",
    "invalid[_ ]api[_ ]key",
    "forbidden",
    "authentication",
    "permission denied",
    "invalid_request_error",
    "invalid request",
    "invalid model",
    "unsupported",
  ].join("|"),
  "i",
)

// Provider/model unavailability is availability drift, not a permanent chain failure:
// retired catalog entries (for example openrouter/stealth/ox-alpha), unknown-model
// rejections, and missing providers must advance to the next explicit chain step.
// Proximity is required for the generic existence wording so unrelated 404 text stays permanent.
const unavailableChainStep = new RegExp(
  [
    "model.?not.?found",
    "provider.?not.?found",
    "nosuchmodel",
    "unknown model",
    "no such model",
    "unknown provider",
    "no such provider",
    "no endpoints found",
    "retired",
    "(?:model|provider)[^\\n]{0,64}(?:does not exist|no longer (?:exists|available)|has been (?:deprecated|discontinued|removed))",
    "(?:deprecated|discontinued|removed)[^\\n]{0,64}(?:model|provider)",
  ].join("|"),
  "i",
)

/**
 * Transient availability, quota, empty-completion, and provider/model
 * unavailability failures advance a generic chain; a retired first step must
 * never strand the later configured steps. Invalid request/input and
 * auth-policy failures stay permanent so malformed input never advances.
 * Session-owned chains may additionally opt into bounded provider failover
 * for every non-interruption failure because each step is an independently
 * configured provider boundary. Generic/headless chains remain conservative.
 */
export function chainStepFailureEligible(
  error: unknown,
  options?: { authorization?: boolean; provider?: boolean },
): boolean {
  if (isAbortError(error)) return false
  const candidates = [...errorCandidates(error)]
  const statuses = candidates.map(statusCodeOf).filter((status) => status !== undefined)
  const message = candidates.map(failureMessage).join("\n")
  if (
    options?.authorization &&
    (statuses.some((status) => status === 401 || status === 403) ||
      /authorization|unauthorized|forbidden|authentication|invalid[_ ]api[_ ]key/i.test(message))
  )
    return true
  if (options?.provider) return true
  // Auth-policy failures stay permanent even when the provider text also mentions a model.
  if (statuses.some((status) => status === 401 || status === 403)) return false
  // Some providers wrap catalog drift in invalid_request_error, so recognize
  // concrete provider/model unavailability before the generic request class.
  if (unavailableChainStep.test(message)) return true
  if (invalidChainRequest.test(message)) return false
  if (statuses.some((status) => status >= 400 && status < 500 && status !== 402 && status !== 408 && status !== 429))
    return false
  if (statuses.some((status) => status === 402 || status === 408 || status === 429 || status >= 500)) return true
  if (transientChainFailure.test(message)) return true
  return false
}

export function failureMessageForNormalization(error: unknown) {
  return failureMessage(error)
}

export function errorCandidatesForNormalization(error: unknown): unknown[] {
  return [...errorCandidates(error)]
}

export function statusCodeForNormalization(error: unknown): number | undefined {
  return statusCodeOf(error)
}

export function hasNonRetryableHttpStatus(error: unknown) {
  return [...errorCandidates(error)].some((candidate) => {
    const status = statusCodeOf(candidate)
    return status !== undefined && status >= 400 && status < 500 && status !== 402 && status !== 408 && status !== 429
  })
}

export function isQuotaExceededFailure(error: unknown) {
  const candidates = [...errorCandidates(error)]
  if (
    candidates.some((candidate) => {
      if (!candidate || typeof candidate !== "object") return false
      const detail = candidate as { _tag?: unknown; reason?: { _tag?: unknown } }
      return detail._tag === "QuotaExceeded" || detail.reason?._tag === "QuotaExceeded"
    })
  )
    return true
  // A bare 402 without a quota payload is not period quota: OpenRouter uses 402
  // for payment-required rejections that stay retryable for non-OpenRouter models.
  // Only 402 with an explicit quota signal counts as exhausted quota.
  return isQuotaExceeded(candidates.map(failureMessage).join("\n"))
}

function failureMessage(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (error && typeof error === "object") {
    const detail = error as {
      name?: unknown
      message?: unknown
      code?: unknown
      type?: unknown
      responseBody?: unknown
    }
    return [detail.name, detail.message, detail.code, detail.type, detail.responseBody]
      .filter((value): value is string => typeof value === "string")
      .join(": ")
  }
  return String(error)
}

function* errorCandidates(error: unknown, depth = 0): Generator<unknown> {
  if (error === undefined || error === null || depth > 4) return
  yield error
  if (typeof error !== "object") return
  const nested = error as {
    lastError?: unknown
    reasons?: unknown
    cause?: unknown
    reason?: unknown
    http?: unknown
    response?: unknown
    responseBody?: unknown
    body?: unknown
  }
  if (nested.lastError) yield* errorCandidates(nested.lastError, depth + 1)
  if (Array.isArray(nested.reasons)) for (const reason of nested.reasons) yield* errorCandidates(reason, depth + 1)
  if (nested.cause) yield* errorCandidates(nested.cause, depth + 1)
  if (nested.reason) yield* errorCandidates(nested.reason, depth + 1)
  if (nested.http) yield* errorCandidates(nested.http, depth + 1)
  if (nested.response) yield* errorCandidates(nested.response, depth + 1)
  if (nested.responseBody) yield* errorCandidates(nested.responseBody, depth + 1)
  if (nested.body) yield* errorCandidates(nested.body, depth + 1)
}

function statusCodeOf(error: unknown) {
  if (error && typeof error === "object") {
    const detail = error as { statusCode?: unknown; status?: unknown }
    if (typeof detail.statusCode === "number") return detail.statusCode
    if (typeof detail.status === "number") return detail.status
  }
  const match = /\bHTTP\s+([1-5]\d\d)\b/i.exec(failureMessage(error))
  if (match) return Number(match[1])
  return undefined
}

/**
 * Provider boundary mapper (E2): the ONLY place where raw provider error text
 * is translated into a typed `SessionFailure` code. Everything downstream
 * reads the code; `cause.raw` keeps the original text for diagnosis.
 * Unclassified errors land on `internal.defect` instead of being guessed from
 * UI-facing strings. Session interrupts never pass through here; they classify
 * via `SessionFailure.fromInterruptReason`.
 */
export function providerFailureCode(error: unknown): SessionFailure.Code {
  const candidates = [...errorCandidates(error)]
  const statuses = candidates.map(statusCodeOf).filter((status) => status !== undefined)
  const message = candidates.map(failureMessage).join("\n")
  if (
    statuses.some((status) => status === 401 || status === 403) ||
    /unauthorized|forbidden|authentication|invalid[_ ]api[_ ]key/i.test(message)
  )
    return "provider.auth"
  // TPM text is not context overflow, even when a permanent HTTP rejection
  // happens to mention tokens. The HTTP decision still wins over retry hints.
  if (hasNonRetryableHttpStatus(error) && /tokens per minute|\btpm\b|rate.?limit|too many requests/i.test(message))
    return "provider.invalid-request"
  if (
    statuses.some((status) => status === 402 || status === 429) ||
    /rate.?limit|tokens per minute|\btpm\b|too many requests|quota|usage.?limit|resource_exhausted|insufficient[_ ](?:quota|credits)|billing|payment required/i.test(
      message,
    )
  )
    return "provider.rate-limit"
  if (
    /context[_ ]length[_ ]exceeded|maximum[_ ]context|context[_ ]window|prompt[^.\n]{0,64}too long|too many (?:input )?tokens|input[^.\n]{0,64}exceeds/i.test(
      message,
    )
  )
    return "provider.context-overflow"
  if (/content[_ ](?:policy|filter|management)|safety system|moderation|flagged as sensitive/i.test(message))
    return "provider.content-policy"
  if (hasNonRetryableHttpStatus(error)) return "provider.invalid-request"
  if (
    candidates.some(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        "_tag" in candidate &&
        (candidate._tag === "InvalidProviderOutput" ||
          (candidate._tag === "Transport" && "kind" in candidate && candidate.kind === "invalid-response")),
    )
  )
    return "provider.invalid-response"
  // Transport failures already carry a typed retry decision. Undici's "terminated"
  // stream error has no reliable transport keyword in its message.
  if (
    candidates.some(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        "_tag" in candidate &&
        candidate._tag === "Transport" &&
        "canRetry" in candidate &&
        candidate.canRetry === true,
    )
  )
    return "provider.transport"
  if (
    isProviderStreamAbortError(error) ||
    /stream.?inactivity|stream stalled|no events for|without assistant content|without a finish reason|without a terminal response event|empty response|empty completion|no output generated|produced no output|websocket|closed before the first event|connection (?:reset|closed)/i.test(
      message,
    )
  )
    return "provider.transport"
  if (statuses.some((status) => status === 408 || status >= 500)) return "provider.transport"
  if (transientChainFailure.test(message)) return "provider.transport"
  if (invalidChainRequest.test(message)) return "provider.invalid-request"
  return "internal.defect"
}

/** Typed failure with the raw provider text preserved for diagnosis. */
export function providerFailure(error: unknown, providerRef?: string): SessionFailure.Failure {
  const code = providerFailureCode(error)
  const status = [...errorCandidates(error)].map(statusCodeOf).find((value) => value !== undefined)
  return SessionFailure.make(code, {
    ...(providerRef !== undefined ? { providerRef } : {}),
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(isQuotaExceededFailure(error) ? { retryability: "none", remediation: "report" } : {}),
    cause: { raw: [...errorCandidates(error)].map(failureMessage).join("\n").slice(0, 4000) },
  })
}

export * as AIChain from "./ai-chain"
