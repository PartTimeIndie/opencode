export * as SessionCompaction from "./compaction"

import { isContextOverflow, LLM, LLMError, LLMEvent, Message, type FinishReason, type LLMRequest, type Model } from "@opencode-ai/llm"
import { Cause, DateTime, Effect, Schema, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import type { MessageDecodeError } from "./error"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionResume } from "./resume"
import { Token } from "../util/token"
import { toLLMMessages } from "./runner/to-llm-message"
import { isProviderStreamInactivity, providerStreamIdleTimeouts, withProviderStreamIdleTimeout } from "./provider-stream"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const SUMMARY_RETRY_MIN_INPUT_TOKENS = 50_000
// Matches the session runner's provider retry budget: transient summary failures such as a
// stream that ends without a finish reason are retried before compaction gives up.
const SUMMARY_PROVIDER_RETRIES = 5
const SUMMARY_RETRY_MAX_DELAY_MS = 10_000
// A model may advertise a multi-million-token context, but assembling that much
// history in every concurrent local runner is still unsafe for the desktop sidecar.
// Compact before materializing tool outputs once this provider-facing history budget
// is reached; the durable session history remains complete.
// Do not impose a second host-side history ceiling. Provider/model context and
// input limits are resolved below; the durable session remains complete.
export const MAX_RUNNER_HISTORY_TOKENS = Number.POSITIVE_INFINITY

function summaryRetryDelayMs(error: { readonly retryAfterMs?: number }, attempt: number) {
  const retryAfterMs = error.retryAfterMs
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0)
    return retryAfterMs
  return Math.min(1_000 * Math.pow(2, attempt - 1), SUMMARY_RETRY_MAX_DELAY_MS)
}
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly buffer: number | undefined
  readonly tokens: number
  readonly turns?: number
  readonly quality: boolean
  readonly unlimited: boolean
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
  readonly streamIdleTimeouts?: ReturnType<typeof providerStreamIdleTimeouts>
  readonly loadCurrent?: (sessionID: SessionSchema.ID) => Effect.Effect<{
    readonly entries: readonly Entry[]
    readonly todos: readonly { readonly content: string; readonly status: string; readonly priority: string }[]
  }, MessageDecodeError>
  readonly fallbackModel?: (input: {
    readonly sessionID: SessionSchema.ID
    readonly model: Model
    readonly detached?: boolean
    readonly canSummarize: (model: Model) => boolean
  }) => Effect.Effect<Model | undefined>
}

type SummaryResult = { readonly summary?: string; readonly contextOverflow: boolean }

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
}

type AutomaticInput = Input & {
  readonly contextEstimateTokens: number
}

export function runnerHistoryTokenLimit(model: Model) {
  const limits = model.route.defaults.limits
  if (!limits) return MAX_RUNNER_HISTORY_TOKENS
  const context = limits.context !== undefined && limits.context > 0 ? limits.context : Infinity
  const input = limits.input !== undefined && limits.input > 0 ? limits.input : Infinity
  return Math.max(1, Math.min(context, input))
}

export function boundRunnerHistory(entries: readonly Entry[], maxTokens: number, model: Model) {
  // Durable tool state also contains UI/structured copies, snapshots and bookkeeping
  // that never enter the prompt. Budget the replay, one entry at a time, without
  // materializing attachments or allocating the full provider history here.
  const tokens = entries.map((entry) => Token.estimateFootprint(toLLMMessages([entry.message], model)))
  const estimatedTokens = tokens.reduce((total, value) => total + value, 0)
  if (estimatedTokens <= maxTokens) return { entries, omittedEntries: 0, estimatedTokens }

  let start = entries.length
  let retainedTokens = 0
  for (let index = entries.length - 1; index >= 0; index--) {
    const next = retainedTokens + tokens[index]
    if (start < entries.length && next > maxTokens) break
    start = index
    retainedTokens = next
  }

  return {
    entries: entries.slice(start),
    omittedEntries: start,
    estimatedTokens,
  }
}

// OpenAI Responses currently rejects very large requests before the catalog's
// advertised context window is exhausted because its hidden reasoning and tool
// envelope also consumes context. Keep room for that envelope so the runner
// compacts instead of turning a recoverable history overflow into a stream error.
const OPENAI_RESPONSES_INPUT_TOKEN_LIMIT = 400_000

export const inputTokenLimit = (input: Pick<AutomaticInput, "model" | "request">) => {
  const limits = input.model.route.defaults.limits
  const context = limits?.context
  const providerLimit =
    input.model.provider === "openai" && input.model.route.protocol === "openai-responses"
      ? OPENAI_RESPONSES_INPUT_TOKEN_LIMIT
      : undefined
  if (!limits) return providerLimit
  if (context === undefined || context <= 0) return providerLimit
  const requestedOutput = input.request.generation?.maxTokens
  // Catalog output limits describe capacity, not a reservation. Only an
  // explicit per-request maxTokens value reduces the available input budget.
  const contextLimit = context - (requestedOutput ?? 0)
  return Math.max(0, Math.min(contextLimit, limits.input ?? Infinity, providerLimit ?? Infinity))
}

export const outputTokenReserve = (input: Pick<AutomaticInput, "model" | "request">) => {
  return input.request.generation?.maxTokens ?? 0
}

function inputTokenBuffer(limit: number, configured?: number) {
  // A fixed 20k reserve can consume most of a local model's input window.
  return configured ?? Math.min(DEFAULT_BUFFER, Math.floor(limit * 0.1))
}

export const exceedsInputTokenLimit = (input: AutomaticInput) => {
  const limit = inputTokenLimit(input)
  return limit !== undefined && input.contextEstimateTokens > limit
}

const truncate = (value: string) => value

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        if (part.type === "custom") return []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

const serializeTodos = (
  todos: readonly { readonly content: string; readonly status: string; readonly priority: string }[],
) =>
  todos.length === 0
    ? ""
    : ["[Durable todo state]", ...todos.map((todo) => `- [${todo.status}] (${todo.priority}) ${todo.content}`)].join(
        "\n",
      )

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  const result = configured.reduce<Settings>(
    (result, current) => ({
      unlimited: current.unlimited ?? result.unlimited,
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
      turns: current.keep?.turns ?? result.turns,
      quality: current.quality ?? result.quality,
    }),
    { auto: true, buffer: undefined, tokens: DEFAULT_KEEP_TOKENS, quality: false, unlimited: false },
  )
  // `unlimited` governs durable history retention only. The summarizer
  // selection budget must stay finite and provider-compatible so an overflow
  // always yields a real provider compaction attempt with a recent tail —
  // never the whole retained history as one unbounded head.
  return result
}

export class SummaryFailed extends Schema.TaggedErrorClass<SummaryFailed>()("SessionCompactionSummaryFailed", {
  sessionID: SessionSchema.ID,
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

const select = (
  entries: readonly Entry[],
  tokens: number,
  turns?: number,
): { readonly head: string; readonly recent: string } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => ({
      text: serialize(entry.message),
      tokens: Token.estimateFootprint(entry.message),
      user: entry.message.type === "user",
    }))
    .filter((entry) => entry.text.length > 0)
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  let splitPrefix = ""
  let splitSuffix = ""
  let splitMessage = false
  for (let index = conversation.length - 1; index >= 0; index--) {
    const visible = Token.estimate(conversation[index].text)
    const next = total + Math.max(visible, conversation[index].tokens)
    if (next > tokens) {
      const remaining = Math.max(0, tokens - total) * 4
      if (visible <= tokens - total) {
        split = index + 1
        break
      }
      if (remaining > 0) {
        splitPrefix = conversation[index].text.slice(0, -remaining)
        splitSuffix = conversation[index].text.slice(-remaining)
        split = index
        splitMessage = true
      }
      break
    }
    total = next
    split = index
  }
  if (turns !== undefined) {
    const users = conversation.flatMap((entry, index) => (entry.user ? [index] : []))
    const containingTurn = users.findLast((index) => index <= split)
    const minimumTurn = turns === 0 ? undefined : users.at(-turns)
    split = Math.min(split, containingTurn ?? split, minimumTurn ?? split)
    splitPrefix = ""
    splitSuffix = ""
    splitMessage = false
  }
  return {
    head: [...conversation.slice(0, split).map((entry) => entry.text), splitPrefix].filter(Boolean).join("\n\n"),
    recent: [splitSuffix, ...conversation.slice(splitMessage ? split + 1 : split).map((entry) => entry.text)]
      .filter(Boolean)
      .join("\n\n"),
  }
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

function buildPromptWithinLimit(input: {
  readonly previousSummary?: string
  readonly context: readonly string[]
  readonly limit: number
}) {
  const base = buildPrompt({ previousSummary: input.previousSummary, context: [] })
  if (Token.estimate(base) > input.limit) return
  const remainingChars = Math.max(0, (input.limit - Token.estimate(base) - 2) * 4)
  const bounded = input.context.filter(Boolean).reduceRight(
    (result, value) => {
      const next = result.text ? `${value}\n\n${result.text}` : value
      if (next.length <= remainingChars) return { text: next, truncated: result.truncated }
      return { text: next.slice(-remainingChars), truncated: true }
    },
    { text: "", truncated: false },
  )
  const marker = "[Earlier context omitted because it exceeds this model's context window.]"
  const context = bounded.truncated
    ? `${marker}\n${bounded.text.slice(-Math.max(0, remainingChars - marker.length - 1))}`
    : bounded.text
  const prompt = buildPrompt({ previousSummary: input.previousSummary, context: [context].filter(Boolean) })
  if (Token.estimate(prompt) > input.limit) return
  return prompt
}

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const summarizeContext = Effect.fn("SessionCompaction.summarizeContext")(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly model: Model
    readonly previousSummary?: string
    readonly context: readonly string[]
    readonly limit: number
    readonly maxTokens?: number
  }) {
    const attempts = config.quality ? 2 : 1
    const summarize = Effect.fnUntraced(function* (
      limit: number,
      maxTokens?: number,
      attemptsRemaining = attempts,
      providerRetries = SUMMARY_PROVIDER_RETRIES,
    ): Effect.fn.Return<SummaryResult, SummaryFailed | LLMError> {
      const summaryPrompt = buildPromptWithinLimit({
        previousSummary: input.previousSummary,
        context: input.context,
        limit,
      })
      if (!summaryPrompt) return { contextOverflow: true }
      const chunks: string[] = []
      let finishReason: FinishReason | undefined
      let failed = false
      let overflow = false
      let unsupportedOutputLimit = false
      let retryableFailure: { readonly retryAfterMs?: number } | undefined
      const idleTimeouts = dependencies.streamIdleTimeouts ?? providerStreamIdleTimeouts(input.model)
      const summarized = yield* withProviderStreamIdleTimeout(
        dependencies.llm.stream(
          LLM.request({
            model: input.model,
            messages: [Message.user(summaryPrompt)],
            tools: [],
            generation: maxTokens === undefined ? undefined : { maxTokens },
          }),
        ),
        idleTimeouts.initialMs,
        idleTimeouts.afterProgressMs,
      ).pipe(
          Stream.runForEach((event) => {
            if (LLMEvent.is.providerError(event)) {
              failed = true
              overflow ||= event.classification === "context-overflow"
              unsupportedOutputLimit ||= rejectsOutputTokenLimit(event.message)
              if (event.retryable === true) retryableFailure = event
              return Effect.logWarning("session compaction summary provider error", {
                sessionID: input.sessionID,
                message: event.message,
                classification: event.classification,
                limit,
              })
            }
            if (LLMEvent.is.finish(event)) finishReason = event.reason
            if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
            return Effect.void
          }),
          Effect.as(true),
          Effect.catchTag("LLM.Error", (error) => {
            overflow =
              error.reason._tag === "InvalidRequest" &&
              (error.reason.classification === "context-overflow" || isContextOverflow(error.message))
            unsupportedOutputLimit = error.reason._tag === "InvalidRequest" && rejectsOutputTokenLimit(error.message)
            const warning = Effect.logWarning("session compaction summary stream failed", {
              sessionID: input.sessionID,
              error: error.message,
              limit,
            })
            if (isProviderStreamInactivity(error))
              return warning.pipe(
                Effect.andThen(
                  Effect.fail(
                    new SummaryFailed({
                      sessionID: input.sessionID,
                      reason: "the summary provider stream stalled before completion",
                    }),
                  ),
                ),
              )
            // The raw provider failure is authoritative over synthetic onHalt
            // events, especially non-retryable authentication/quota failures.
            retryableFailure = error.retryable === true ? error : undefined
            return warning.pipe(Effect.as(false))
          }),
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
            const error = Cause.squash(cause)
            if (!(finishReason !== undefined && error instanceof Error && error.name === "AbortError")) return Effect.failCause(cause)
            return Effect.logInfo("session compaction summary stream cleanup cancelled", {
              sessionID: input.sessionID,
              reason: "summary-stream-finished",
            }).pipe(Effect.as(true))
          }),
        )
      const summary = chunks.join("")
      const contextOverflow = overflow
      if (summarized && !failed && finishReason !== undefined && finishReason !== "stop")
        return yield* Effect.fail(new SummaryFailed({
          sessionID: input.sessionID,
          reason: `the summary provider did not complete successfully (finish reason: ${finishReason})`,
        }))
      if (summarized && !failed && finishReason === undefined && summary.trim())
        return yield* Effect.fail(new SummaryFailed({
          sessionID: input.sessionID,
          reason: "the summary provider stream ended before completion",
        }))
      if (summarized && !failed && summary.trim()) {
        if (!config.quality || validSummary(summary)) return { summary, contextOverflow: false }
        yield* Effect.logWarning("session compaction summary failed the structural quality gate", {
          sessionID: input.sessionID,
          attempts: attemptsRemaining,
        })
        if (attemptsRemaining > 1)
          return yield* summarize(limit, maxTokens, attemptsRemaining - 1, providerRetries)
        return { contextOverflow: false }
      }
      if (maxTokens !== undefined && unsupportedOutputLimit) {
        yield* Effect.logWarning("session compaction retrying without output token limit", {
          sessionID: input.sessionID,
        })
        return yield* summarize(limit, undefined, attemptsRemaining, providerRetries)
      }
      if (retryableFailure && providerRetries > 0) {
        const attempt = SUMMARY_PROVIDER_RETRIES - providerRetries + 1
        const delay = summaryRetryDelayMs(retryableFailure, attempt)
        if (!SessionResume.canWaitForRetry(delay))
          return yield* Effect.fail(new SummaryFailed({
            sessionID: input.sessionID,
            reason: `retry-deferred: automatic summary retry requires waiting ${delay}ms beyond the automatic wait limit`,
          }))
        yield* Effect.logWarning("session compaction retrying after transient summary failure", {
          sessionID: input.sessionID,
          attempt,
          retryInMs: delay,
        })
        yield* Effect.sleep(delay)
        return yield* summarize(limit, maxTokens, attemptsRemaining, providerRetries - 1)
      }
      // A clean stream close without usable text is not a successful summary,
      // whether or not the provider emitted an explicit finish event.
      if (summarized && !failed && summary.trim().length === 0) {
        return yield* Effect.fail(
          new SummaryFailed({
            sessionID: input.sessionID,
            reason: "the provider returned an empty summary without usable text",
          }),
        )
      }
      if (!overflow || limit <= SUMMARY_RETRY_MIN_INPUT_TOKENS) return { contextOverflow }
      return yield* summarize(
        Math.max(SUMMARY_RETRY_MIN_INPUT_TOKENS, Math.floor(limit / 2)),
        maxTokens,
        attemptsRemaining,
        providerRetries,
      )
    })
    return yield* summarize(input.limit, input.maxTokens, attempts, SUMMARY_PROVIDER_RETRIES)
  })
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (
    input: Input & {
      readonly contextEstimateTokens?: number
      readonly keepTokens?: number
      readonly keepTurns?: number | false
      readonly fallbackQuestionDetached?: boolean
    },
  ) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const current = dependencies.loadCurrent
      ? yield* dependencies.loadCurrent(input.sessionID)
      : { entries: input.entries, todos: [] }
    const summaryEntries = current.entries
    const selected = select(
      summaryEntries,
      input.keepTokens ?? config.tokens,
      input.keepTurns === false ? undefined : input.keepTurns ?? config.turns,
    )
    const previousSummary = summaryEntries.findLast((entry) => entry.message.type === "compaction")?.message
    const mandatory = requiresAutomaticCompaction({
      ...input,
      contextEstimateTokens: input.contextEstimateTokens ?? 0,
    })
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) {
      // Opportunistic preflight compaction may bow out when there is nothing
      // serializable to summarize. A mandatory compaction must still produce
      // a real provider attempt: requiresAutomaticCompaction stays true while
      // compactIfNeeded keeps returning false on every retry, so bowing out
      // here wedges the session with no recovery path.
      if (!mandatory) return false
    }
    const todoContext = serializeTodos(current.todos)
    const summaryContext = [
      previousSummary?.type === "compaction" ? previousSummary.recent : "",
      selected?.head ?? "",
      todoContext,
    ].filter(Boolean)
    const previousSummaryText = previousSummary?.type === "compaction" ? previousSummary.summary : undefined
    const summaryPlan = (model: Model, request: LLMRequest) => {
      const output = request.generation?.maxTokens ?? model.route.defaults.limits?.output ?? 0
      const summaryRequest = LLM.request({
        model,
        messages: [],
        tools: [],
        generation: { maxTokens: output || undefined },
      })
      const inputLimit = inputTokenLimit({ model, request: summaryRequest })
      if (inputLimit === undefined) return
      const limit = Math.max(0, inputLimit - inputTokenBuffer(inputLimit, config.buffer))
      const prompt = buildPromptWithinLimit({ previousSummary: previousSummaryText, context: summaryContext, limit })
      if (!prompt) return
      return { output: output || undefined, limit }
    }
    const canSummarize = (model: Model) => summaryPlan(model, LLM.request({ model, messages: [], tools: [] })) !== undefined
    const resolveFallback = (model: Model) =>
      dependencies.fallbackModel?.({
        sessionID: input.sessionID,
        model,
        detached: input.fallbackQuestionDetached,
        canSummarize,
      }) ?? Effect.succeed(undefined)
    const primaryPlan = summaryPlan(input.model, input.request)
    const fallback = primaryPlan ? undefined : yield* resolveFallback(input.model)
    const summarizer = fallback ?? input.model
    const request = fallback ? LLM.request({ model: fallback, messages: [], tools: [] }) : input.request
    const plan = fallback ? summaryPlan(fallback, request) : primaryPlan
    if (!plan) return false
    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
    })

    const result = yield* summarizeContext({
      sessionID: input.sessionID,
      model: summarizer,
      previousSummary: previousSummaryText,
      context: summaryContext,
      limit: plan.limit,
      maxTokens: plan.output,
    })
    const retryModel = !result.summary && result.contextOverflow && !fallback ? yield* resolveFallback(input.model) : undefined
    const retryRequest = retryModel ? LLM.request({ model: retryModel, messages: [], tools: [] }) : undefined
    const retryPlan = retryModel && retryRequest ? summaryPlan(retryModel, retryRequest) : undefined
    const retried = retryModel && retryPlan
      ? yield* summarizeContext({
          sessionID: input.sessionID,
          model: retryModel,
          previousSummary: previousSummaryText,
          context: summaryContext,
          limit: retryPlan.limit,
          maxTokens: retryPlan.output,
        })
      : undefined
    const summary = result.summary ?? retried?.summary
    if (summary === undefined) return false
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
      text: summary,
      recent: [selected?.recent ?? "", todoContext].filter(Boolean).join("\n\n"),
    })
    return true
  })
  const compactManual = Effect.fn("SessionCompaction.compactManual")(function* (input: Input) {
    const current = dependencies.loadCurrent
      ? yield* dependencies.loadCurrent(input.sessionID)
      : { entries: input.entries, todos: [] }
    const selected = select(current.entries, config.tokens, config.turns)
    const previous = current.entries.findLast((entry) => entry.message.type === "compaction")?.message
    const previousSummary = previous?.type === "compaction" ? previous : undefined
    const todoContext = serializeTodos(current.todos)
    const context = [previousSummary?.recent ?? "", selected?.head ?? "", todoContext].filter(Boolean)
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const summaryRequest = LLM.request({
      model: input.model,
      messages: [],
      tools: [],
      generation: { maxTokens: output || undefined },
    })
    const summaryInputLimit = inputTokenLimit({ model: input.model, request: summaryRequest })
    const limit = summaryInputLimit === undefined
      ? undefined
      : Math.max(0, summaryInputLimit - inputTokenBuffer(summaryInputLimit, config.buffer))
    const prompt = limit === undefined
      ? buildPrompt({ previousSummary: previousSummary?.summary, context })
      : buildPromptWithinLimit({ previousSummary: previousSummary?.summary, context, limit })
    if (!prompt)
      return yield* Effect.fail(
        new SummaryFailed({
          sessionID: input.sessionID,
          reason: "the session context exceeds the summarizer input limit",
        }),
      )
    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "manual",
    })
      const summary = yield* summarizeContext({
        sessionID: input.sessionID,
        model: input.model,
      previousSummary: previousSummary?.summary,
      context,
      limit: limit ?? Number.POSITIVE_INFINITY,
        maxTokens: output || undefined,
      })
    if (!summary.summary)
      return yield* Effect.fail(
        new SummaryFailed({
          sessionID: input.sessionID,
          reason: "the provider returned no usable summary",
        }),
      )
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "manual",
      text: summary.summary,
      recent: [selected?.recent ?? "", todoContext].filter(Boolean).join("\n\n"),
    })
    return summary.summary
  })
  const requiresAutomaticCompaction = (input: AutomaticInput) => {
    if (!config.auto) return false
    const limit = inputTokenLimit(input)
    return limit !== undefined && input.contextEstimateTokens > limit - inputTokenBuffer(limit, config.buffer)
  }
  const compactForModelSwitch = Effect.fn("SessionCompaction.compactForModelSwitch")(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly entries: readonly Entry[]
    readonly targetModel: Model
    readonly targetRequest: LLMRequest
    readonly additionalContextEstimateTokens?: number
    readonly fallbackQuestionDetached?: boolean
  }) {
    const limit = inputTokenLimit({ model: input.targetModel, request: input.targetRequest })
    if (limit === undefined) return false
    const additional = input.additionalContextEstimateTokens ?? 0
    let compacted = false
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = dependencies.loadCurrent
        ? yield* dependencies.loadCurrent(input.sessionID)
        : { entries: input.entries, todos: [] }
      const contextEstimateTokens =
        boundRunnerHistory(current.entries, Number.POSITIVE_INFINITY, input.targetModel).estimatedTokens + additional
      if (!requiresAutomaticCompaction({
        sessionID: input.sessionID,
        entries: current.entries,
        model: input.targetModel,
        request: input.targetRequest,
        contextEstimateTokens,
      }))
        return compacted
      const keepBudget = limit - inputTokenBuffer(limit, config.buffer) - additional
      if (keepBudget <= 0)
        return yield* Effect.fail(new SummaryFailed({
          sessionID: input.sessionID,
          reason: "the target model has no safe input budget after the configured compaction buffer",
        }))
      const summaryReserve = Math.min(2_000, Math.floor(keepBudget / 4))
      const compactedHistory = yield* compactAfterOverflow({
        sessionID: input.sessionID,
        entries: current.entries,
        model: input.targetModel,
        request: input.targetRequest,
        contextEstimateTokens,
        keepTokens: Math.max(0, Math.min(config.tokens, keepBudget - summaryReserve)),
        keepTurns: false,
        fallbackQuestionDetached: input.fallbackQuestionDetached,
      })
      if (!compactedHistory)
        return yield* Effect.fail(new SummaryFailed({
          sessionID: input.sessionID,
          reason: "automatic compaction could not create a checkpoint for the selected model",
        }))
      compacted = true
    }
    const current = dependencies.loadCurrent
      ? yield* dependencies.loadCurrent(input.sessionID)
      : { entries: input.entries, todos: [] }
    const contextEstimateTokens =
      boundRunnerHistory(current.entries, Number.POSITIVE_INFINITY, input.targetModel).estimatedTokens + additional
    if (requiresAutomaticCompaction({
      sessionID: input.sessionID,
      entries: current.entries,
      model: input.targetModel,
      request: input.targetRequest,
      contextEstimateTokens,
    }))
      return yield* Effect.fail(new SummaryFailed({
        sessionID: input.sessionID,
        reason: "the compacted session still exceeds the target model's safe input budget",
      }))
    return compacted
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: AutomaticInput) {
    if (!requiresAutomaticCompaction(input)) return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
    requiresAutomaticCompaction,
    compactForModelSwitch,
    compactManual,
  }
}

function rejectsOutputTokenLimit(message: string) {
  return /unsupported parameter:\s*max_output_tokens/i.test(message)
}

export function validSummary(summary: string) {
  const sections = [
    "## Goal",
    "## Constraints & Preferences",
    "## Progress",
    "### Done",
    "### In Progress",
    "### Blocked",
    "## Key Decisions",
    "## Next Steps",
    "## Critical Context",
    "## Relevant Files",
  ]
  return sections.reduce(
    (state, section) => {
      const index = summary.indexOf(section, state.offset)
      return index === -1 ? { valid: false, offset: state.offset } : { valid: state.valid, offset: index + section.length }
    },
    { valid: true, offset: 0 },
  ).valid
}
