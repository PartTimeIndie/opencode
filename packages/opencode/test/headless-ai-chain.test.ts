import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HeadlessAIChain } from "@/headless-ai-chain"

const stepA = { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" } as const
const stepB = { providerID: "openai", modelID: "gpt-5.6-sol", variant: "medium" } as const

function recorder(script: Array<{ text?: string; error?: Error }>) {
  const calls: string[] = []
  const runStep = (step: { providerID: string; modelID: string; variant?: string }) => {
    calls.push(`${step.providerID}/${step.modelID}`)
    const behavior = script[Math.min(calls.length - 1, script.length - 1)]!
    if (behavior.error) return Effect.fail(behavior.error)
    return Effect.succeed({ text: behavior.text ?? "", model: `${step.providerID}/${step.modelID}` })
  }
  return { calls, runStep }
}

function quotaError(message = "resource_exhausted: quota exceeded") {
  return Object.assign(new Error(message), { statusCode: 429 })
}

describe("HeadlessAIChain.runModelChain", () => {
  test("returns the first step result without touching later steps", async () => {
    const { calls, runStep } = recorder([{ text: "first reply" }, { text: "unused" }])
    const result = await Effect.runPromise(HeadlessAIChain.runModelChain([stepA, stepB], runStep))
    expect(result).toEqual({ text: "first reply", model: "zhipuai-coding-plan/glm-5.3" })
    expect(calls).toEqual(["zhipuai-coding-plan/glm-5.3"])
  })

  test("advances to the next step in order after a transient quota failure", async () => {
    const { calls, runStep } = recorder([{ error: quotaError() }, { text: "fallback reply" }])
    const result = await Effect.runPromise(HeadlessAIChain.runModelChain([stepA, stepB], runStep))
    expect(result).toEqual({ text: "fallback reply", model: "openai/gpt-5.6-sol" })
    expect(calls).toEqual(["zhipuai-coding-plan/glm-5.3", "openai/gpt-5.6-sol"])
  })

  test("treats a whitespace-only completion as empty and advances", async () => {
    const { calls, runStep } = recorder([{ text: "   " }, { text: "recovered" }])
    const result = await Effect.runPromise(HeadlessAIChain.runModelChain([stepA, stepB], runStep))
    expect(result.text).toBe("recovered")
    expect(result.model).toBe("openai/gpt-5.6-sol")
    expect(calls).toHaveLength(2)
  })

  test("fails closed on permanent failures without advancing", async () => {
    const { calls, runStep } = recorder([
      { error: Object.assign(new Error("invalid_api_key: authentication failed"), { statusCode: 401 }) },
      { text: "must never run" },
    ])
    const error = await Effect.runPromise(Effect.flip(HeadlessAIChain.runModelChain([stepA, stepB], runStep)))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("Model chain stopped at zhipuai-coding-plan/glm-5.3")
    expect((error as Error).message).toContain("authentication failed")
    expect(calls).toEqual(["zhipuai-coding-plan/glm-5.3"])
  })

  test("fails with a combined message when every step fails transiently", async () => {
    const { calls, runStep } = recorder([{ error: quotaError("rate limit exceeded") }, { error: quotaError("quota exceeded") }])
    const error = await Effect.runPromise(Effect.flip(HeadlessAIChain.runModelChain([stepA, stepB], runStep)))
    expect((error as Error).message).toBe(
      "All 2 models in the chain failed: " +
        "zhipuai-coding-plan/glm-5.3: Error: rate limit exceeded; " +
        "openai/gpt-5.6-sol (medium): Error: quota exceeded",
    )
    expect(calls).toHaveLength(2)
  })

  test("propagates abort errors immediately without advancing", async () => {
    const abort = new Error("user cancelled")
    abort.name = "AbortError"
    const { calls, runStep } = recorder([{ error: abort }, { text: "unused" }])
    const error = await Effect.runPromise(Effect.flip(HeadlessAIChain.runModelChain([stepA, stepB], runStep)))
    expect(error).toBe(abort)
    expect(calls).toEqual(["zhipuai-coding-plan/glm-5.3"])
  })

  test("advances to the next step after a provider timeout error", async () => {
    const timeout = new Error("provider request timed out after 30s")
    timeout.name = "TimeoutError"
    const { calls, runStep } = recorder([{ error: timeout }, { text: "fallback after timeout" }])
    const result = await Effect.runPromise(HeadlessAIChain.runModelChain([stepA, stepB], runStep))
    expect(result).toEqual({ text: "fallback after timeout", model: "openai/gpt-5.6-sol" })
    expect(calls).toEqual(["zhipuai-coding-plan/glm-5.3", "openai/gpt-5.6-sol"])
  })

  test("still fails immediately for timeout errors when the caller aborted the run", async () => {
    const controller = new AbortController()
    controller.abort()
    const timeout = new Error("provider request timed out")
    timeout.name = "TimeoutError"
    const { calls, runStep } = recorder([{ error: timeout }, { text: "unused" }])
    const error = await Effect.runPromise(
      Effect.flip(HeadlessAIChain.runModelChain([stepA, stepB], runStep, { abort: controller.signal })),
    )
    expect(error).toBe(timeout)
    expect(calls).toEqual(["zhipuai-coding-plan/glm-5.3"])
  })

  test("fails immediately when the abort signal is already aborted even for transient errors", async () => {
    const controller = new AbortController()
    controller.abort()
    const { calls, runStep } = recorder([{ error: quotaError() }, { text: "unused" }])
    const error = await Effect.runPromise(
      Effect.flip(HeadlessAIChain.runModelChain([stepA, stepB], runStep, { abort: controller.signal })),
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("resource_exhausted: quota exceeded")
    expect(calls).toEqual(["zhipuai-coding-plan/glm-5.3"])
  })

  test("supports structured object results with the same transient-only order", async () => {
    const calls: string[] = []
    const result = await Effect.runPromise(
      HeadlessAIChain.runModelChain([stepA, stepB], (step) => {
        calls.push(`${step.providerID}/${step.modelID}`)
        if (step.providerID === "zhipuai-coding-plan") return Effect.fail(quotaError())
        return Effect.succeed({ model: `${step.providerID}/${step.modelID}`, object: { decision: "safe" as const } })
      }),
    )
    expect(result).toEqual({ model: "openai/gpt-5.6-sol", object: { decision: "safe" } })
    expect(calls).toEqual(["zhipuai-coding-plan/glm-5.3", "openai/gpt-5.6-sol"])
  })

  const stalledStep = (signal: AbortSignal) =>
    Effect.callback<never, Error>((resume) => {
      // Simulates a provider that opened a stream but never sends events: the
      // request only settles when the deadline aborts the signal.
      const abort = () => resume(Effect.fail(Object.assign(new Error("aborted"), { name: "AbortError" })))
      if (signal.aborted) return abort()
      signal.addEventListener("abort", abort, { once: true })
    })

  test("advances past a stalled step at the step deadline and aborts its signal", async () => {
    const stalledSignals: AbortSignal[] = []
    const calls: string[] = []
    const result = await Effect.runPromise(
      HeadlessAIChain.runModelChain(
        [stepA, stepB],
        (step, signal) => {
          calls.push(`${step.providerID}/${step.modelID}`)
          if (step.providerID === "zhipuai-coding-plan") {
            stalledSignals.push(signal)
            return stalledStep(signal)
          }
          return Effect.succeed({ text: "fallback after stall", model: `${step.providerID}/${step.modelID}` })
        },
        { stepTimeoutMs: 50 },
      ),
    )
    expect(result).toEqual({ text: "fallback after stall", model: "openai/gpt-5.6-sol" })
    expect(calls).toEqual(["zhipuai-coding-plan/glm-5.3", "openai/gpt-5.6-sol"])
    expect(stalledSignals[0]?.aborted).toBe(true)
  })

  test("reports the deadline in the combined failure message when every step stalls", async () => {
    const signals: AbortSignal[] = []
    const error = await Effect.runPromise(
      Effect.flip(
        HeadlessAIChain.runModelChain(
          [stepA, stepB],
          (step, signal) => {
            signals.push(signal)
            return stalledStep(signal)
          },
          { stepTimeoutMs: 50 },
        ),
      ),
    )
    expect((error as Error).message).toContain("zhipuai-coding-plan/glm-5.3: step deadline exceeded")
    expect((error as Error).message).toContain("openai/gpt-5.6-sol (medium): step deadline exceeded")
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })

  test("still fails immediately when the caller aborts while a step is stalled", async () => {
    const controller = new AbortController()
    const run = Effect.runPromise(
      Effect.flip(HeadlessAIChain.runModelChain([stepA, stepB], (step, signal) => stalledStep(signal), {
        abort: controller.signal,
        stepTimeoutMs: 60_000,
      })),
    )
    controller.abort()
    const error = await run
    expect((error as Error).name).toBe("AbortError")
  })
})

describe("HeadlessAIChain.chainStepFailureEligible", () => {
  test("treats availability and quota HTTP statuses as transient", () => {
    for (const status of [402, 408, 429, 500, 502, 503, 504]) {
      expect(HeadlessAIChain.chainStepFailureEligible(Object.assign(new Error("provider rejected"), { statusCode: status }))).toBe(true)
    }
  })

  test("treats deterministic client statuses as permanent", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(HeadlessAIChain.chainStepFailureEligible(Object.assign(new Error("provider rejected"), { statusCode: status }))).toBe(false)
    }
  })

  test("reads statuses from nested cause chains", () => {
    const nested = Object.assign(new Error("request failed"), {
      cause: Object.assign(new Error("upstream"), { status: 429 }),
    })
    expect(HeadlessAIChain.chainStepFailureEligible(nested)).toBe(true)
  })

  test("classifies transient provider messages as eligible", () => {
    const timeout = new Error("request timed out")
    timeout.name = "TimeoutError"
    for (const error of [
      timeout,
      new Error("TimeoutException: Operation timed out"),
      ...[
        "resource_exhausted",
        "quota exceeded for this billing period",
        "Rate limit exceeded",
        "Too many requests",
        "model is overloaded",
        "service temporarily unavailable",
        "fetch failed",
        "ECONNRESET",
        "socket hang up",
        "502 Bad Gateway",
        "stream ended without assistant content",
        "empty response",
      ].map((message) => new Error(message)),
    ]) {
      expect(HeadlessAIChain.chainStepFailureEligible(error)).toBe(true)
    }
  })

  test("classifies auth and invalid-request messages as permanent", () => {
    for (const message of [
      "unauthorized",
      "invalid_api_key",
      "permission denied",
      "invalid_request_error",
    ]) {
      expect(HeadlessAIChain.chainStepFailureEligible(new Error(message))).toBe(false)
    }
  })

  test("classifies retired and missing model text as eligible", () => {
    for (const message of [
      "model not found: glm-5.3",
      "this model has been deprecated",
      "The model `openrouter/stealth/ox-alpha` does not exist",
      "NoSuchModelError: no such model",
    ]) {
      expect(HeadlessAIChain.chainStepFailureEligible(new Error(message))).toBe(true)
    }
    // Provider.ModelNotFoundError carries only the class name; the message is empty.
    expect(
      HeadlessAIChain.chainStepFailureEligible(Object.assign(new Error(""), { name: "ProviderModelNotFoundError" })),
    ).toBe(true)
  })

  test("falls through to the next chain step when the first configured model is retired", async () => {
    const retired = Object.assign(new Error(""), { name: "ProviderModelNotFoundError" })
    const calls: string[] = []
    const result = await Effect.runPromise(
      HeadlessAIChain.runModelChain(
        [
          { providerID: "openrouter", modelID: "stealth/ox-alpha" },
          { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
          { providerID: "openai", modelID: "gpt-5.6-luna", variant: "medium" },
        ],
        (step) => {
          calls.push(`${step.providerID}/${step.modelID}`)
          if (step.providerID === "openrouter") return Effect.fail(retired)
          return Effect.succeed({ text: "glm recovered the chain", model: `${step.providerID}/${step.modelID}` })
        },
      ),
    )
    expect(result).toEqual({ text: "glm recovered the chain", model: "zhipuai-coding-plan/glm-5.3" })
    expect(calls).toEqual(["openrouter/stealth/ox-alpha", "zhipuai-coding-plan/glm-5.3"])
  })

  test("falls through after a provider 404 for an unknown model", async () => {
    const calls: string[] = []
    const result = await Effect.runPromise(
      HeadlessAIChain.runModelChain(
        [stepA, stepB],
        (step) => {
          calls.push(`${step.providerID}/${step.modelID}`)
          if (calls.length === 1)
            return Effect.fail(Object.assign(new Error("No endpoints found that matched your request"), { statusCode: 404 }))
          return Effect.succeed({ text: "luna recovered the chain", model: `${step.providerID}/${step.modelID}` })
        },
      ),
    )
    expect(result.text).toBe("luna recovered the chain")
    expect(result.model).toBe("openai/gpt-5.6-sol")
    expect(calls).toHaveLength(2)
  })

  test("stops the chain permanently on invalid-request failures", async () => {
    const calls: string[] = []
    const error = await Effect.runPromise(
      Effect.flip(
        HeadlessAIChain.runModelChain([stepA, stepB], (step) => {
          calls.push(`${step.providerID}/${step.modelID}`)
          return Effect.fail(new Error("invalid_request_error: messages.0.role is invalid"))
        }),
      ),
    )
    expect((error as Error).message).toContain("Model chain stopped at zhipuai-coding-plan/glm-5.3")
    expect((error as Error).message).toContain("invalid_request_error")
    expect(calls).toEqual(["zhipuai-coding-plan/glm-5.3"])
  })

  test("fails closed for unknown errors and aborts", () => {
    expect(HeadlessAIChain.chainStepFailureEligible(new Error("something odd happened"))).toBe(false)
    expect(HeadlessAIChain.chainStepFailureEligible("just a string")).toBe(false)
    const abort = new Error("cancelled")
    abort.name = "AbortError"
    expect(HeadlessAIChain.chainStepFailureEligible(abort)).toBe(false)
  })
})
