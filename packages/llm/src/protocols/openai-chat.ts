import { Effect, Schema } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { Framing } from "../route/framing"
import { HttpTransport } from "../route/transport"
import { Protocol } from "../route/protocol"
import {
  LLMEvent,
  Usage,
  type FinishReason,
  type LLMRequest,
  type MediaPart,
  type ReasoningPart,
  type TextPart,
  type ToolCallPart,
  type ToolDefinition,
  type ToolContent,
} from "../schema"
import { isRecord, JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared"
import { OpenAIOptions } from "./utils/openai-options"
import { Lifecycle } from "./utils/lifecycle"
import { ToolStream } from "./utils/tool-stream"

const ADAPTER = "openai-chat"
const IMAGE_MIMES = new Set<string>(ProviderShared.IMAGE_MIMES)
export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const PATH = "/chat/completions"

// =============================================================================
// Request Body Schema
// =============================================================================
// The body schema is the provider-native JSON body. `fromRequest` below builds
// this shape from the common `LLMRequest`, then `Route.make` validates and
// JSON-encodes it before transport.
const OpenAIChatFunction = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: JsonObject,
})

const OpenAIChatTool = Schema.Struct({
  type: Schema.tag("function"),
  function: OpenAIChatFunction,
})
type OpenAIChatTool = Schema.Schema.Type<typeof OpenAIChatTool>

const OpenAIChatAssistantToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.tag("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
})
type OpenAIChatAssistantToolCall = Schema.Schema.Type<typeof OpenAIChatAssistantToolCall>

const OpenAIChatUserContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("image_url"),
    image_url: Schema.Struct({ url: Schema.String }),
  }),
])

const OpenAIChatMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("system"), content: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Union([Schema.String, Schema.Array(OpenAIChatUserContent)]),
  }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.NullOr(Schema.String),
    tool_calls: optionalArray(OpenAIChatAssistantToolCall),
    reasoning_content: Schema.optional(Schema.String),
    reasoning: Schema.optional(Schema.String),
  }),
  Schema.Struct({ role: Schema.Literal("tool"), tool_call_id: Schema.String, content: Schema.String }),
]).pipe(Schema.toTaggedUnion("role"))
type OpenAIChatMessage = Schema.Schema.Type<typeof OpenAIChatMessage>

const OpenAIChatToolChoice = Schema.Union([
  Schema.Literals(["auto", "none", "required"]),
  Schema.Struct({
    type: Schema.tag("function"),
    function: Schema.Struct({ name: Schema.String }),
  }),
])

export const bodyFields = {
  model: Schema.String,
  messages: Schema.Array(OpenAIChatMessage),
  tools: optionalArray(OpenAIChatTool),
  tool_choice: Schema.optional(OpenAIChatToolChoice),
  stream: Schema.Literal(true),
  stream_options: Schema.optional(Schema.Struct({ include_usage: Schema.Boolean })),
  store: Schema.optional(Schema.Boolean),
  reasoning_effort: Schema.optional(OpenAIOptions.OpenAIReasoningEffort),
  max_tokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  frequency_penalty: Schema.optional(Schema.Number),
  presence_penalty: Schema.optional(Schema.Number),
  seed: Schema.optional(Schema.Number),
  stop: optionalArray(Schema.String),
}
const OpenAIChatBody = Schema.Struct(bodyFields)
export type OpenAIChatBody = Schema.Schema.Type<typeof OpenAIChatBody>

// =============================================================================
// Streaming Event Schema
// =============================================================================
// The event schema is one decoded SSE `data:` payload. `Framing.sse` splits the
// byte stream into strings, then `Protocol.jsonEvent` decodes each string into
// this provider-native event shape.
const OpenAIChatUsage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number),
  completion_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
  prompt_tokens_details: optionalNull(
    Schema.Struct({
      cached_tokens: Schema.optional(Schema.Number),
    }),
  ),
  completion_tokens_details: optionalNull(
    Schema.Struct({
      reasoning_tokens: Schema.optional(Schema.Number),
    }),
  ),
})

const OpenAIChatToolCallDeltaFunction = Schema.Struct({
  name: optionalNull(Schema.String),
  arguments: optionalNull(Schema.String),
})

const OpenAIChatToolCallDelta = Schema.Struct({
  index: Schema.Number,
  id: optionalNull(Schema.String),
  function: optionalNull(OpenAIChatToolCallDeltaFunction),
})
type OpenAIChatToolCallDelta = Schema.Schema.Type<typeof OpenAIChatToolCallDelta>

const OpenAIChatDelta = Schema.Struct({
  content: optionalNull(Schema.String),
  reasoning_content: optionalNull(Schema.String),
  reasoning: optionalNull(Schema.String),
  tool_calls: optionalNull(Schema.Array(OpenAIChatToolCallDelta)),
})

const OpenAIChatChoice = Schema.Struct({
  delta: optionalNull(OpenAIChatDelta),
  finish_reason: optionalNull(Schema.String),
})

const OpenAIChatEvent = Schema.Struct({
  choices: Schema.Array(OpenAIChatChoice),
  usage: optionalNull(OpenAIChatUsage),
})
type OpenAIChatEvent = Schema.Schema.Type<typeof OpenAIChatEvent>
type OpenAIChatRequestMessage = LLMRequest["messages"][number]

export interface ParserState {
  readonly tools: ToolStream.State<number>
  readonly toolCallEvents: ReadonlyArray<LLMEvent>
  readonly hasOutput: boolean
  readonly usage?: Usage
  readonly finishReason?: FinishReason
  readonly lifecycle: Lifecycle.State
  readonly completed: boolean
  /**
   * Tool call fragments whose provider index has not received a full id+name
   * identity yet. Some OpenAI-compatible proxies stream argument deltas for an
   * index they never introduce; buffering keeps identity split across chunks
   * recoverable, and leftovers at stream end are reported by `finishEvents`
   * instead of aborting the whole stream.
   */
  readonly pendingToolCalls?: Readonly<Record<number, { readonly id?: string; readonly name?: string; readonly text: string }>>
}

const invalid = ProviderShared.invalidRequest

// =============================================================================
// Request Lowering
// =============================================================================
// Lowering is the only place that knows how common LLM messages map onto the
// OpenAI Chat wire format. Keep provider quirks here instead of leaking native
// fields into `LLMRequest`.
const lowerTool = (tool: ToolDefinition): OpenAIChatTool => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: ProviderShared.openAiToolInputSchema(tool.inputSchema),
  },
})

const lowerToolChoice = (toolChoice: NonNullable<LLMRequest["toolChoice"]>) =>
  ProviderShared.matchToolChoice("OpenAI Chat", toolChoice, {
    auto: () => "auto" as const,
    none: () => "none" as const,
    required: () => "required" as const,
    tool: (name) => ({ type: "function" as const, function: { name } }),
  })

const lowerToolCall = (part: ToolCallPart): OpenAIChatAssistantToolCall => ({
  id: part.id,
  type: "function",
  function: {
    name: part.name,
    arguments: ProviderShared.encodeJson(part.input),
  },
})

const lowerMedia = Effect.fn("OpenAIChat.lowerMedia")(function* (part: MediaPart) {
  const media = yield* ProviderShared.validateMedia("OpenAI Chat", part, IMAGE_MIMES)
  return { type: "image_url" as const, image_url: { url: media.dataUrl } }
})

const openAICompatibleReasoningContent = (native: unknown) => {
  if (!isRecord(native)) return undefined
  return [native.reasoning_content, native.reasoning].find((value): value is string => typeof value === "string")
}

const lowerUserMessage = Effect.fn("OpenAIChat.lowerUserMessage")(function* (message: OpenAIChatRequestMessage) {
  const content: Array<Schema.Schema.Type<typeof OpenAIChatUserContent>> = []
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text })
      continue
    }
    if (part.type === "media") {
      content.push(yield* lowerMedia(part))
      continue
    }
    return yield* ProviderShared.unsupportedContent("OpenAI Chat", "user", ["text", "media"])
  }
  if (content.every((part) => part.type === "text"))
    return { role: "user" as const, content: content.map((part) => part.text).join("") }
  return { role: "user" as const, content }
})

const lowerAssistantMessage = Effect.fn("OpenAIChat.lowerAssistantMessage")(function* (
  message: OpenAIChatRequestMessage,
  reasoningField: "reasoning_content" | "reasoning",
) {
  const content: TextPart[] = []
  const reasoning: ReasoningPart[] = []
  const toolCalls: OpenAIChatAssistantToolCall[] = []
  for (const part of message.content) {
    if (!ProviderShared.supportsContent(part, ["text", "reasoning", "tool-call"]))
      return yield* ProviderShared.unsupportedContent("OpenAI Chat", "assistant", ["text", "reasoning", "tool-call"])
    if (part.type === "text") {
      content.push(part)
      continue
    }
    if (part.type === "reasoning") {
      reasoning.push(part)
      continue
    }
    if (part.type === "tool-call") {
      toolCalls.push(lowerToolCall(part))
      continue
    }
  }
  const lowered = {
    role: "assistant" as const,
    content: content.length === 0 ? null : ProviderShared.joinText(content),
    tool_calls: toolCalls.length === 0 ? undefined : toolCalls,
  }
  const reasoningText =
    reasoning.length > 0
      ? reasoning.map((part) => part.text).join("")
      : openAICompatibleReasoningContent(message.native?.openaiCompatible)
  if (reasoningText === undefined) return lowered
  if (reasoningField === "reasoning") return { ...lowered, reasoning: reasoningText }
  return { ...lowered, reasoning_content: reasoningText }
})

const lowerToolMessages = Effect.fn("OpenAIChat.lowerToolMessages")(function* (message: OpenAIChatRequestMessage) {
  const messages: OpenAIChatMessage[] = []
  const images: Array<Schema.Schema.Type<typeof OpenAIChatUserContent>> = []
  for (const part of message.content) {
    if (!ProviderShared.supportsContent(part, ["tool-result"]))
      return yield* ProviderShared.unsupportedContent("OpenAI Chat", "tool", ["tool-result"])
    if (part.result.type !== "content") {
      messages.push({ role: "tool", tool_call_id: part.id, content: ProviderShared.toolResultText(part) })
      continue
    }
    const content: ReadonlyArray<ToolContent> = part.result.value
    const text = content.filter((item) => item.type === "text").map((item) => item.text)
    messages.push({ role: "tool", tool_call_id: part.id, content: text.join("\n") })
    const files = content.filter((item) => item.type === "file")
    images.push(
      ...(yield* Effect.forEach(files, (item) =>
        lowerMedia({ type: "media", mediaType: item.mime, data: item.uri, filename: item.name }),
      )),
    )
  }
  return { messages, images }
})

const lowerMessage = Effect.fn("OpenAIChat.lowerMessage")(function* (
  message: OpenAIChatRequestMessage,
  reasoningField: "reasoning_content" | "reasoning",
) {
  if (message.role === "user") return [yield* lowerUserMessage(message)]
  if (message.role === "assistant") return [yield* lowerAssistantMessage(message, reasoningField)]
  return (yield* lowerToolMessages(message)).messages
})

const lowerMessages = Effect.fn("OpenAIChat.lowerMessages")(function* (
  request: LLMRequest,
  reasoningField: "reasoning_content" | "reasoning",
) {
  const system: OpenAIChatMessage[] =
    request.system.length === 0 ? [] : [{ role: "system", content: ProviderShared.joinText(request.system) }]
  const messages = [...system]
  const pendingImages: Array<Schema.Schema.Type<typeof OpenAIChatUserContent>> = []
  const flushImages = () => {
    if (pendingImages.length === 0) return
    messages.push({ role: "user", content: pendingImages.splice(0) })
  }
  for (const message of request.messages) {
    if (message.role === "system") {
      const part = yield* ProviderShared.wrappedSystemUpdate("OpenAI Chat", message)
      if (pendingImages.length > 0) {
        messages.push({ role: "user", content: [...pendingImages.splice(0), { type: "text", text: part.text }] })
        continue
      }
      const previous = messages.at(-1)
      if (previous?.role === "user" && typeof previous.content === "string")
        messages[messages.length - 1] = { role: "user", content: `${previous.content}\n${part.text}` }
      else if (previous?.role === "user" && Array.isArray(previous.content))
        messages[messages.length - 1] = {
          role: "user",
          content: [...previous.content, { type: "text", text: part.text }],
        }
      else messages.push({ role: "user", content: part.text })
      continue
    }
    if (message.role === "tool") {
      const lowered = yield* lowerToolMessages(message)
      messages.push(...lowered.messages)
      pendingImages.push(...lowered.images)
      continue
    }
    flushImages()
    messages.push(...(yield* lowerMessage(message, reasoningField)))
  }
  flushImages()
  return messages
})

const lowerOptions = Effect.fn("OpenAIChat.lowerOptions")(function* (request: LLMRequest, includeStore: boolean) {
  const store = includeStore ? OpenAIOptions.store(request) : undefined
  const reasoningEffort = OpenAIOptions.reasoningEffort(request)
  if (reasoningEffort && !OpenAIOptions.isReasoningEffort(reasoningEffort))
    return yield* invalid(`OpenAI Chat does not support reasoning effort ${reasoningEffort}`)
  return {
    ...(store !== undefined ? { store } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  }
})

const fromRequest = Effect.fn("OpenAIChat.fromRequest")(function* (
  request: LLMRequest,
  options: OpenAIChatProtocolOptions,
) {
  // `fromRequest` returns the provider body only. Endpoint, auth, framing,
  // validation, and HTTP execution are composed by `Route.make`.
  const generation = request.generation
  return {
    model: request.model.id,
    messages: yield* lowerMessages(request, options.reasoningField),
    tools: request.tools.length === 0 ? undefined : request.tools.map(lowerTool),
    tool_choice: request.toolChoice ? yield* lowerToolChoice(request.toolChoice) : undefined,
    stream: true as const,
    stream_options: options.includeUsage ? { include_usage: true } : undefined,
    max_tokens: generation?.maxTokens,
    temperature: generation?.temperature,
    top_p: generation?.topP,
    frequency_penalty: generation?.frequencyPenalty,
    presence_penalty: generation?.presencePenalty,
    seed: generation?.seed,
    stop: generation?.stop,
    ...(yield* lowerOptions(request, options.includeStore)),
  }
})

// =============================================================================
// Stream Parsing
// =============================================================================
// Streaming parsers are small state machines: every event returns a new state
// plus the common `LLMEvent`s produced by that event. Tool calls are accumulated
// because OpenAI streams JSON arguments across multiple deltas.
const mapFinishReason = (reason: string | null | undefined): FinishReason => {
  if (reason === "stop") return "stop"
  if (reason === "length") return "length"
  if (reason === "content_filter") return "content-filter"
  if (reason === "function_call" || reason === "tool_calls") return "tool-calls"
  return "unknown"
}

// OpenAI Chat reports `prompt_tokens` (inclusive total) with a
// `cached_tokens` subset, and `completion_tokens` (inclusive total) with
// a `reasoning_tokens` subset. We pass the inclusive totals through and
// derive the non-cached breakdown so the `LLM.Usage` contract is
// satisfied on both sides.
const mapUsage = (usage: OpenAIChatEvent["usage"]): Usage | undefined => {
  if (!usage) return undefined
  const cached = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  const nonCached = ProviderShared.subtractTokens(usage.prompt_tokens, cached)
  return new Usage({
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: cached,
    reasoningTokens: reasoning,
    totalTokens: ProviderShared.totalTokens(usage.prompt_tokens, usage.completion_tokens, usage.total_tokens),
    providerMetadata: { openai: usage },
  })
}

const OpenAIChatStreamEvent = Schema.Union([Protocol.jsonEvent(OpenAIChatEvent), Schema.Literal("[DONE]")])
type OpenAIChatStreamEvent = Schema.Schema.Type<typeof OpenAIChatStreamEvent>

const step = (state: ParserState, event: OpenAIChatStreamEvent) =>
  Effect.gen(function* () {
    if (event === "[DONE]") {
      const hasTools = Object.keys(state.tools).length > 0
      const finished = hasTools ? yield* ToolStream.finishAll(ADAPTER, state.tools) : undefined
      return [
        {
          ...state,
          tools: finished?.tools ?? state.tools,
          toolCallEvents: finished?.events ?? state.toolCallEvents,
          finishReason: state.finishReason ?? (hasTools ? "tool-calls" : "stop"),
          completed: true,
        },
        [],
      ] as const
    }
    const events: LLMEvent[] = []
    const usage = mapUsage(event.usage) ?? state.usage
    const choice = event.choices[0]
    const finishReason = choice?.finish_reason ? mapFinishReason(choice.finish_reason) : state.finishReason
    const delta = choice?.delta
    const toolDeltas = delta?.tool_calls ?? []
    let tools = state.tools
    let pendingToolCalls = state.pendingToolCalls ?? {}
    const reasoning = delta?.reasoning_content ?? delta?.reasoning
    let hasOutput = state.hasOutput || Boolean(delta?.content || reasoning)

    let lifecycle = state.lifecycle

    if (reasoning) lifecycle = Lifecycle.reasoningDelta(lifecycle, events, "reasoning-0", reasoning)

    if (delta?.content) lifecycle = Lifecycle.textDelta(lifecycle, events, "text-0", delta.content)

    for (const tool of toolDeltas) {
      const current = tools[tool.index]
      const buffered = pendingToolCalls[tool.index]
      const id = tool.id ?? buffered?.id ?? current?.id
      const name = tool.function?.name ?? buffered?.name ?? current?.name
      const text = `${buffered?.text ?? ""}${tool.function?.arguments ?? ""}`
      if (!id || !name) {
        // The provider has not identified this tool index yet. Buffer the
        // fragment instead of aborting the stream: some OpenAI-compatible
        // proxies split identity across chunks or never send it at all.
        pendingToolCalls = { ...pendingToolCalls, [tool.index]: { id, name, text } }
        continue
      }
      if (buffered) {
        const remaining = { ...pendingToolCalls }
        delete remaining[tool.index]
        pendingToolCalls = remaining
      }
      const result = ToolStream.appendOrStart(
        ADAPTER,
        tools,
        tool.index,
        { id, name, text },
        "OpenAI Chat tool call delta is missing id or name",
      )
      if (ToolStream.isError(result)) return yield* result
      tools = result.tools
      if (result.events.length) lifecycle = Lifecycle.stepStart(lifecycle, events)
      if (result.events.length) hasOutput = true
      events.push(...result.events)
    }

    // Finalize accumulated tool inputs eagerly when finish_reason arrives so
    // unparsable tool arguments surface as tool-error events at the boundary
    // instead of aborting the stream at halt.
    const finished =
      finishReason !== undefined && state.finishReason === undefined && Object.keys(tools).length > 0
        ? yield* ToolStream.finishAll(ADAPTER, tools)
        : undefined

    return [
      {
        tools: finished?.tools ?? tools,
        toolCallEvents: finished?.events ?? state.toolCallEvents,
        hasOutput,
        usage,
        finishReason,
        lifecycle,
        completed: state.completed,
        ...(Object.keys(pendingToolCalls).length > 0 ? { pendingToolCalls } : {}),
      },
      events,
    ] as const
  })

const finishEvents = (state: ParserState): ReadonlyArray<LLMEvent> => {
  const events: LLMEvent[] = []
  if (!state.completed) {
    // Premature stream termination (connection dropped before [DONE]) is a
    // transient provider-side failure. Mark as retryable so the session runner
    // can re-issue the request. The runner's retryBarrier guard prevents a
    // retry when text/reasoning/tool content was already published, so there
    // is no risk of duplicating partial output.
    events.push(
      LLMEvent.providerError({
        message: state.finishReason
          ? "OpenAI Chat stream ended without an explicit [DONE] marker"
          : "OpenAI Chat stream ended without a finish reason",
        retryable: true,
      }),
    )
    return events
  }
  const hasToolCalls = state.toolCallEvents.length > 0
  const reason = state.finishReason === "stop" && hasToolCalls ? "tool-calls" : state.finishReason
  if (!reason) {
    events.push(
      LLMEvent.providerError({
        message: "OpenAI Chat stream ended without a finish reason",
        retryable: true,
      }),
    )
    return events
  }
  if (
    Object.keys(state.pendingToolCalls ?? {}).length > 0 &&
    !state.hasOutput &&
    !hasToolCalls
  ) {
    // The provider streamed a tool call it never identified with an id and
    // name, and the step produced nothing else usable. Report a retryable
    // provider failure instead of ending silently. With text or a valid tool
    // call present the unidentifiable fragment is droppable noise and the
    // step completes with its usable content.
    events.push(
      LLMEvent.providerError({
        message: "OpenAI Chat provider sent a tool call without an id or name",
        retryable: true,
      }),
    )
    return events
  }
  if (reason === "stop" && !state.hasOutput) {
    events.push(
      LLMEvent.providerError({
        message: "OpenAI Chat provider returned stop without assistant content or a tool call",
        retryable: true,
      }),
    )
    return events
  }
  const lifecycle = state.toolCallEvents.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
  events.push(...state.toolCallEvents)
  Lifecycle.finish(lifecycle, events, { reason, usage: state.usage })
  return events
}

// =============================================================================
// Protocol And OpenAI Route
// =============================================================================
/**
 * The OpenAI Chat protocol — request body construction, body schema, and the
 * streaming-event state machine. Reused by every route that speaks OpenAI Chat
 * over HTTP+SSE: native OpenAI, DeepSeek, TogetherAI, Cerebras, Baseten,
 * Fireworks, DeepInfra, and (once added) Azure OpenAI Chat.
 */
interface OpenAIChatProtocolOptions {
  readonly reasoningField: "reasoning_content" | "reasoning"
  readonly includeUsage: boolean
  readonly includeStore: boolean
}

const makeProtocol = (options: OpenAIChatProtocolOptions) =>
  Protocol.make({
    id: ADAPTER,
    body: {
      schema: OpenAIChatBody,
      from: (request) => fromRequest(request, options),
    },
    stream: {
      event: OpenAIChatStreamEvent,
      initial: () => ({
        tools: ToolStream.empty<number>(),
        toolCallEvents: [],
        hasOutput: false,
        lifecycle: Lifecycle.initial(),
        completed: false,
      }),
      step,
      terminal: (event) => event === "[DONE]",
      onHalt: finishEvents,
    },
  })

export const protocol = makeProtocol({ reasoningField: "reasoning_content", includeUsage: true, includeStore: true })
export const cerebrasProtocol = makeProtocol({ reasoningField: "reasoning", includeUsage: false, includeStore: false })

export const httpTransport = HttpTransport.httpJson<OpenAIChatBody, string>({ framing: Framing.sseWithDone })

export const route = Route.make({
  id: ADAPTER,
  provider: "openai",
  protocol,
  endpoint: Endpoint.path(PATH, { baseURL: DEFAULT_BASE_URL }),
  auth: Auth.none,
  transport: httpTransport,
})

export * as OpenAIChat from "./openai-chat"
