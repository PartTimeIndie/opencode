import { AIChain } from "@opencode-ai/core/ai-chain"
import { SessionResume } from "@opencode-ai/core/session/resume"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { Cause, Effect, Exit } from "effect"

type StepResult = { model: string; text?: string }

// A stalled provider must not eat the caller's whole timeout budget: headless
// callers run real-time features (speech improvement, safety review) where the
// plugin or feature owns a tight overall deadline.
const DEFAULT_STEP_TIMEOUT_MS = 60_000

type ChainContext = {
  abort?: AbortSignal
  metadata?: Record<string, unknown>
  /** Per-step deadline in milliseconds. `0` disables the deadline. */
  stepTimeoutMs?: number
}

/**
 * Executes an ordered model chain. Each eligible failure gets one fresh attempt
 * on the same model before advancing to the next configured step. Only
 * transient provider/quota/empty-completion failures and
 * provider/model unavailability (retired or unknown models, missing
 * providers) advance to the next step; invalid request/input and auth-policy
 * failures fail closed so the configured order is never silently bypassed.
 * Each step also runs under a deadline: a stalled step is aborted through its
 * own signal and advances the chain as a transient timeout failure instead of
 * blocking until the caller's overall timeout expires.
 * `runStep` performs the actual model call so the walk itself stays testable
 * without provider layers.
 */
export function runModelChain<R extends StepResult, E>(
  chain: AIChain.AIChainStep[],
  runStep: (step: AIChain.AIChainStep, signal: AbortSignal) => Effect.Effect<R, E>,
  context: ChainContext = {},
): Effect.Effect<R, E | Error> {
  return Effect.gen(function* () {
    const failures: string[] = []
    for (const step of chain) {
      const key = AIChain.aiChainStepKey(step)
      for (let attempt = 0; attempt < 2; attempt++) {
        if (context.abort?.aborted)
          return yield* Effect.fail(context.abort.reason ?? new DOMException("Cancelled", "AbortError"))
        const { effect: deadlineEffect, timedOut } = runStepWithDeadline(step, runStep, context)
        const exit = yield* deadlineEffect.pipe(Effect.exit)
        if (Exit.isSuccess(exit)) {
          if (typeof exit.value.text !== "string" || exit.value.text.trim()) return exit.value
          if (context.abort?.aborted) return yield* Effect.fail(context.abort.reason ?? new DOMException("Cancelled", "AbortError"))
          if (attempt === 0) continue
          failures.push(`${key}: empty completion`)
          yield* Effect.logWarning("model chain step returned an empty completion", {
            step: key,
            metadata: context.metadata,
          })
          break
        }
        if (Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause)
        const error = Cause.squash(exit.cause) as E
        // The caller's cancel always wins, even when the step deadline fired at
        // the same moment.
        if (context.abort?.aborted) return yield* Effect.fail(error)
        if (timedOut() || isStepDeadline(error)) {
          // Our deadline can surface as an AbortError; unlike user cancellation,
          // this is eligible for one fresh request with a new signal.
          if (attempt === 0) continue
          failures.push(`${key}: step deadline exceeded`)
          yield* Effect.logWarning("model chain step timed out; advancing to the next step", {
            step: key,
            metadata: context.metadata,
            error: errorDetails(error),
          })
          break
        }
        if (AIChain.isAbortError(error)) return yield* Effect.fail(error)
        if (!AIChain.chainStepFailureEligible(error)) {
          // Invalid request/input and auth-policy failures fail closed.
          yield* Effect.logError("model chain step failed permanently; stopping the chain", {
            step: key,
            metadata: context.metadata,
            error: errorDetails(error),
          })
          return yield* Effect.fail(new Error(`Model chain stopped at ${key}: ${failureMessage(error)}`, { cause: error }))
        }
        if (attempt === 0 && AIChain.chainStepRetryEligible(error)) {
          const retryAfter = retryAfterMs(error)
          // Do not send an early retry when a provider asks for a wait longer
          // than the automatic limit. The next configured step may still work.
          if (retryAfter === undefined || SessionResume.canWaitForRetry(retryAfter)) {
            if (retryAfter) yield* waitForRetry(retryAfter, context.abort)
            continue
          }
        }
        failures.push(`${key}: ${failureMessage(error)}`)
        yield* Effect.logWarning("model chain step failed transiently; advancing to the next step", {
          step: key,
          metadata: context.metadata,
          error: errorDetails(error),
        })
        break
      }
    }
    return yield* Effect.fail(
      new Error(`All ${chain.length} models in the chain failed: ${failures.join("; ")}`),
    )
  })
}

/**
 * Runs one step under a deadline. The deadline both aborts the step's request
 * through `signal` and interrupts the waiting fiber, so the chain walk never
 * waits longer than the deadline for a single provider. `timedOut()` reports
 * whether the deadline fired so an abort from the deadline can advance the
 * chain instead of failing it.
 */
function runStepWithDeadline<R extends StepResult, E>(
  step: AIChain.AIChainStep,
  runStep: (step: AIChain.AIChainStep, signal: AbortSignal) => Effect.Effect<R, E>,
  context: ChainContext,
): { effect: Effect.Effect<R, E | Error>; timedOut: () => boolean } {
  const timeoutMs = context.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const controller = new AbortController()
  const signal = context.abort ? AbortSignal.any([context.abort, controller.signal]) : controller.signal
  if (timeoutMs <= 0) return { effect: runStep(step, signal), timedOut: () => false }
  let fired = false
  const timer = setTimeout(() => {
    fired = true
    controller.abort()
  }, timeoutMs)
  return {
    effect: runStep(step, signal).pipe(
      Effect.ensuring(Effect.sync(() => clearTimeout(timer))),
      Effect.timeout(timeoutMs),
    ),
    timedOut: () => fired,
  }
}

function retryAfterMs(error: unknown) {
  for (const candidate of AIChain.errorCandidatesForNormalization(error)) {
    if (!candidate || typeof candidate !== "object") continue
    const value = candidate as { retryAfterMs?: unknown; responseHeaders?: unknown; headers?: unknown }
    if (typeof value.retryAfterMs === "number" && Number.isFinite(value.retryAfterMs))
      return Math.max(0, value.retryAfterMs)
    const headers = value.responseHeaders ?? value.headers
    if (!headers || typeof headers !== "object") continue
    const entries = Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    const delay = RequestExecutor.retryAfterMs(Object.fromEntries(entries))
    if (delay !== undefined) return delay
  }
  return undefined
}

function waitForRetry(delayMs: number, abort?: AbortSignal) {
  return Effect.callback<void, Error>((resume) => {
    const cancelled = () => resume(Effect.fail(abort?.reason ?? new DOMException("Cancelled", "AbortError")))
    const timer = setTimeout(() => resume(Effect.void), delayMs)
    abort?.addEventListener("abort", cancelled, { once: true })
    if (abort?.aborted) cancelled()
    return Effect.sync(() => {
      clearTimeout(timer)
      abort?.removeEventListener("abort", cancelled)
    })
  })
}

function failureMessage(error: unknown) {
  if (isStepDeadline(error)) return "step deadline exceeded"
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function isStepDeadline(error: unknown) {
  return (error as { _tag?: unknown } | null)?._tag === "TimeoutError"
}

export const isAbortError = AIChain.isAbortError
export const chainStepFailureEligible = AIChain.chainStepFailureEligible

function errorDetails(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { message: String(error) }
}

export * as HeadlessAIChain from "./headless-ai-chain"
