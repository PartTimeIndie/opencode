import { describe, expect, test } from "bun:test"
import { LLMError, TransportReason } from "@opencode-ai/llm"
import {
  AIChainLimits,
  chainStepFailureEligible,
  chainStepRetryEligible,
  hasNonRetryableHttpStatus,
  normalizeAIChainSteps,
  providerFailureCode,
} from "../src/ai-chain"

describe("AIChain.chainStepRetryEligible", () => {
  test("retries transient limits but not exhausted quota or retired models", () => {
    expect(chainStepRetryEligible(Object.assign(new Error("Rate limit exceeded"), { statusCode: 429 }))).toBe(true)
    expect(chainStepRetryEligible(new Error("insufficient_quota: account credits exhausted"))).toBe(false)
    expect(chainStepRetryEligible(new Error("quota exceeded for this billing period"))).toBe(false)
    expect(chainStepRetryEligible(Object.assign(new Error("model not found"), { statusCode: 404 }))).toBe(false)
    expect(chainStepRetryEligible(new Error("authentication failed"))).toBe(false)
  })
})

describe("AIChain.normalizeAIChainSteps", () => {
  test("classifies Cerebras TPM exhaustion without mistaking it for context overflow", () => {
    const message = "Tokens per minute limit exceeded - too many tokens processed."
    expect(providerFailureCode(new Error(message))).toBe("provider.rate-limit")
    expect(providerFailureCode({ message, statusCode: 429 })).toBe("provider.rate-limit")
    expect(providerFailureCode({ message, statusCode: 401 })).toBe("provider.auth")
    expect(providerFailureCode({ message, statusCode: 422 })).toBe("provider.invalid-request")
    expect(providerFailureCode(new Error("too many input tokens"))).toBe("provider.context-overflow")
  })

  test("keeps a valid chain in exact order with exact variants", () => {
    const result = normalizeAIChainSteps([
      { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
      { providerID: "openai", modelID: "gpt-5.6-sol", variant: "medium" },
    ])
    expect(result).toEqual({
      steps: [
        { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
        { providerID: "openai", modelID: "gpt-5.6-sol", variant: "medium" },
      ],
    })
  })

  test("treats undefined as no chain so single-model requests stay valid", () => {
    expect(normalizeAIChainSteps(undefined)).toEqual({})
  })

  test("rejects an empty chain instead of falling back to any model", () => {
    expect(normalizeAIChainSteps([])).toMatchObject({ error: expect.stringContaining("at least one step") })
  })

  test("rejects non-array chains", () => {
    expect(normalizeAIChainSteps("openai/gpt-5.6-sol")).toMatchObject({ error: expect.stringContaining("array") })
    expect(normalizeAIChainSteps({ steps: [] })).toMatchObject({ error: expect.stringContaining("array") })
    expect(normalizeAIChainSteps(null)).toMatchObject({ error: expect.stringContaining("array") })
  })

  test("bounds the step count", () => {
    const steps = Array.from({ length: AIChainLimits.maxSteps + 1 }, (_, index) => ({
      providerID: `p${index}`,
      modelID: "m",
    }))
    expect(normalizeAIChainSteps(steps)).toMatchObject({ error: expect.stringContaining("must not exceed 5 steps") })
    expect(normalizeAIChainSteps(steps.slice(0, AIChainLimits.maxSteps)).steps).toHaveLength(AIChainLimits.maxSteps)
  })

  test("validates step shapes and string lengths", () => {
    expect(normalizeAIChainSteps([{ providerID: "openai" }])).toMatchObject({ error: "modelID must be a string" })
    expect(normalizeAIChainSteps([{ modelID: "m" }])).toMatchObject({ error: "providerID must be a string" })
    expect(normalizeAIChainSteps([{ providerID: "  ", modelID: "m" }])).toMatchObject({
      error: "providerID must not be empty",
    })
    expect(normalizeAIChainSteps([{ providerID: "p".repeat(65), modelID: "m" }])).toMatchObject({
      error: "providerID exceeds 64 characters",
    })
    expect(normalizeAIChainSteps([{ providerID: "p", modelID: "m".repeat(129) }])).toMatchObject({
      error: "modelID exceeds 128 characters",
    })
    expect(normalizeAIChainSteps([{ providerID: "p", modelID: "m", variant: "v".repeat(33) }])).toMatchObject({
      error: "variant exceeds 32 characters",
    })
    expect(normalizeAIChainSteps([{ providerID: "p", modelID: "m", variant: "  " }])).toMatchObject({
      error: "variant must not be empty",
    })
    expect(normalizeAIChainSteps([{ providerID: "p\u0000", modelID: "m" }])).toMatchObject({
      error: "providerID must not contain control characters",
    })
    expect(normalizeAIChainSteps([null])).toMatchObject({ error: expect.stringContaining("objects with providerID") })
    expect(normalizeAIChainSteps(["openai/gpt"])).toMatchObject({
      error: expect.stringContaining("objects with providerID"),
    })
  })

  test("rejects duplicate steps so a chain never retries the same model", () => {
    expect(
      normalizeAIChainSteps([
        { providerID: "openai", modelID: "gpt", variant: "low" },
        { providerID: "openai", modelID: "gpt", variant: "high" },
      ]),
    ).toMatchObject({ error: expect.stringContaining("duplicate step openai/gpt") })
  })

  test("preserves duplicate models across different providers", () => {
    const result = normalizeAIChainSteps([
      { providerID: "openai", modelID: "shared" },
      { providerID: "zhipuai-coding-plan", modelID: "shared" },
    ])
    expect(result.steps).toHaveLength(2)
  })
})

describe("AIChain.chainStepFailureEligible", () => {
  test("never renews a consumed format correction through generic or permissive chain fallback", () => {
    const correction = new LLMError({
      module: "RequestExecutor", method: "execute", structuredOutputCorrectionAttempted: true,
      reason: new TransportReason({ kind: "provider-error", message: "service unavailable", canRetry: true, status: 503 }),
    })
    for (const error of [correction, new Error("wrapped", { cause: correction }), JSON.parse(JSON.stringify(correction))]) {
      expect(chainStepFailureEligible(error)).toBe(false)
      expect(chainStepFailureEligible(error, { provider: true, authorization: true })).toBe(false)
      expect(chainStepRetryEligible(error)).toBe(false)
    }
    expect(chainStepFailureEligible(new LLMError({
      module: correction.module, method: correction.method, reason: correction.reason,
    }))).toBe(true)
  })

  test("allows fallback after output truncation but not invalid token-budget requests", () => {
    expect(chainStepFailureEligible(new Error("Incomplete model response: output token budget exhausted"))).toBe(true)
    expect(
      chainStepFailureEligible(Object.assign(new Error("output token budget exhausted"), { statusCode: 400 })),
    ).toBe(false)
    expect(
      chainStepFailureEligible(Object.assign(new Error("output token budget exhausted"), { statusCode: 401 })),
    ).toBe(false)
  })

  test("advances only for transient quota, availability, and empty-output failures", () => {
    expect(chainStepFailureEligible(Object.assign(new Error("resource_exhausted"), { statusCode: 429 }))).toBe(true)
    expect(
      chainStepFailureEligible(new Error('Provider request failed with HTTP 429: {"error":{"code":"1310"}}')),
    ).toBe(true)
    expect(chainStepFailureEligible(Object.assign(new Error("service unavailable"), { statusCode: 503 }))).toBe(true)
    expect(chainStepFailureEligible(Object.assign(new Error("payment required"), { statusCode: 402 }))).toBe(true)
    expect(chainStepFailureEligible(Object.assign(new Error("request timeout"), { statusCode: 408 }))).toBe(true)
    expect(chainStepFailureEligible({ message: "Primary unavailable", retryable: true })).toBe(true)
    expect(chainStepFailureEligible({ message: "Stream abgebrochen", retryable: false })).toBe(true)
    expect(chainStepFailureEligible(new Error("Cursor Run stream aborted by remote"))).toBe(true)
    expect(
      chainStepFailureEligible(
        new LLMError({
          module: "SessionRunner",
          method: "runProviderStream",
          reason: new TransportReason({
            message: "test.stream: Stream abgebrochen",
            kind: "stream-aborted",
            canRetry: true,
          }),
        }),
      ),
    ).toBe(true)
    expect(chainStepFailureEligible(new Error("Provider returned an empty response"))).toBe(true)
    expect(
      chainStepFailureEligible(
        new LLMError({
          module: "SessionRunner",
          method: "runProviderStream",
          reason: new TransportReason({
            message: "Provider stream stalled: no events for 60 seconds",
            kind: "stream-inactivity",
            canRetry: true,
          }),
        }),
      ),
    ).toBe(true)
    expect(chainStepFailureEligible({ cause: Object.assign(new Error("quota exhausted"), { status: 429 }) })).toBe(true)
    expect(chainStepFailureEligible({ status: 503, cause: { statusCode: 401 } })).toBe(false)
    expect(chainStepFailureEligible(Object.assign(new Error("authentication failed"), { statusCode: 503 }))).toBe(false)
    expect(chainStepFailureEligible(Object.assign(new Error("model not found"), { statusCode: 429 }))).toBe(true)
    expect(chainStepFailureEligible(Object.assign(new Error("invalid api key"), { statusCode: 401 }))).toBe(false)
    expect(
      chainStepFailureEligible(Object.assign(new Error("Request failed: 401"), { statusCode: 401 }), {
        authorization: true,
      }),
    ).toBe(true)
    expect(chainStepFailureEligible(new Error("Integration.Authorization"), { authorization: true })).toBe(true)
    expect(chainStepFailureEligible(Object.assign(new Error("model not found"), { statusCode: 404 }))).toBe(true)
    expect(chainStepFailureEligible(new Error("authentication service unavailable"))).toBe(false)
    expect(chainStepFailureEligible(new Error("unexpected provider failure"))).toBe(false)
    expect(chainStepFailureEligible(new Error("unexpected provider failure"), { provider: true })).toBe(true)
    expect(chainStepFailureEligible(new Error("invalid request"), { provider: true })).toBe(true)
    const cancelled = new Error("cancelled")
    cancelled.name = "AbortError"
    expect(chainStepFailureEligible(cancelled)).toBe(false)
  })

  test("treats retired or missing provider models as eligible so a chain can advance", () => {
    // Provider.ModelNotFoundError carries only the class name; the message is empty.
    const retired = Object.assign(new Error(""), { name: "ProviderModelNotFoundError" })
    expect(chainStepFailureEligible(retired)).toBe(true)
    expect(chainStepFailureEligible(Object.assign(new Error("ProviderModelNotFoundError"), { statusCode: 404 }))).toBe(
      true,
    )
    expect(
      chainStepFailureEligible(
        Object.assign(
          new Error("The model `openrouter/stealth/ox-alpha` does not exist or you do not have access to it."),
          { statusCode: 404 },
        ),
      ),
    ).toBe(true)
    expect(
      chainStepFailureEligible(
        Object.assign(new Error("invalid_request_error: the requested model does not exist"), { statusCode: 404 }),
      ),
    ).toBe(true)
    expect(chainStepFailureEligible(new Error("NoSuchModelError: no such model stealth/ox-alpha"))).toBe(true)
    expect(chainStepFailureEligible(new Error("Unknown model: stealth/ox-alpha"))).toBe(true)
    expect(
      chainStepFailureEligible(
        Object.assign(new Error("No endpoints found that matched your request"), { statusCode: 404 }),
      ),
    ).toBe(true)
    expect(chainStepFailureEligible(new Error("this model has been deprecated"))).toBe(true)
    expect(chainStepFailureEligible(new Error("openrouter/stealth/ox-alpha has been retired"))).toBe(true)
    expect(chainStepFailureEligible(new Error("Error: CatalogV2.ModelNotFound"))).toBe(true)
    expect(chainStepFailureEligible(new Error("Error: CatalogV2.ProviderNotFound"))).toBe(true)
    // Model resolution failures advance session-owned chains too, including after quota text.
    expect(chainStepFailureEligible(retired, { authorization: true })).toBe(true)
  })

  test("keeps invalid-request and auth-policy failures permanent even near model text", () => {
    expect(
      chainStepFailureEligible(
        Object.assign(new Error("invalid_request_error: max_tokens exceeds limit"), { statusCode: 400 }),
      ),
    ).toBe(false)
    expect(chainStepFailureEligible(new Error("Unsupported parameter: max_output_tokens is deprecated"))).toBe(false)
    expect(chainStepFailureEligible(new Error("invalid model id syntax"))).toBe(false)
    expect(chainStepFailureEligible(Object.assign(new Error("No auth credentials found"), { statusCode: 401 }))).toBe(
      false,
    )
    expect(chainStepFailureEligible(new Error("authentication failed while loading the model"))).toBe(false)
    expect(chainStepFailureEligible(Object.assign(new Error("Route not found"), { statusCode: 404 }))).toBe(false)
    expect(
      chainStepFailureEligible(Object.assign(new Error("not_found_error: route missing"), { statusCode: 404 })),
    ).toBe(false)
    expect(chainStepFailureEligible({ status: 404, cause: { statusCode: 401 } })).toBe(false)
  })
})

describe("AIChain provider error classification", () => {
  test("keeps typed incomplete response failures distinct from transport reads", () => {
    expect(
      providerFailureCode(
        new LLMError({
          module: "fixture",
          method: "stream",
          reason: new TransportReason({
            kind: "invalid-response",
            message: "Provider response is incomplete",
            canRetry: true,
          }),
        }),
      ),
    ).toBe("provider.invalid-response")
    expect(
      providerFailureCode(
        new LLMError({
          module: "fixture",
          method: "stream",
          reason: new TransportReason({ kind: "read", message: "Provider response is incomplete", canRetry: true }),
        }),
      ),
    ).toBe("provider.transport")
  })

  test("keeps an HTTP 400 server_error terminal when a provider marks it retryable", () => {
    const denial = {
      message:
        'Provider request failed with HTTP 400: {"error":{"type":"server_error","message":"workspace privacy setting required"}}',
      retryable: true,
    }

    expect(hasNonRetryableHttpStatus(denial)).toBe(true)
    expect(providerFailureCode(denial)).toBe("provider.invalid-request")
  })

  test("does not classify transient HTTP statuses as non-retryable", () => {
    for (const status of [402, 408, 429, 500]) {
      expect(hasNonRetryableHttpStatus({ message: `Provider failed with HTTP ${status}`, retryable: true })).toBe(false)
    }
  })
})
