export * as SessionResume from "./resume"

import { SessionFailure } from "./failure"

/**
 * Declarative retry/resume policy per typed failure code (E3).
 * The runner consults this table instead of parsing error strings: auto-retry
 * is bounded and counted, resume requires a durable checkpoint, and user-stop
 * never retries.
 */
export type Action = "auto-retry" | "resume" | "terminal"

export type Policy = {
  readonly action: Action
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
}

export const DEFAULT_AUTO_RETRY_ATTEMPTS = 5
export const DEFAULT_BASE_DELAY_MS = 2_000
export const DEFAULT_MAX_DELAY_MS = 30_000
// Longer provider deadlines settle as deferred, never as an earlier retry.
export const MAX_AUTO_RETRY_WAIT_MS = 300_000
export const DEFAULT_AUTO_RESUME_ATTEMPTS = 3
// A short-term account throttle (for example Z.AI code 1302 on HTTP 429) outlives
// the transport budget when parallel sessions share one account: five attempts
// with a 30 s cap give up after roughly a minute. Plan quota never reaches this
// schedule because it settles as retryability "none" on the same model.
export const THROTTLE_RETRY_ATTEMPTS = 8
export const THROTTLE_MAX_DELAY_MS = 60_000

/**
 * Implementation-task chain passes. A native task child advances its model chain on
 * every eligible provider failure and may run that chain at most this many times per
 * activity before it fails visibly. Ordinary sessions never use this state.
 */
export const MAX_CHAIN_PASSES = 2
// Only the visible failure record is capped; the lane itself is bounded by passes × steps.
export const MAX_RECORDED_CHAIN_ATTEMPTS = 16

export type ChainPass = {
  /** Identity of the chain this pass belongs to (id and ordered steps); a changed binding starts over. */
  readonly chain: string
  /** 1-based pass over the chain. */
  readonly pass: number
  /** A clean retryable provider failure was observed in the current pass. */
  readonly retryable: boolean
  /** A full repeat would revisit a model whose quota is exhausted. */
  readonly quotaBlocked?: true
  /** Latest wait the retryable failures of this pass asked for before the chain may run again. */
  readonly delayMs: number
  /** Failed attempts in order, each `provider/model:code`. */
  readonly attempts: ReadonlyArray<string>
}

/** One shared allowance per activity; successful tool turns do not reset it. */
export function recoveryBudget() {
  let attempt = 0
  let chainPass: ChainPass | undefined
  const current = (chain: string) => (chainPass?.chain === chain ? chainPass : undefined)
  return {
    next: (code?: SessionFailure.Code) =>
      attempt < (code === undefined ? DEFAULT_AUTO_RETRY_ATTEMPTS : retryBudget(code)) ? ++attempt : undefined,
    chainPass: () => chainPass,
    // Records one failed chain step of the task lane. A different chain (the user
    // switched the selection) starts a fresh first pass instead of inheriting the old one.
    observeChainFailure: (
      chain: string,
      failure: { readonly retryable: boolean; readonly delayMs: number; readonly attempt: string },
    ): ChainPass => {
      const previous = current(chain)
      chainPass = {
        chain,
        pass: previous?.pass ?? 1,
        retryable: (previous?.retryable ?? false) || failure.retryable,
        ...(previous?.quotaBlocked || !failure.retryable ? { quotaBlocked: true as const } : {}),
        delayMs: failure.retryable ? Math.max(previous?.delayMs ?? 0, failure.delayMs) : (previous?.delayMs ?? 0),
        attempts: [...(previous?.attempts ?? []), failure.attempt].slice(-MAX_RECORDED_CHAIN_ATTEMPTS),
      }
      return chainPass
    },
    // The one additional full pass: same chain, counted from its first step again.
    restartChainPass: (chain: string): ChainPass => {
      const previous = current(chain)
      chainPass = {
        chain,
        pass: (previous?.pass ?? 1) + 1,
        retryable: false,
        delayMs: 0,
        attempts: previous?.attempts ?? [],
      }
      return chainPass
    },
  }
}

const autoRetry = (maxAttempts = DEFAULT_AUTO_RETRY_ATTEMPTS, maxDelayMs = DEFAULT_MAX_DELAY_MS): Policy => ({
  action: "auto-retry",
  maxAttempts,
  baseDelayMs: DEFAULT_BASE_DELAY_MS,
  maxDelayMs,
})

const autoResume = (maxAttempts = DEFAULT_AUTO_RESUME_ATTEMPTS): Policy => ({
  action: "resume",
  maxAttempts,
  baseDelayMs: DEFAULT_BASE_DELAY_MS,
  maxDelayMs: DEFAULT_MAX_DELAY_MS,
})

const terminal: Policy = {
  action: "terminal",
  maxAttempts: 0,
  baseDelayMs: 0,
  maxDelayMs: 0,
}

const policies: Record<SessionFailure.Code, Policy> = {
  "provider.transport": autoRetry(),
  "provider.rate-limit": autoRetry(THROTTLE_RETRY_ATTEMPTS, THROTTLE_MAX_DELAY_MS),
  "provider.auth": terminal,
  "provider.context-overflow": autoResume(1),
  "provider.content-policy": terminal,
  "provider.invalid-request": terminal,
  "provider.invalid-response": autoRetry(),
  "tool.defect": terminal,
  "permission.denied": terminal,
  "user.stop": terminal,
  "owner.interrupted": terminal,
  "owner.shutdown": autoResume(),
  "lease.stale": autoResume(),
  "rollback.requested": terminal,
  "internal.defect": terminal,
  "resource.exhausted": autoResume(),
}

export function policy(code: SessionFailure.Code): Policy {
  return policies[code]
}

/**
 * Retry budget the runner uses after it has already decided a failure is retryable.
 * Typed auto-retry/resume codes keep their policy; unclassified `internal.defect`
 * keeps the historic five-attempt budget so mapper gaps cannot starve retries.
 */
export function retryBudget(code: SessionFailure.Code): number {
  const next = policies[code]
  if (next.maxAttempts > 0) return next.maxAttempts
  if (code === "internal.defect") return DEFAULT_AUTO_RETRY_ATTEMPTS
  return 0
}

/** Exponential backoff capped by the code's max delay; honors Retry-After when present. */
export function delayMs(code: SessionFailure.Code, attempt: number, retryAfterMs?: number): number {
  const next = policies[code]
  const maxDelay = next.maxDelayMs > 0 ? next.maxDelayMs : DEFAULT_MAX_DELAY_MS
  const base = next.baseDelayMs > 0 ? next.baseDelayMs : DEFAULT_BASE_DELAY_MS
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return retryAfterMs
  }
  return Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), maxDelay)
}

export function canWaitForRetry(delay: number) {
  return Number.isFinite(delay) && delay >= 0 && delay <= MAX_AUTO_RETRY_WAIT_MS
}

export type Decision =
  | { readonly action: "auto-retry"; readonly attempt: number; readonly delayMs: number; readonly remaining: number }
  | { readonly action: "resume"; readonly attempt: number; readonly remaining: number }
  | { readonly action: "terminal"; readonly failure: SessionFailure.Failure }

/**
 * Decide the next runner action for a typed failure.
 * `attempt` is 0-based completed tries so far; the first retry is attempt 0 → remaining maxAttempts.
 * Missing/inconsistent checkpoints refuse resume and settle as `internal.defect`.
 */
export function decide(input: {
  readonly failure: SessionFailure.Failure
  readonly attempt: number
  readonly retryAfterMs?: number
  readonly hasCheckpoint?: boolean
}): Decision {
  const next = policies[input.failure.code]
  if (input.failure.retryability === "none" || next.action === "terminal" || next.maxAttempts <= 0) {
    return { action: "terminal", failure: input.failure }
  }
  if (input.attempt >= next.maxAttempts) {
    return { action: "terminal", failure: input.failure }
  }
  if (next.action === "resume") {
    if (input.hasCheckpoint === false) {
      return {
        action: "terminal",
        failure: SessionFailure.make("internal.defect", {
          cause: {
            raw: input.failure.cause?.raw,
            detail: "Resume refused: no durable step checkpoint",
          },
        }),
      }
    }
    return {
      action: "resume",
      attempt: input.attempt + 1,
      remaining: next.maxAttempts - input.attempt - 1,
    }
  }
  const delay = delayMs(input.failure.code, input.attempt + 1, input.retryAfterMs)
  if (!canWaitForRetry(delay)) return { action: "terminal", failure: input.failure }
  return {
    action: "auto-retry",
    attempt: input.attempt + 1,
    delayMs: delay,
    remaining: next.maxAttempts - input.attempt - 1,
  }
}
