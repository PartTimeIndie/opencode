export * as SessionProviderStream from "./provider-stream"

import { LLMError, LLMEvent, TransportReason } from "@opencode-ai/llm"
import { Cause, Effect, Exit, Scope, Stream } from "effect"
import { AIChain } from "../ai-chain"

const PROVIDER_STREAM_IDLE_TIMEOUT_MS = 60_000
const EXTENDED_PROGRESS_IDLE_TIMEOUT_MS = 240_000

export function providerStreamIdleTimeoutMs(
  configured: string | undefined = process.env.OPENCODE_PROVIDER_STREAM_IDLE_TIMEOUT_MS,
) {
  if (configured === undefined || configured.trim().length === 0) return PROVIDER_STREAM_IDLE_TIMEOUT_MS
  const value = Number(configured)
  if (!Number.isFinite(value)) return PROVIDER_STREAM_IDLE_TIMEOUT_MS
  return value <= 0 ? false : value
}

export function providerStreamIdleTimeouts(
  model: { provider: string; id: string },
  configured: string | undefined = process.env.OPENCODE_PROVIDER_STREAM_IDLE_TIMEOUT_MS,
) {
  const idleTimeoutMs = providerStreamIdleTimeoutMs(configured)
  if (idleTimeoutMs === false) return { initialMs: false, afterProgressMs: false } as const
  const hasExplicitOverride = configured !== undefined && configured.trim().length > 0 && Number.isFinite(Number(configured))
  return {
    initialMs: idleTimeoutMs,
    afterProgressMs:
      !hasExplicitOverride &&
      (model.id.toLowerCase().startsWith("glm-") ||
        (model.provider === "openai" && /^gpt-6(?:[.-]|$)/i.test(model.id)))
        ? EXTENDED_PROGRESS_IDLE_TIMEOUT_MS
        : idleTimeoutMs,
  }
}

export function withProviderStreamIdleTimeout(
  stream: Stream.Stream<LLMEvent, LLMError>,
  initialIdleTimeoutMs: number | false = providerStreamIdleTimeoutMs(),
  afterProgressIdleTimeoutMs: number | false = initialIdleTimeoutMs,
) {
  return Stream.transformPull(Stream.empty, (_, consumerScope) =>
    Effect.gen(function* () {
      const sourceScope = yield* Scope.make()
      yield* Scope.addFinalizerExit(consumerScope, (exit) =>
        Scope.close(sourceScope, exit).pipe(
          Effect.catchCause((cause) => {
            // A failed pull or user interruption remains primary when disposing
            // the provider aborts its transport. Successful EOF keeps cleanup errors.
            if (!Exit.isFailure(exit) || cause.reasons.length === 0) return Effect.failCause(cause)
            return cause.reasons.every((reason) => {
              if (reason._tag === "Interrupt") return false
              const failure = reason._tag === "Die" ? reason.defect : reason.error
              return AIChain.isAbortError(failure) || AIChain.isProviderStreamAbortError(failure)
            })
              ? Effect.void
              : Effect.failCause(cause)
          }),
          // Scope release is uninterruptible. Observe any user cancellation that
          // arrived while it was closing, after all provider resources are released.
          Effect.onExit(() => Effect.interruptible(Effect.void)),
        ),
      )
      const pull = yield* Scope.provide(Stream.toPull(stream), sourceScope)
      if (initialIdleTimeoutMs === false || afterProgressIdleTimeoutMs === false) return pull
      // Only awaiting the provider consumes the idle budget. Publication and
      // local tool/permission work between pulls are consumer backpressure,
      // not provider inactivity. Semantic progress switches to its own finite
      // per-pull budget; start events, provider errors and transport keepalives do not.
      let phaseIdleTimeoutMs = initialIdleTimeoutMs
      let remaining = initialIdleTimeoutMs
      return Effect.suspend(() => {
        if (remaining <= 0) return Effect.fail(stalledProviderStreamFailure(phaseIdleTimeoutMs))
        const started = Date.now()
        return pull.pipe(
          Effect.tap((events) =>
            Effect.sync(() => {
              if (events.some(providerStreamEventHasProgress)) {
                phaseIdleTimeoutMs = afterProgressIdleTimeoutMs
                remaining = afterProgressIdleTimeoutMs
                return
              }
              remaining -= Date.now() - started
            }),
          ),
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
            const failure = Cause.squash(cause)
            if (AIChain.isAbortError(failure)) return Effect.failCause(cause)
            return AIChain.isProviderStreamAbortError(failure)
              ? Effect.fail(providerStreamAbortFailure(failure))
              : Effect.failCause(cause)
          }),
          Effect.timeoutOrElse({
            duration: remaining,
            orElse: () => Effect.fail(stalledProviderStreamFailure(phaseIdleTimeoutMs)),
          }),
        )
      })
    }),
  )
}

function providerStreamEventHasProgress(event: LLMEvent) {
  if (event.type === "text-delta" || event.type === "reasoning-delta" || event.type === "tool-input-delta")
    return event.text.length > 0
  return (
    event.type === "tool-call" ||
    event.type === "tool-result" ||
    event.type === "tool-error" ||
    event.type === "step-finish" ||
    event.type === "finish"
  )
}

export function withProviderStreamAbortNormalization<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | LLMError, R> {
  return effect.pipe(
    Effect.catchCause((cause): Effect.Effect<never, E | LLMError> => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
      const failure = Cause.squash(cause)
      if (AIChain.isAbortError(failure)) return Effect.fail(providerStreamAbortFailure(failure))
      return AIChain.isProviderStreamAbortError(failure)
        ? Effect.fail(providerStreamAbortFailure(failure))
        : Effect.failCause(cause)
    }),
  )
}

function stalledProviderStreamFailure(idleTimeoutMs: number) {
  return new LLMError({
    module: "SessionRunner",
    method: "runProviderStream",
    reason: new TransportReason({
      message: `Provider stream stalled: no meaningful events for ${Math.round(idleTimeoutMs / 1000)} seconds`,
      kind: "stream-inactivity",
      canRetry: true,
    }),
  })
}

function providerStreamAbortFailure(error: unknown) {
  return new LLMError({
    module: "SessionRunner",
    method: "runProviderStream",
    reason: new TransportReason({
      message: error instanceof Error ? error.message : String(error),
      kind: "stream-aborted",
      canRetry: true,
    }),
  })
}

export function isProviderStreamInactivity(error: LLMError) {
  return error.reason._tag === "Transport" && error.reason.kind === "stream-inactivity"
}
