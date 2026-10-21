import { describe, expect, test } from "bun:test"
import { AIChain } from "@opencode-ai/core/ai-chain"
import { ProviderError } from "@opencode-ai/core/session/provider-error"
import {
  HttpContext,
  HttpRequestDetails,
  HttpResponseDetails,
  LLMError,
  QuotaExceededReason,
  TransportReason,
} from "@opencode-ai/llm"

const codeOf = (error: unknown) => AIChain.providerFailureCode(error)

describe("provider boundary mapper (E2)", () => {
  test("retries Cerebras minute token quota without turning it into account quota or Report", () => {
    const error = {
      message: "Tokens per minute limit exceeded - too many tokens processed.",
      statusCode: 429,
      responseBody:
        '{"message":"Tokens per minute limit exceeded - too many tokens processed.","type":"too_many_tokens_error","param":"quota","code":"token_quota_exceeded"}',
      retryAfterMs: 59_000,
      retryable: true,
    }
    expect(AIChain.isQuotaExceededFailure(error)).toBe(false)
    expect(ProviderError.normalize(error, "cerebras/qwen-3.8-27b")).toMatchObject({
      code: "provider.rate-limit",
      httpStatus: 429,
      retryAfterMs: 59_000,
      retryability: "auto-retry",
      remediation: "retry",
      message: "The provider rate limit was reached (HTTP 429) (cerebras/qwen-3.8-27b).",
    })
    for (const responseBody of [
      '{"message":"Tokens per day limit exceeded","code":"token_quota_exceeded"}',
      '{"message":"Tokens per minute limit exceeded","code":"insufficient_quota"}',
      '{"message":"Tokens per minute limit exceeded","code":"quota_exceeded"}',
      '{"message":"Weekly quota reached; Tokens per minute limit exceeded","code":"token_quota_exceeded"}',
      '{"message":"Tokens per minute limit exceeded","code":"1310"}',
    ]) {
      expect(
        ProviderError.normalize({ ...error, message: "Provider rejected the request", responseBody }),
      ).toMatchObject({
        retryability: "none",
        remediation: "report",
      })
    }
  })

  test("retains SDK HTTP facts and terminal retry hints in the durable failure", () => {
    const sdk = {
      message: "Tokens per minute limit exceeded - too many tokens processed.",
      statusCode: 429,
      responseHeaders: { "retry-after": "61" },
      retryAfterMs: 61_000,
      retryable: true,
    }
    expect(ProviderError.normalize(sdk)).toMatchObject({
      code: "provider.rate-limit",
      httpStatus: 429,
      retryAfterMs: 61_000,
      retryability: "auto-retry",
    })
    expect(ProviderError.normalize({ ...sdk, retryable: false })).toMatchObject({
      code: "provider.rate-limit",
      retryability: "none",
    })
    const terminal = new LLMError({
      module: "SessionRunner",
      method: "runProviderStream",
      reason: new TransportReason({
        message: "Unauthorized",
        status: 401,
        responseHeaders: sdk.responseHeaders,
        responseBody: sdk.message,
        retryAfterMs: 61_000,
        canRetry: false,
      }),
    })
    expect(ProviderError.normalize(terminal)).toMatchObject({
      code: "provider.auth",
      httpStatus: 401,
      retryAfterMs: 61_000,
      retryability: "none",
    })
  })

  test("maps stream abort, stall, and inactivity to provider.transport", () => {
    expect(codeOf(new Error("Response stream was aborted by the remote"))).toBe("provider.transport")
    expect(codeOf(new Error("stream stalled after 30000ms"))).toBe("provider.transport")
    expect(codeOf(new Error("stream-inactivity: no events for 45s"))).toBe("provider.transport")
    expect(codeOf(new Error("chunk without a finish reason"))).toBe("provider.transport")
  })

  test("maps a Responses stream halted before a terminal event to retryable provider transport", () => {
    const event = {
      type: "provider-error" as const,
      message: "OpenAI Responses stream ended without a terminal response event",
      retryable: true,
    }
    expect(codeOf(event)).toBe("provider.transport")
    expect(AIChain.providerFailure(event)).toMatchObject({
      code: "provider.transport",
      retryability: "auto-retry",
      remediation: "retry",
    })
  })

  test("maps rate limit and quota exhaustion to provider.rate-limit", () => {
    expect(codeOf(Object.assign(new Error("Too many requests"), { statusCode: 429 }))).toBe("provider.rate-limit")
    expect(codeOf(new Error("RESOURCE_EXHAUSTED: quota exceeded"))).toBe("provider.rate-limit")
    expect(codeOf(Object.assign(new Error("payment required"), { status: 402 }))).toBe("provider.rate-limit")
    expect(codeOf(new Error("insufficient_quota: add credits"))).toBe("provider.rate-limit")
  })

  test("maps auth failures to provider.auth ahead of other classes", () => {
    expect(codeOf(Object.assign(new Error("Forbidden"), { statusCode: 403 }))).toBe("provider.auth")
    expect(codeOf(new Error("invalid_api_key: key not recognized"))).toBe("provider.auth")
    expect(codeOf(new Error("Authentication failed for provider"))).toBe("provider.auth")
  })

  test("maps context overflow wording across providers", () => {
    expect(codeOf(new Error("This model's maximum context length is 128000 tokens"))).toBe("provider.context-overflow")
    expect(codeOf(new Error("Prompt is too long: 200000 tokens > 128000 maximum"))).toBe("provider.context-overflow")
    expect(codeOf(new Error("context_length_exceeded: input exceeds the model window"))).toBe(
      "provider.context-overflow",
    )
  })

  test("maps content policy rejections", () => {
    expect(codeOf(new Error("content_policy_violation"))).toBe("provider.content-policy")
    expect(codeOf(new Error("request was rejected by the safety system"))).toBe("provider.content-policy")
    expect(codeOf(new Error("output blocked by content filter"))).toBe("provider.content-policy")
  })

  test("maps transport and transient server failures", () => {
    expect(codeOf(Object.assign(new Error("upstream error"), { statusCode: 503 }))).toBe("provider.transport")
    expect(codeOf(new Error("fetch failed: ECONNRESET"))).toBe("provider.transport")
    expect(codeOf(new Error("gateway timeout while streaming"))).toBe("provider.transport")
    expect(codeOf(new Error("WebSocket closed before the first event"))).toBe("provider.transport")
    expect(codeOf(new Error("Provider returned an empty completion without text, reasoning, or tool calls"))).toBe(
      "provider.transport",
    )
  })

  test("maps a terminated Codex response stream to retryable provider transport", () => {
    const error = new LLMError({
      module: "RouteClient",
      method: "stream",
      reason: new TransportReason({
        message: "Failed to read openai/openai-responses-codex stream: TypeError: terminated",
        kind: "read",
        canRetry: true,
      }),
    })
    expect(codeOf(error)).toBe("provider.transport")
    expect(AIChain.providerFailure(error).retryability).toBe("auto-retry")
    expect(codeOf(new Error("worker failed", { cause: error }))).toBe("provider.transport")
    expect(
      codeOf(
        new LLMError({
          module: "HttpTransport",
          method: "frames",
          reason: new TransportReason({ message: "User cancelled the request", kind: "abort", canRetry: false }),
        }),
      ),
    ).toBe("internal.defect")
  })

  test("maps invalid requests and keeps unknowns on internal.defect", () => {
    expect(codeOf(new Error("invalid_request_error: unsupported parameter"))).toBe("provider.invalid-request")
    expect(codeOf(new Error("flurb frobnicated unexpectedly"))).toBe("internal.defect")
    expect(codeOf(new Error(""))).toBe("internal.defect")
  })

  test("classifies through nested cause chains", () => {
    const nested = new Error("model request failed", {
      cause: Object.assign(new Error("429 Too Many Requests"), { statusCode: 429 }),
    })
    expect(codeOf(nested)).toBe("provider.rate-limit")
  })

  test("session aborts never classify as provider transport here", () => {
    const abort = new Error("The operation was aborted")
    abort.name = "AbortError"
    expect(codeOf(abort)).toBe("internal.defect")
  })

  test("providerFailure keeps raw text and providerRef for the error card", () => {
    const failure = AIChain.providerFailure(new Error("stream was aborted by remote"), "openai/gpt-5.5")
    expect(failure.code).toBe("provider.transport")
    expect(failure.providerRef).toBe("openai/gpt-5.5")
    expect(failure.cause?.raw).toContain("stream was aborted")
    expect(failure.retryability).toBe("auto-retry")
    expect(failure.remediation).toBe("retry")
  })

  test("typed quota failures are terminal while ordinary rate limits remain retryable", () => {
    const quota = {
      _tag: "LLM.Error",
      module: "RequestExecutor",
      method: "execute",
      reason: {
        _tag: "QuotaExceeded",
        message: 'HTTP 429: {"error":{"code":"1310","message":"period quota exhausted"}}',
        http: { response: { status: 429 }, body: '{"error":{"code":"1310"}}' },
      },
    }
    const failure = AIChain.providerFailure(quota, "zhipuai-coding-plan/glm-5.2")

    expect(failure).toMatchObject({
      code: "provider.rate-limit",
      retryability: "none",
      remediation: "report",
      providerRef: "zhipuai-coding-plan/glm-5.2",
      cause: { raw: expect.stringContaining("1310") },
      httpStatus: 429,
    })
    expect(AIChain.providerFailure(Object.assign(new Error("Too many requests"), { status: 429 })).retryability).toBe(
      "auto-retry",
    )
  })

  test("keeps timezone-less quota reset text instead of inventing an epoch", () => {
    const error = new LLMError({
      module: "RequestExecutor",
      method: "execute",
      reason: new QuotaExceededReason({
        message: 'HTTP 429: {"error":{"code":"1310","message":"limit resets at 2026-10-09 17:43:33"}}',
        http: new HttpContext({
          request: new HttpRequestDetails({ method: "POST", url: "https://provider.invalid", headers: {} }),
          response: new HttpResponseDetails({ status: 429, headers: {} }),
        }),
      }),
    })
    const failure = ProviderError.normalize(error, "zhipuai-coding-plan/glm-5.2")

    expect(failure).toMatchObject({
      code: "provider.rate-limit",
      retryability: "none",
      remediation: "report",
      providerRef: "zhipuai-coding-plan/glm-5.2",
      httpStatus: 429,
      cause: { detail: expect.stringContaining("timezone unknown") },
    })
    expect(failure.resetAt).toBeUndefined()
    expect(failure.message).toContain("2026-10-09 17:43:33")
    expect(failure.message).toContain("timezone unknown")
  })
})
