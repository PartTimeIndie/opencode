export * as SessionFailure from "./failure"

import { Schema } from "effect"
import { optionalOmitUndefined } from "../schema-helpers"

/**
 * Canonical failure codes for session execution. These codes are the durable
 * wire contract for events (E2), retry/resume policies (E3), and the UI error
 * card (E6): classification is chosen by the code that observed the failure,
 * never re-derived from human-readable error text. The UI localizes by `code`;
 * `message` stays the stable canonical English text.
 */
const failureCodes = [
  "provider.transport",
  "provider.rate-limit",
  "provider.auth",
  "provider.context-overflow",
  "provider.content-policy",
  "provider.invalid-request",
  "provider.invalid-response",
  "tool.defect",
  "permission.denied",
  "user.stop",
  "owner.interrupted",
  "owner.shutdown",
  "lease.stale",
  "rollback.requested",
  "internal.defect",
  "resource.exhausted",
] as const

export const Code = Schema.Literals([...failureCodes])
export type Code = typeof Code.Type

/** Codes registered in `defaults`; every code ships with card-ready metadata. */
export const codes: readonly Code[] = failureCodes

/**
 * What the runner may do with a failure without asking the user first.
 * `auto-retry` feeds the bounded retry policy, `resume` restarts from the last
 * durable step checkpoint, `none` settles terminally.
 */
export const Retryability = Schema.Literals(["auto-retry", "resume", "none"])
export type Retryability = typeof Retryability.Type

/** Primary action offered on the error card. */
export const Remediation = Schema.Literals(["retry", "resume", "report", "continue"])
export type Remediation = typeof Remediation.Type

export const Cause = Schema.Struct({
  /** Unmodified provider/tool error text kept for diagnosis; never parsed for classification. */
  raw: Schema.String.pipe(optionalOmitUndefined),
  /** Short structured context, e.g. the failing tool or request phase. */
  detail: Schema.String.pipe(optionalOmitUndefined),
})
export type Cause = typeof Cause.Type

export const Failure = Schema.Struct({
  code: Code,
  message: Schema.String,
  cause: Cause.pipe(optionalOmitUndefined),
  /** Provider or model reference the failure was observed on, e.g. `provider/model`. */
  providerRef: Schema.String.pipe(optionalOmitUndefined),
  /** Epoch milliseconds when a quota window resets, when the provider exposes it. */
  resetAt: Schema.Number.pipe(optionalOmitUndefined),
  /** HTTP status the provider returned, when known. */
  httpStatus: Schema.Number.pipe(optionalOmitUndefined),
  /** Provider Retry-After duration in milliseconds, when an HTTP response exposed it. */
  retryAfterMs: Schema.Number.pipe(optionalOmitUndefined),
  retryability: Retryability,
  remediation: Remediation,
})
export type Failure = typeof Failure.Type

/**
 * Canonical interrupt reason labels, mirrored from `session/activity.ts` so E2
 * can converge both modules onto this single source without changing the
 * durable labels stored in `session_activity.reason`.
 */
export const InterruptReason = Schema.Literals([
  "user-stop",
  "owner-interrupted",
  "owner-shutdown",
  "stale-lease",
  "rollback",
])
export type InterruptReason = typeof InterruptReason.Type

const interruptCode: Record<InterruptReason, Code> = {
  "user-stop": "user.stop",
  "owner-interrupted": "owner.interrupted",
  "owner-shutdown": "owner.shutdown",
  "stale-lease": "lease.stale",
  rollback: "rollback.requested",
}

const defaults: Record<Code, { message: string; retryability: Retryability; remediation: Remediation }> = {
  "provider.transport": {
    message: "The provider stream or request failed before completion.",
    retryability: "auto-retry",
    remediation: "retry",
  },
  "provider.rate-limit": {
    message: "The provider rate limit was reached.",
    retryability: "auto-retry",
    remediation: "retry",
  },
  "provider.auth": {
    message: "Provider authentication failed; credentials or access need attention.",
    retryability: "none",
    remediation: "report",
  },
  "provider.context-overflow": {
    message: "The provider context window was exceeded; compaction must run before continuing.",
    retryability: "resume",
    remediation: "resume",
  },
  "provider.content-policy": {
    message: "The provider rejected the request content.",
    retryability: "none",
    remediation: "continue",
  },
  "provider.invalid-request": {
    message: "The provider rejected the request as invalid.",
    retryability: "none",
    remediation: "continue",
  },
  "provider.invalid-response": {
    message: "The provider returned an empty or invalid response.",
    retryability: "auto-retry",
    remediation: "retry",
  },
  "tool.defect": {
    message: "A tool failed from a defect in its implementation or inputs.",
    retryability: "none",
    remediation: "report",
  },
  "permission.denied": {
    message: "A required permission was declined.",
    retryability: "none",
    remediation: "continue",
  },
  "user.stop": {
    message: "Execution stopped by the user.",
    retryability: "none",
    remediation: "continue",
  },
  "owner.interrupted": {
    message: "Execution interrupted by the owning session or process.",
    retryability: "none",
    remediation: "continue",
  },
  "owner.shutdown": {
    message: "The owning process shut down; work can resume from the last checkpoint.",
    retryability: "resume",
    remediation: "resume",
  },
  "lease.stale": {
    message: "The execution lease expired before completion; work can resume from the last checkpoint.",
    retryability: "resume",
    remediation: "resume",
  },
  "rollback.requested": {
    message: "Execution stopped for an explicit rollback.",
    retryability: "none",
    remediation: "continue",
  },
  "internal.defect": {
    message: "Unexpected internal failure; the original error is preserved for diagnosis.",
    retryability: "none",
    remediation: "report",
  },
  "resource.exhausted": {
    message: "Operating system or process resources were exhausted.",
    retryability: "resume",
    remediation: "resume",
  },
}

/** Build a failure from its code, filling card-ready defaults; explicit values win. */
export const make = (code: Code, overrides: Partial<Omit<Failure, "code">> = {}): Failure => ({
  code,
  message: overrides.message ?? defaults[code].message,
  retryability: overrides.retryability ?? defaults[code].retryability,
  remediation: overrides.remediation ?? defaults[code].remediation,
  ...(overrides.cause !== undefined ? { cause: overrides.cause } : {}),
  ...(overrides.providerRef !== undefined ? { providerRef: overrides.providerRef } : {}),
  ...(overrides.resetAt !== undefined ? { resetAt: overrides.resetAt } : {}),
  ...(overrides.httpStatus !== undefined ? { httpStatus: overrides.httpStatus } : {}),
  ...(overrides.retryAfterMs !== undefined ? { retryAfterMs: overrides.retryAfterMs } : {}),
})

export const fromInterruptReason = (reason: InterruptReason): Failure => make(interruptCode[reason])
