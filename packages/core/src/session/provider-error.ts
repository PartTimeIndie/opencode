export * as ProviderError from "./provider-error"

import { AIChain } from "../ai-chain"
import { SessionFailure } from "./failure"

/**
 * Deterministic provider error normalization (no LLM in the loop).
 *
 * Raw provider bodies arrive in provider-specific shapes; the same "out of
 * tokens" condition reads as zhipuai/GLM code 1308 on HTTP 429 (often with
 * irrecoverably mangled non-ASCII text), OpenAI `usage_limit_reached` with
 * `resets_at`, OpenRouter `metadata.raw` with `provider_name`, or a bare
 * Cursor 429. This module is the ONLY place that turns those payloads into a
 * card-ready `SessionFailure`: a code the UI localizes, a canonical English
 * message, and structured quota facts (provider ref, reset time, HTTP status).
 * `cause.raw` keeps the untouched provider text for diagnosis; nothing
 * downstream ever re-derives classification from that raw text.
 */

export type NormalizedProviderError = SessionFailure.Failure & {
  /** Epoch milliseconds when the quota window resets, when the provider exposes it. */
  resetAt?: number
  /** HTTP status the provider returned, when known. */
  httpStatus?: number
}

type QuotaFacts = {
  providerRef?: string
  resetAt?: number
  resetText?: string
  /** Canonical English quota sentence merged into the classified message. */
  detail?: string
}

const EPOCH_MS_THRESHOLD = 10_000_000_000

function candidatesOf(error: unknown): unknown[] {
  return AIChain.errorCandidatesForNormalization(error)
}

function blobOf(error: unknown): string {
  return candidatesOf(error).map(AIChain.failureMessageForNormalization).join("\n")
}

function jsonObjects(value: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = []
  for (const match of value.matchAll(/\{[^{}]*(?:\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}[^{}]*)*\}/g)) {
    try {
      const parsed: unknown = JSON.parse(match[0])
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        objects.push(parsed as Record<string, unknown>)
    } catch {
      // Not JSON; ignore.
    }
  }
  return objects
}

function deepFind(record: unknown, key: RegExp, depth = 0): unknown {
  if (depth > 6 || !record || typeof record !== "object") return undefined
  for (const [name, value] of Object.entries(record as Record<string, unknown>)) {
    if (key.test(name)) return value
    const nested = deepFind(value, key, depth + 1)
    if (nested !== undefined) return nested
  }
  return undefined
}

function epochOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > EPOCH_MS_THRESHOLD ? value : value * 1000
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) return numeric > EPOCH_MS_THRESHOLD ? numeric : numeric * 1000
    if (!/(?:z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) return undefined
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

function collectPayloads(error: unknown): string[] {
  const payloads: string[] = []
  for (const candidate of candidatesOf(error)) {
    if (candidate instanceof Error) {
      const detail = candidate as Error & { responseBody?: unknown; data?: unknown }
      for (const payload of [detail.responseBody, detail.data]) {
        if (typeof payload === "string") payloads.push(payload)
      }
    }
  }
  return payloads
}

/**
 * Extract quota facts from provider-specific payload shapes. Provider order
 * mirrors real-world traffic: zhipuai/GLM coding plan, OpenAI Codex/Responses,
 * OpenRouter, Anthropic, Cursor, DeepSeek. Mangled provider text is never
 * "repaired" — classification relies on stable codes and HTTP statuses so a
 * lossy `???` body still reads as quota exhaustion.
 */
export function quotaFacts(error: unknown): QuotaFacts {
  const blobs = [blobOf(error), ...collectPayloads(error)]
  const facts: QuotaFacts = {}

  for (const blob of blobs) {
    for (const record of jsonObjects(blob)) {
      if (!facts.providerRef) {
        const providerName = deepFind(record, /^(provider_name|provider)$/)
        if (typeof providerName === "string" && providerName.trim()) facts.providerRef = providerName.trim()
      }
      const resetValue = deepFind(record, /^(resets_at|reset_at)$/)
      if (facts.resetAt === undefined) {
        const reset = epochOf(resetValue)
        if (reset !== undefined) facts.resetAt = reset
      }
      if (facts.resetText === undefined && typeof resetValue === "string" && resetValue.trim())
        facts.resetText = resetValue.trim()
      if (facts.detail === undefined) {
        const code = deepFind(record, /^code$/)
        // zhipuai/GLM coding plan signals period quota exhaustion via body code 1308 on HTTP 429.
        if ((typeof code === "string" || typeof code === "number") && /^1308$/.test(String(code))) {
          facts.detail = "The coding plan quota for this period is used up."
        }
      }
      const inner = record.error
      if (inner && typeof inner === "object") {
        const nested = inner as Record<string, unknown>
        if (
          facts.detail === undefined &&
          (nested.type === "usage_limit_reached" || /usage limit has been reached/i.test(String(nested.message ?? "")))
        ) {
          facts.detail = "The provider usage limit for this plan has been reached."
        }
        if (facts.resetAt === undefined) {
          const innerResetValue = nested.resets_at ?? nested.reset_at
          const innerReset = epochOf(innerResetValue)
          if (innerReset !== undefined) facts.resetAt = innerReset
          if (facts.resetText === undefined && typeof innerResetValue === "string" && innerResetValue.trim())
            facts.resetText = innerResetValue.trim()
        }
      }
      const metadata = deepFind(record, /^metadata$/)
      if (metadata && typeof metadata === "object") {
        const raw = (metadata as Record<string, unknown>).raw
        if (typeof raw === "string" && !facts.providerRef) {
          for (const nested of jsonObjects(raw)) {
            const nestedProvider = deepFind(nested, /^provider_name$/)
            if (typeof nestedProvider === "string" && nestedProvider.trim()) {
              facts.providerRef = nestedProvider.trim()
              break
            }
          }
        }
      }
    }
    if (!facts.providerRef) {
      const openRouter = /"provider_name"\s*:\s*"([^"]+)"/.exec(blob)
      if (openRouter) facts.providerRef = openRouter[1]
    }
    if (facts.detail === undefined && /usage_limit_reached|usage limit has been reached/i.test(blob)) {
      facts.detail = "The provider usage limit for this plan has been reached."
    }
    if (
      facts.detail === undefined &&
      /insufficient[_ ](?:quota|credits)|quota[^\n]{0,40}exhaust|exhausted[^\n]{0,40}quota/i.test(blob)
    ) {
      facts.detail = "The provider quota is exhausted."
    }
    if (facts.resetText === undefined) {
      const reset = /(?:resets? at|will reset at|limit resets at|限额将在)\s*([^\n,;}"。]+)/i.exec(blob)
      if (reset?.[1]) facts.resetText = reset[1].trim().replace(/[.。]+$/, "")
    }
  }

  return facts
}

function formatReset(resetAt: number | undefined): string | undefined {
  if (resetAt === undefined) return undefined
  const date = new Date(resetAt)
  if (Number.isNaN(date.getTime())) return undefined
  return `${date.toISOString()} (UTC)`
}

/**
 * Normalize any provider error into a card-ready failure. Always succeeds:
 * unknown payloads classify through `AIChain.providerFailureCode` and keep a
 * generic sentence so nothing is ever hidden from the user.
 */
export function normalize(error: unknown, providerRef?: string): NormalizedProviderError {
  const code = AIChain.providerFailureCode(error)
  const facts = quotaFacts(error)
  const httpStatus = candidatesOf(error)
    .map(AIChain.statusCodeForNormalization)
    .find((status) => status !== undefined)
  const candidate = error as { retryAfterMs?: unknown }
  const retryAfterMs = typeof candidate?.retryAfterMs === "number" ? candidate.retryAfterMs : undefined
  const resolvedProviderRef = providerRef ?? facts.providerRef
  const providerLabel = resolvedProviderRef ? ` (${resolvedProviderRef})` : ""
  const reset = formatReset(facts.resetAt)
  const resetLabel = reset
    ? ` Resets at ${reset}.`
    : facts.resetText
      ? ` Provider reset text: ${facts.resetText} (timezone unknown; no explicit offset was supplied).`
      : ""
  const statusLabel = httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`
  const resetDetail =
    facts.resetAt === undefined && facts.resetText
      ? `Provider reset text: ${facts.resetText}; timezone unknown because no explicit offset was supplied.`
      : undefined
  const detail = [facts.detail, resetDetail].filter((value): value is string => value !== undefined).join(" ")
  const quota = AIChain.isQuotaExceededFailure(error)

  let message: string
  switch (code) {
    case "provider.rate-limit":
      message = `The provider ${quota ? "quota" : "rate limit"} was reached${statusLabel}${providerLabel}.${detail ? ` ${detail}` : ""}${resetLabel}`
      break
    case "provider.auth":
      message = `Provider authentication failed${statusLabel}${providerLabel}; credentials or access need attention.`
      break
    case "provider.context-overflow":
      message = `The provider context window was exceeded${providerLabel}; compaction must run before continuing.`
      break
    case "provider.content-policy":
      message = `The provider rejected the request content${providerLabel}.`
      break
    case "provider.invalid-request":
      message = `The provider rejected the request as invalid${statusLabel}${providerLabel}.`
      break
    case "provider.transport":
      message = `The provider stream or request failed before completion${statusLabel}${providerLabel}.${resetLabel}`
      break
    default:
      message = `The provider request failed${providerLabel}.`
  }

  const terminal = candidatesOf(error).some(
    (candidate) =>
      candidate && typeof candidate === "object" && "retryable" in candidate && candidate.retryable === false,
  )
  return SessionFailure.make(code, {
    message,
    ...(resolvedProviderRef !== undefined ? { providerRef: resolvedProviderRef } : {}),
    cause: {
      raw: candidatesOf(error).map(AIChain.failureMessageForNormalization).join("\n").slice(0, 4000),
      ...(detail ? { detail } : {}),
    },
    ...(facts.resetAt !== undefined ? { resetAt: facts.resetAt } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(quota || terminal ? { retryability: "none", remediation: "report" } : {}),
  }) as NormalizedProviderError
}
