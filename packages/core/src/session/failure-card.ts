export * as SessionFailureCard from "./failure-card"

import type { SessionFailure } from "./failure"

/**
 * Error-card payload for App/TUI (E6). Clients render this without parsing
 * provider strings. Localization keys off `code`.
 */
export type RetryState = {
  readonly attempt: number
  readonly maxAttempts: number
  readonly nextRetryAt?: number
}

export type Card = {
  readonly code: SessionFailure.Code
  readonly message: string
  readonly cause?: SessionFailure.Cause
  readonly providerRef?: string
  readonly retryability: SessionFailure.Retryability
  readonly remediation: SessionFailure.Remediation
  readonly retryState?: RetryState
}

export function fromFailure(failure: SessionFailure.Failure, retryState?: RetryState): Card {
  return {
    code: failure.code,
    message: failure.message,
    retryability: failure.retryability,
    remediation: failure.remediation,
    ...(failure.cause !== undefined ? { cause: failure.cause } : {}),
    ...(failure.providerRef !== undefined ? { providerRef: failure.providerRef } : {}),
    ...(retryState !== undefined ? { retryState } : {}),
  }
}
