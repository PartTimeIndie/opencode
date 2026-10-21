import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { LLM, LLMError } from "../src"
import { Auth, LLMClient } from "../src/route"
import * as OpenAIResponses from "../src/protocols/openai-responses"
import { it } from "./lib/effect"
import { dynamicResponse, fixedResponse, truncatedStream } from "./lib/http"
import { sseEvents } from "./lib/sse"

const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-5.6-sol" })

describe("HTTP transport", () => {
  it.effect("allows a default idle period longer than one minute", () =>
    Effect.gen(function* () {
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              sseEvents({
                type: "response.reasoning_summary_text.delta",
                item_id: "rs_1",
                delta: "Still reasoning",
              }),
            ),
          )
        },
        cancel() {
          cancelled = true
        },
      })
      const completed = yield* Ref.make(false)
      const received = yield* Deferred.make<void>()
      const fiber = yield* LLMClient.stream(
        LLM.request({
          model,
          prompt: "Think carefully.",
        }),
      ).pipe(
        Stream.tap(() => Deferred.succeed(received, undefined)),
        Stream.runDrain,
        Effect.flip,
        Effect.provide(fixedResponse(body)),
        Effect.ensuring(Ref.set(completed, true)),
        Effect.forkChild,
      )

      yield* Deferred.await(received)
      yield* TestClock.adjust(60_001)
      expect(yield* Ref.get(completed)).toBe(false)

      yield* TestClock.adjust(5 * 60_000 - 60_001)
      const error = yield* Fiber.join(fiber)

      expect(error).toBeInstanceOf(LLMError)
      if (!(error instanceof LLMError)) return
      expect(error.reason).toMatchObject({ _tag: "Transport", kind: "idle" })
      expect(error.message).toContain("300000ms")
      expect(cancelled).toBe(true)
    }),
  )

  it.live("fails a stalled partial tool call with a retryable idle timeout", () =>
    Effect.gen(function* () {
      let cancelled = false
      const bytes = new TextEncoder().encode(
        sseEvents({
          type: "response.output_item.added",
          item: { type: "function_call", id: "item_1", call_id: "call_1", name: "apply_patch", arguments: "" },
        }),
      )
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
        },
        cancel() {
          cancelled = true
        },
      })
      const events: string[] = []
      const error = yield* LLMClient.stream(
        LLM.request({
          model,
          prompt: "Apply the patch.",
          tools: [{ name: "apply_patch", description: "Apply a patch.", inputSchema: { type: "object" } }],
          http: { idleTimeoutMs: 10 },
        }),
      ).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            events.push(event.type)
          }),
        ),
        Stream.runDrain,
        Effect.flip,
        Effect.provide(fixedResponse(body)),
      )

      expect(events).toContain("tool-input-start")
      expect(error).toBeInstanceOf(LLMError)
      if (!(error instanceof LLMError)) return
      expect(error.reason).toMatchObject({ _tag: "Transport", kind: "idle" })
      expect(error.retryable).toBe(true)
      expect(cancelled).toBe(true)
    }),
  )

  it.effect("classifies a mid-stream connection reset as retryable transport failure", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.stream(
        LLM.request({
          model,
          prompt: "Keep working.",
        }),
      ).pipe(Stream.runDrain, Effect.provide(truncatedStream([])), Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      if (!(error instanceof LLMError)) return
      expect(error.reason).toMatchObject({ _tag: "Transport", kind: "read", canRetry: true })
      expect(error.retryable).toBe(true)
      expect(error.message).toContain("Failed to read openai/openai-responses stream")
      expect(error.message).toContain("connection reset")
    }),
  )

  it.effect("classifies undici terminated fetches as retryable transport failure", () =>
    Effect.gen(function* () {
      const terminated = Object.assign(new TypeError("terminated"), {
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET", name: "SocketError" }),
      })
      const error = yield* LLMClient.stream(
        LLM.request({
          model,
          prompt: "Keep working.",
        }),
      ).pipe(
        Stream.runDrain,
        Effect.provide(
          dynamicResponse((input) =>
            Effect.sync(() => {
              const stream = new ReadableStream({
                pull(controller) {
                  controller.error(terminated)
                },
              })
              return input.respond(stream, { headers: { "content-type": "text/event-stream" } })
            }),
          ),
        ),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(LLMError)
      if (!(error instanceof LLMError)) return
      expect(error.reason).toMatchObject({ _tag: "Transport", kind: "read", canRetry: true })
      expect(error.retryable).toBe(true)
      expect(error.message).toContain("Failed to read openai/openai-responses stream")
      expect(error.message).toContain("terminated")
      expect(error.message).toContain("other side closed")
    }),
  )

  it.effect("does not retry abort-shaped body failures as transport reads", () =>
    Effect.gen(function* () {
      const aborted = new DOMException("aborted", "AbortError")
      const error = yield* LLMClient.stream(
        LLM.request({
          model,
          prompt: "Keep working.",
        }),
      ).pipe(
        Stream.runDrain,
        Effect.provide(
          dynamicResponse((input) =>
            Effect.sync(() => {
              const stream = new ReadableStream({
                pull(controller) {
                  controller.error(aborted)
                },
              })
              return input.respond(stream, { headers: { "content-type": "text/event-stream" } })
            }),
          ),
        ),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(LLMError)
      if (!(error instanceof LLMError)) return
      expect(error.reason).toMatchObject({ _tag: "Transport", kind: "abort", canRetry: false })
      expect(error.retryable).toBe(false)
    }),
  )

  it.effect("preserves stream interruption causes instead of retrying them as transport reads", () =>
    Effect.gen(function* () {
      const interrupted = OpenAIResponses.route
        .with({
          endpoint: { baseURL: "https://api.openai.test/v1/" },
          auth: Auth.bearer("test"),
          transport: {
            ...OpenAIResponses.route.transport,
            frames: () => Stream.failCause(Cause.interrupt()),
          },
        })
        .model({ id: "gpt-5.6-sol" })
      const exit = yield* LLMClient.stream(LLM.request({ model: interrupted, prompt: "Keep working." })).pipe(
        Stream.runDrain,
        Effect.exit,
        Effect.provide(fixedResponse("")),
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    }),
  )
})
