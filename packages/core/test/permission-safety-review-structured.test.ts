import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { LLM, LLMClient, LLMError, LLMEvent, LLMResponse, Model, TransportReason, type LLMRequest } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols"
import { PermissionSafetyReview } from "@opencode-ai/core/permission/safety-review"

const model = Model.make({ id: "safety-fixture", provider: "fixture", route: OpenAIChat.route })

function fixture(values: unknown[]) {
  const requests: LLMRequest[] = []
  const client = Layer.succeed(LLMClient.Service, LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: () => Stream.die("unused"),
    generate: (request) => Effect.sync(() => {
      requests.push(request)
      const value = values.shift()
      const name = request.tools[0]?.name
      return new LLMResponse({ events: [
        ...(name ? [LLMEvent.toolCall({ id: `safety-${requests.length}`, name, input: value })]
          : [LLMEvent.textDelta({ id: "text", text: JSON.stringify(value) })]),
        LLMEvent.finish({ reason: name ? "tool-calls" : "stop" }),
      ] })
    }),
  }))
  return { requests, client }
}

describe("safety review structured contract", () => {
  test("transmits the decision schema and corrects only once on the same model", async () => {
    const { requests, client } = fixture([{ decision: "maybe", reason: "unknown" }, { decision: "safe", reason: "read-only" }])
    const decision = await Effect.runPromise(PermissionSafetyReview.generateDecision(LLM.request({
      model, prompt: "Review a read-only operation",
    })).pipe(Effect.provide(client)))
    expect(decision).toEqual({ decision: "safe", reason: "read-only" })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.tools[0]?.inputSchema).toMatchObject({
      type: "object", required: ["decision", "reason"],
      properties: { decision: { enum: ["safe", "unsafe"] }, reason: { type: "string" } },
    })
    expect(requests[1]?.model).toEqual(requests[0]?.model)
    expect(requests[1]?.tools).toEqual(requests[0]?.tools)
    expect(requests.every((request) => request.http?.retries === 0)).toBe(true)
  })

  test("cannot approve a twice-invalid decision or silently strip unknown fields", async () => {
    const { requests, client } = fixture([
      { decision: "safe", reason: "unverified", extra: "discard me" },
      { decision: "maybe", reason: "still invalid" },
    ])
    const exit = await Effect.runPromise(PermissionSafetyReview.generateDecision(LLM.request({
      model, prompt: "Review the operation",
    })).pipe(Effect.provide(client), Effect.exit))
    expect(exit._tag).toBe("Failure")
    expect(requests).toHaveLength(2)
  })

  test("keeps correction transport failures distinct but cannot renew their budget", async () => {
    const failure = new LLMError({
      module: "RequestExecutor", method: "execute", structuredOutputCorrectionAttempted: true,
      reason: new TransportReason({ kind: "provider-error", message: "fixture timeout", canRetry: true }),
    })
    const attempt = { role: "primary" as const, ...PermissionSafetyReview.classifyFailure(failure) }
    expect(attempt).toMatchObject({ status: "transport_error", correctionAttempted: true })
    expect(PermissionSafetyReview.nextChainAction(attempt, 1)).toBe("stop")
    let calls = 0
    const attempts = await Effect.runPromise(PermissionSafetyReview.runReviewerChain(
      [{ model: "fixture/first" }, { model: "fixture/second" }],
      () => Effect.sync(() => { calls++; return attempt }),
    ))
    expect(calls).toBe(1)
    expect(attempts).toEqual([attempt])
    const initial = { role: "primary" as const, ...PermissionSafetyReview.classifyFailure(new LLMError({
      module: failure.module, method: failure.method, reason: failure.reason,
    })) }
    expect(initial.status).toBe("transport_error")
    expect(PermissionSafetyReview.nextChainAction(initial, 1)).toBe("retry")
  })

  test("does not renew an exhausted format budget at the next safety-chain stage", () => {
    expect(PermissionSafetyReview.nextChainAction({
      role: "primary", status: "malformed", formatFailure: true,
    }, 1)).toBe("stop")
  })
})
