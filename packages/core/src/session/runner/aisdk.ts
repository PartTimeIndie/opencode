import type { LanguageModelV3 } from "@ai-sdk/provider"
import { convertBase64ToUint8Array } from "@ai-sdk/provider-utils"
import {
  LLMEvent,
  RequestRuntimeContext,
  StructuredOutputTransport,
  ToolResultValue,
  type FinishReason,
  type LLMRequest,
  type Message,
  type ToolContent,
} from "@opencode-ai/llm"
import { Cause, Effect, Stream } from "effect"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { AIChain } from "../../ai-chain"

export * as SessionRunnerAISDK from "./aisdk"

type CallOptions = Parameters<LanguageModelV3["doStream"]>[0]
type PromptMessage = CallOptions["prompt"][number]
type UserPromptPart = Extract<PromptMessage, { role: "user" }>["content"][number]
type AssistantPromptPart = Extract<PromptMessage, { role: "assistant" }>["content"][number]
type ToolPromptPart = Extract<PromptMessage, { role: "tool" }>["content"][number]
type StreamPart =
  Awaited<ReturnType<LanguageModelV3["doStream"]>>["stream"] extends ReadableStream<infer Part> ? Part : never

export const supportsRuntimeContext = (language: LanguageModelV3) =>
  language.provider === "openai.responses" || language.provider === "openai.chat"

export function stream(language: LanguageModelV3, request: LLMRequest): Stream.Stream<LLMEvent> {
  return Stream.unwrap(
    Effect.sync(() => {
      const contextError = RequestRuntimeContext.validate(request, supportsRuntimeContext(language))
      if (contextError) return Stream.succeed(providerError(contextError, request))
      const abortController = new AbortController()
      const toolNames = new Map<string, string>()
      return Stream.fromEffect(
        Effect.tryPromise({
          try: (signal) =>
            language.doStream({
              ...toCallOptions(request),
              abortSignal: AbortSignal.any([abortController.signal, signal]),
            }),
          catch: (error) => error,
        }),
      ).pipe(
        Stream.flatMap((response) =>
          Stream.unwrap(
            Effect.gen(function* () {
              // beta.74 reader.cancel rejects with the original read failure. Release
              // its lock first and cancel separately so cleanup cannot replace HTTP facts.
              yield* Effect.addFinalizer(() => Effect.promise(() => response.stream.cancel().catch(() => undefined)))
              return Stream.fromReadableStream({
                evaluate: () => response.stream,
                onError: (error) => error,
                releaseLockOnEnd: true,
              }).pipe(Stream.flatMap((part) => Stream.fromArray(toEvents(part, toolNames, request))))
            }),
          ),
        ),
        Stream.catchCause((cause) =>
          Cause.hasInterrupts(cause) || abortController.signal.aborted
            ? Stream.fromEffect(Effect.interrupt)
            : Stream.succeed(providerError(Cause.squash(cause), request)),
        ),
        Stream.ensuring(Effect.sync(() => abortController.abort())),
      )
    }),
  )
}

function toCallOptions(request: LLMRequest): CallOptions {
  const normalized = StructuredOutputTransport.normalize(request)
  return {
    prompt: [
      // Qwen-style templates accept only one system message at the beginning.
      ...(request.system.length === 0
        ? []
        : [{ role: "system" as const, content: request.system.map((part) => part.text).join("\n\n") }]),
      ...request.messages.flatMap((message) => toPromptMessage(message)),
      ...(request.runtimeContext?.length
        ? [{ role: "system" as const, content: request.runtimeContext.map((part) => part.text).join("\n") }]
        : []),
    ],
    tools: normalized.tools.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    toolChoice: normalized.toolChoice
      ? normalized.toolChoice.type === "tool"
        ? { type: "tool" as const, toolName: normalized.toolChoice.name ?? "" }
        : { type: normalized.toolChoice.type }
      : undefined,
    responseFormat: normalized.responseFormat?.type === "json"
      ? { type: "json", schema: normalized.responseFormat.schema }
      : normalized.responseFormat?.type === "text"
        ? { type: "text" }
        : undefined,
    maxOutputTokens: request.generation?.maxTokens,
    temperature: request.generation?.temperature,
    topP: request.generation?.topP,
    topK: request.generation?.topK,
    frequencyPenalty: request.generation?.frequencyPenalty,
    presencePenalty: request.generation?.presencePenalty,
    stopSequences: request.generation?.stop ? [...request.generation.stop] : undefined,
    seed: request.generation?.seed,
    // Keep host context at system rank, including SDK reasoning-model defaults
    // that otherwise rewrite every system message to developer.
    providerOptions: request.runtimeContext?.length
      ? { ...toProviderOptions(request.providerOptions), openai: { ...toProviderOptions(request.providerOptions)?.openai, systemMessageMode: "system" } }
      : toProviderOptions(request.providerOptions),
    headers: request.http?.headers,
  }
}

function toPromptMessage(message: Message): Array<PromptMessage> {
  if (message.role === "system") {
    // Match native routes: keep operator updates in order, never hoist them
    // into the initial instructions or send a late privileged system role.
    const text = message.content
      .map((part) => {
        if (part.type !== "text") throw new Error("AISDK chronological system updates require text content")
        return part.text
      })
      .join("\n")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
    return [{ role: "user", content: [{ type: "text", text: `<system-update>\n${text}\n</system-update>` }] }]
  }
  if (message.role === "user") {
    const content = message.content.flatMap(toUserPromptPart)
    return [
      {
        role: "user" as const,
        content,
      },
    ]
  }
  if (message.role === "assistant") {
    const content = message.content.flatMap(toAssistantPromptPart)
    return [
      {
        role: "assistant" as const,
        content,
      },
    ]
  }
  const content = message.content.flatMap(toToolPromptPart)
  return [
    {
      role: "tool" as const,
      content,
    },
  ]
}

function toUserPromptPart(part: Message["content"][number]): Array<UserPromptPart> {
  if (part.type === "text") return [{ type: "text", text: part.text }]
  if (part.type === "media")
    return [{ type: "file", data: toFileData(part), mediaType: part.mediaType, filename: part.filename }]
  return []
}

function toFileData(part: Extract<Message["content"][number], { type: "media" }>) {
  if (typeof part.data !== "string") return part.data
  if (/^https?:\/\//i.test(part.data)) return new URL(part.data)
  if (!part.data.startsWith("data:")) return part.data
  // SDK strings are raw base64, not data URLs. Passing the complete URI as
  // a string makes OpenAI-compatible SDKs prepend a second data-URL header.
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/s.exec(part.data)
  if (!match?.[2]) throw new Error("AISDK media data URL must contain valid base64")
  if (match[1]?.toLowerCase() !== part.mediaType.toLowerCase())
    throw new Error("AISDK media type does not match data URL type")
  return convertBase64ToUint8Array(match[2] ?? "")
}

function toAssistantPromptPart(part: Message["content"][number]): Array<AssistantPromptPart> {
  if (part.type === "text") return [{ type: "text", text: part.text }]
  if (part.type === "reasoning") return [{ type: "reasoning", text: part.text }]
  if (part.type === "tool-call")
    return [{ type: "tool-call", toolCallId: part.id, toolName: part.name, input: part.input }]
  return []
}

function toToolPromptPart(part: Message["content"][number]): Array<ToolPromptPart> {
  if (part.type !== "tool-result") return []
  return [{ type: "tool-result", toolCallId: part.id, toolName: part.name, output: toToolOutput(part.result) }]
}

function toToolOutput(result: ToolResultValue) {
  if (result.type === "text") return { type: "text" as const, value: String(result.value) }
  if (result.type === "error") return { type: "error-text" as const, value: String(result.value) }
  if (result.type === "content") {
    return {
      type: "content" as const,
      value: result.value.flatMap((part: ToolContent) =>
        part.type === "text" ? [{ type: "text" as const, text: part.text }] : [],
      ),
    }
  }
  return { type: "json" as const, value: toJsonValue(result.value) ?? null }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue }

function toProviderOptions(
  value: LLMRequest["providerOptions"],
): Record<string, Record<string, JsonValue>> | undefined {
  if (!value) return undefined
  const options: Record<string, Record<string, JsonValue>> = {}
  for (const [provider, fields] of Object.entries(value)) {
    const jsonFields = Object.fromEntries(
      Object.entries(fields).flatMap(([key, field]) => {
        const json = toJsonValue(field)
        return json === undefined ? [] : [[key, json]]
      }),
    )
    options[provider] = jsonFields
  }
  return options
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
    return value
  if (Array.isArray(value)) {
    const values = value.map(toJsonValue)
    return values.every((item): item is JsonValue => item !== undefined) ? values : undefined
  }
  if (typeof value !== "object") return undefined
  const object = Object.fromEntries(
    Object.entries(value).flatMap(([key, field]) => {
      const json = toJsonValue(field)
      return json === undefined ? [] : [[key, json]]
    }),
  )
  return object
}

function toEvents(part: StreamPart, toolNames: Map<string, string>, request: LLMRequest): LLMEvent[] {
  switch (part.type) {
    case "stream-start":
      for (const warning of part.warnings) {
        if (warning.type === "other") continue
        const schema = request.responseFormat?.type === "json" && /^responseFormat(?:\.|$)/.test(warning.feature)
        const choice = (request.responseFormat?.type === "tool"
          || request.toolChoice?.type === "tool" || request.toolChoice?.type === "required")
          && /^(?:toolChoice|tools)(?:\.|$)/.test(warning.feature)
        if (schema || choice)
          throw new Error("AI SDK discarded a requested structured-output transport constraint")
      }
      return [LLMEvent.stepStart({ index: 0 })]
    case "text-start":
      return [LLMEvent.textStart({ id: part.id, providerMetadata: part.providerMetadata })]
    case "text-delta":
      return [LLMEvent.textDelta({ id: part.id, text: part.delta, providerMetadata: part.providerMetadata })]
    case "text-end":
      return [LLMEvent.textEnd({ id: part.id, providerMetadata: part.providerMetadata })]
    case "reasoning-start":
      return [LLMEvent.reasoningStart({ id: part.id, providerMetadata: part.providerMetadata })]
    case "reasoning-delta":
      return [LLMEvent.reasoningDelta({ id: part.id, text: part.delta, providerMetadata: part.providerMetadata })]
    case "reasoning-end":
      return [LLMEvent.reasoningEnd({ id: part.id, providerMetadata: part.providerMetadata })]
    case "tool-input-start":
      toolNames.set(part.id, part.toolName)
      return [LLMEvent.toolInputStart({ id: part.id, name: part.toolName, providerMetadata: part.providerMetadata })]
    case "tool-input-delta":
      return [LLMEvent.toolInputDelta({ id: part.id, name: toolNames.get(part.id) ?? "", text: part.delta })]
    case "tool-input-end":
      return [
        LLMEvent.toolInputEnd({
          id: part.id,
          name: toolNames.get(part.id) ?? "",
          providerMetadata: part.providerMetadata,
        }),
      ]
    case "tool-call":
      toolNames.delete(part.toolCallId)
      return [
        LLMEvent.toolCall({
          id: part.toolCallId,
          name: part.toolName,
          input: parseJson(part.input),
          providerExecuted: part.providerExecuted,
          providerMetadata: part.providerMetadata,
        }),
      ]
    case "tool-result":
      return [
        LLMEvent.toolResult({
          id: part.toolCallId,
          name: part.toolName,
          result: ToolResultValue.make(part.result, part.isError ? "error" : "json"),
          providerMetadata: part.providerMetadata,
        }),
      ]
    case "finish":
      const finish = {
        reason: finishReason(part.finishReason.unified),
        usage: toUsage(part.usage, part.providerMetadata),
        providerMetadata: part.providerMetadata,
      }
      return [LLMEvent.stepFinish({ index: 0, ...finish }), LLMEvent.finish(finish)]
    case "error":
      return [providerError(part.error, request)]
    default:
      return []
  }
}

export function toUsage(
  usage: Extract<StreamPart, { type: "finish" }>["usage"],
  providerMetadata: Extract<StreamPart, { type: "finish" }>["providerMetadata"],
) {
  if (!usage) return undefined
  const inputTokens = usage.inputTokens.total
  const outputTokens = usage.outputTokens.total
  // OpenAI-compatible SDKs synthesize cacheRead=0 when the wire response omitted
  // cached_tokens. That is not measured cache usage. Preserve unknown just as the
  // native Chat adapter does; an explicit wire zero remains a valid measurement.
  const raw = usage.raw
  const openAIUsage = raw && ("prompt_tokens" in raw || ("input_tokens" in raw && !("cache_read_input_tokens" in raw)))
  const details = raw && "prompt_tokens" in raw ? raw.prompt_tokens_details : raw?.input_tokens_details
  const cacheRead = openAIUsage
    ? details && typeof details === "object" && !Array.isArray(details) && typeof details.cached_tokens === "number"
      ? details.cached_tokens
      : undefined
    : usage.inputTokens.cacheRead
  return {
    inputTokens,
    outputTokens,
    nonCachedInputTokens: usage.inputTokens.noCache,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: usage.inputTokens.cacheWrite,
    reasoningTokens: usage.outputTokens.reasoning,
    totalTokens: inputTokens === undefined || outputTokens === undefined ? undefined : inputTokens + outputTokens,
    providerMetadata,
  }
}

function parseJson(input: string) {
  try {
    return JSON.parse(input) as unknown
  } catch {
    return input
  }
}

function providerError(error: unknown, request: LLMRequest) {
  const candidates = AIChain.errorCandidatesForNormalization(error)
  const secrets = Object.entries(request.http?.headers ?? {}).flatMap(([name, value]) =>
    /authorization|api[-_]?key|token|secret|credential/i.test(name) ? [value, value.replace(/^Bearer\s+/i, "")] : [],
  )
  candidates.forEach((candidate) => {
    if (!candidate || typeof candidate !== "object" || !("url" in candidate)) return
    if (typeof candidate.url !== "string" || !URL.canParse(candidate.url)) return
    new URL(candidate.url).searchParams.forEach((value, name) => {
      if (/^(?:key|sig)$|api[-_]?key|token|secret|credential|signature/i.test(name))
        secrets.push(value, encodeURIComponent(value))
    })
  })
  const statusCode = candidates.map(AIChain.statusCodeForNormalization).find((status) => status !== undefined)
  const headers = candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || !("responseHeaders" in candidate)) return []
    if (!candidate.responseHeaders || typeof candidate.responseHeaders !== "object") return []
    return Object.entries(candidate.responseHeaders).flatMap(([name, value]) =>
      typeof value === "string" ? [[name.toLowerCase(), value] as const] : [],
    )
  })
  // Keep scheduling and request diagnostics, not cookies, credentials, arbitrary
  // provider metadata, request URLs or request bodies from APICallError.
  const responseHeaders = Object.fromEntries(
    headers.filter(([name]) =>
      /^(?:retry-after(?:-ms)?|x-request-id|request-id|x-ratelimit-[\w-]+|anthropic-ratelimit-[\w-]+)$/.test(name),
    ),
  )
  const responseBody = candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || !("responseBody" in candidate)) return []
    return typeof candidate.responseBody === "string" ? [candidate.responseBody] : []
  })[0]
  const message =
    error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message
      : String(error)
  const detail = {
    message: RequestExecutor.redactProviderText(message, secrets).slice(0, 4000),
    statusCode,
    responseHeaders,
    responseBody:
      responseBody === undefined
        ? undefined
        : RequestExecutor.redactProviderText(responseBody, secrets).slice(0, 16_384),
    retryAfterMs: RequestExecutor.retryAfterMs(responseHeaders),
  }
  const failure = AIChain.providerFailure(error)
  const sdkRetryable = candidates.some(
    (candidate) =>
      candidate && typeof candidate === "object" && "isRetryable" in candidate && candidate.isRetryable === true,
  )
  const sdkTerminal = candidates.some(
    (candidate) =>
      candidate && typeof candidate === "object" && "isRetryable" in candidate && candidate.isRetryable === false,
  )
  return LLMEvent.providerError({
    ...detail,
    retryable:
      !sdkTerminal &&
      !AIChain.hasNonRetryableHttpStatus(error) &&
      !AIChain.isAbortError(error) &&
      (failure.retryability === "auto-retry" || (failure.code === "internal.defect" && sdkRetryable)),
  })
}

function finishReason(reason: string): FinishReason {
  if (reason === "stop" || reason === "length" || reason === "tool-calls" || reason === "content-filter") return reason
  if (reason === "error") return "error"
  return "unknown"
}
