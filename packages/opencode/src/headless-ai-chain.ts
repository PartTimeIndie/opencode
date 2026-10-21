import { AIChain } from "@opencode-ai/core/ai-chain"
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
 * Executes an ordered model chain. Each step runs exactly once in order and
 * only eligible transient provider/quota/empty-completion failures and
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
      const { effect: deadlineEffect, timedOut } = runStepWithDeadline(step, runStep, context)
      const exit = yield* deadlineEffect.pipe(Effect.exit)
      if (Exit.isSuccess(exit)) {
        if (typeof exit.value.text !== "string" || exit.value.text.trim()) return exit.value
        // A successful stream without text is not a success: advance to the
        // next step instead of handing an empty completion to the caller.
        failures.push(`${key}: empty completion`)
        yield* Effect.logWarning("model chain step returned an empty completion", {
          step: key,
          metadata: context.metadata,
        })
        continue
      }
      const error = Cause.squash(exit.cause) as E
      // The caller's cancel always wins, even when the step deadline fired at
      // the same moment.
      if (context.abort?.aborted) return yield* Effect.fail(error)
      if (timedOut()) {
        // Our own deadline, not a user cancel: the aborted request surfaces as
        // a TimeoutError or AbortError but must still advance as transient.
        failures.push(`${key}: step deadline exceeded`)
        yield* Effect.logWarning("model chain step timed out; advancing to the next step", {
          step: key,
          metadata: context.metadata,
          error: errorDetails(error),
        })
        continue
      }
      if (AIChain.isAbortError(error)) return yield* Effect.fail(error)
      if (!AIChain.chainStepFailureEligible(error)) {
        // Invalid request/input and auth-policy failures fail closed. Advancing
        // would silently replace the user's chosen fallback path.
        yield* Effect.logError("model chain step failed permanently; stopping the chain", {
          step: key,
          metadata: context.metadata,
          error: errorDetails(error),
        })
        return yield* Effect.fail(
          new Error(`Model chain stopped at ${key}: ${failureMessage(error)}`),
        )
      }
      failures.push(`${key}: ${failureMessage(error)}`)
      yield* Effect.logWarning("model chain step failed transiently; advancing to the next step", {
        step: key,
        metadata: context.metadata,
        error: errorDetails(error),
      })
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
