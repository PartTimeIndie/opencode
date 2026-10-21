export * as RetryBackoff from "./retry-backoff"

/**
 * Client-side retry discipline for polls that previously retried forever on a
 * fixed interval. The plugin manifest loader spammed a console error every
 * ~15 s for hours when the sidecar was wedged; exponential backoff with a
 * terminal state bounds that behavior while keeping fast recovery after the
 * server comes back.
 */

export type State = {
  readonly attempt: number
  readonly nextDelayMs: number
  readonly terminal: boolean
}

export type Options = {
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly terminalAfterConsecutiveFailures: number
  /** Deterministic jitter source; defaults to Math.random. */
  readonly jitter?: () => number
}

export const defaultOptions: Options = {
  baseDelayMs: 5_000,
  maxDelayMs: 60_000,
  terminalAfterConsecutiveFailures: 10,
  jitter: () => Math.random(),
}

export const fresh = (): State => ({ attempt: 0, nextDelayMs: 0, terminal: false })

/** Reset after any success or a server fingerprint change. */
export const reset = (): State => fresh()

/** A caller that needs eventual recovery can probe at a slow fixed rate after fast retries stop. */
export const probeDelay = (state: State, terminalDelayMs: number) =>
  state.terminal ? terminalDelayMs : state.nextDelayMs

/**
 * Advance the state after one more consecutive failure. Returns the state to
 * schedule the next attempt with; `terminal` marks the state where the caller
 * stops retrying until an external reset.
 */
export const recordFailure = (state: State, options: Options = defaultOptions): State => {
  const attempt = state.attempt + 1
  if (attempt >= options.terminalAfterConsecutiveFailures) {
    return { attempt, nextDelayMs: 0, terminal: true }
  }
  const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1))
  const jittered = Math.round(exponential * (0.85 + 0.3 * (options.jitter?.() ?? 0)))
  return { attempt, nextDelayMs: Math.min(options.maxDelayMs, Math.max(options.baseDelayMs, jittered)), terminal: false }
}
