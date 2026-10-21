export * as SessionSupervision from "./supervision"

import { SessionFailure } from "./failure"
import { SessionResume } from "./resume"

/**
 * Crash-only supervision helpers for background/subagent jobs (E4).
 * Lease ownership is the only permission to mutate a running job; a stale
 * lease is settled to a typed terminal instead of remaining `running`.
 */
export const HEARTBEAT_MS = 5_000
export const LEASE_MS = 15_000
export const MAX_RECOVERY_ATTEMPTS = SessionResume.DEFAULT_AUTO_RESUME_ATTEMPTS
/**
 * Keep the follow-up just beyond the lease boundary. This is deliberately a
 * fixed guard rather than a random delay so restart recovery remains
 * deterministic while still avoiding a scan at the exact expiry instant.
 */
export const RECOVERY_SCAN_GUARD_MS = 250

export type RecoverDecision =
  | { readonly action: "heartbeat"; readonly leaseUntil: number }
  | { readonly action: "recover"; readonly attempt: number; readonly remaining: number }
  | { readonly action: "terminal"; readonly failure: SessionFailure.Failure }

export function ownsLease(input: { readonly leaseUntil?: number | null; readonly now: number }): boolean {
  return input.leaseUntil !== undefined && input.leaseUntil !== null && input.leaseUntil > input.now
}

export function nextLease(now: number, durationMs = LEASE_MS): number {
  return now + durationMs
}

export function recoveryScanDelayMs(input: {
  readonly now: number
  readonly leaseUntil: number
  readonly guardMs?: number
}): number {
  return Math.max(0, input.leaseUntil - input.now) + (input.guardMs ?? RECOVERY_SCAN_GUARD_MS)
}

/** Human-readable job.error text for a stale-lease settlement (DB column, not an event). */
export function staleJobError(): string {
  return SessionFailure.make("lease.stale").message
}

export function recover(input: {
  readonly now: number
  readonly leaseUntil?: number | null
  readonly recoveryAttempts?: number
}): RecoverDecision {
  if (ownsLease(input)) {
    return { action: "heartbeat", leaseUntil: nextLease(input.now) }
  }
  const attempt = input.recoveryAttempts ?? 0
  const decided = SessionResume.decide({
    failure: SessionFailure.make("lease.stale"),
    attempt,
    hasCheckpoint: true,
  })
  if (decided.action === "resume") {
    return { action: "recover", attempt: decided.attempt, remaining: decided.remaining }
  }
  return {
    action: "terminal",
    failure: decided.action === "terminal" ? decided.failure : SessionFailure.make("lease.stale"),
  }
}
