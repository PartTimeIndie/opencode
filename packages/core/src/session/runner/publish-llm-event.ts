import { ToolOutput, type LLMEvent, type ProviderMetadata, type ToolResultValue, type Usage } from "@opencode-ai/llm"
import { DateTime, Effect, Semaphore } from "effect"
import { EventV2 } from "../../event"
import { ModelV2 } from "../../model"
import { SessionEvent } from "../event"
import { SessionFailure } from "../failure"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { ProviderError } from "../provider-error"
import type { Tool } from "../../tool/tool"

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly agent: string
  readonly model: ModelV2.Ref
  readonly cost: ReadonlyArray<ModelV2.Cost>
  readonly snapshot?: string
  readonly publishLiveProgress?: boolean
  readonly structuredOutputAttempt?: SessionEvent.Step.Started["data"]["structuredOutputAttempt"]
}

const safe = (value: number | undefined) => Math.max(0, Number.isFinite(value) ? (value ?? 0) : 0)

const tokens = (usage: Usage | undefined) => {
  const reasoning = safe(usage?.reasoningTokens)
  const read = safe(usage?.cacheReadInputTokens)
  const write = safe(usage?.cacheWriteInputTokens)
  return {
    input: safe(usage?.nonCachedInputTokens),
    output: safe(safe(usage?.outputTokens) - reasoning),
    reasoning,
    cache: { read, write },
  }
}

const usageCost = (modelCost: ReadonlyArray<ModelV2.Cost>, usage: Usage | undefined, metadata?: ProviderMetadata) => {
  const result = tokens(usage)
  const measured = (value: number | undefined) =>
    value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined
  const inputTokens = measured(usage?.inputTokens)
  const outputTokens = measured(usage?.outputTokens)
  const nonCachedInputTokens = measured(usage?.nonCachedInputTokens)
  const cacheReadInputTokens = measured(usage?.cacheReadInputTokens)
  const cacheWriteInputTokens = measured(usage?.cacheWriteInputTokens)
  const reasoningTokens = measured(usage?.reasoningTokens)
  const totalTokens = measured(usage?.totalTokens)
  const tokenMeasurement =
    usage === undefined
      ? undefined
      : {
          version: 1 as const,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(nonCachedInputTokens === undefined ? {} : { nonCachedInputTokens }),
          ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
          ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
          ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
          ...(totalTokens === undefined ? {} : { totalTokens }),
        }
  const contextTokens = safe(usage?.inputTokens)
  const cost =
    modelCost
      .filter((item) => item.tier?.type === "context" && contextTokens > item.tier.size)
      .sort((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0] ?? modelCost.find((item) => item.tier === undefined)
  const totalNanoAiu = metadata?.copilot?.totalNanoAiu
  if (typeof totalNanoAiu === "number" && Number.isFinite(totalNanoAiu) && totalNanoAiu >= 0)
    return { tokens: result, cost: safe(totalNanoAiu / 100_000_000_000), tokenMeasurement }
  return {
    tokens: result,
    tokenMeasurement,
    cost: safe(
      (result.input * (cost?.input ?? 0) +
        result.output * (cost?.output ?? 0) +
        result.cache.read * (cost?.cache.read ?? 0) +
        result.cache.write * (cost?.cache.write ?? 0) +
        result.reasoning * (cost?.output ?? 0)) /
        1_000_000,
    ),
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value }

const message = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

type SettledOutput =
  | { readonly structured: Record<string, unknown>; readonly content: ToolOutput["content"] }
  | { readonly error: { readonly type: "unknown"; readonly message: string } }

const settledOutput = (value: ToolOutput | undefined, result: ToolResultValue): SettledOutput => {
  if (result.type === "error") {
    const preview = value?.content
      .filter((item): item is Extract<ToolOutput["content"][number], { readonly type: "text" }> => item.type === "text")
      .map((item) => item.text)
      .join("")
    return { error: { type: "unknown", message: preview || message(result.value) } }
  }
  const settled = value ?? ToolOutput.fromResultValue(result)
  if (!settled) throw new Error(`Unsupported tool result: ${message(result)}`)
  return { structured: record(settled.structured), content: settled.content }
}

/** Persist one provider turn without executing tools or starting a continuation turn. */
export const createLLMEventPublisher = (events: EventV2.Interface, input: Input) => {
  type LiveDelta =
    | { type: "text"; id: string; assistantMessageID: SessionMessage.ID; delta: string }
    | { type: "reasoning"; id: string; assistantMessageID: SessionMessage.ID; delta: string }
    | { type: "tool-input"; id: string; assistantMessageID: SessionMessage.ID; delta: string }

  const tools = new Map<
    string,
    {
      readonly assistantMessageID: SessionMessage.ID
      readonly name: string
      inputEnded: boolean
      called: boolean
      settled: boolean
      providerExecuted: boolean
      providerMetadata?: ProviderMetadata
      receipt?: Tool.Progress
    }
  >()
  const timestamp = DateTime.now
  let assistantMessageID: SessionMessage.ID | undefined
  let providerFailed = false
  let stepSettled = false
  let retryBarrier = false
  let usableText = false
  let completedToolResult = false
  let pendingDelta: (LiveDelta & { count: number; version: number }) | undefined
  let deltaVersion = 0
  let publishedDeltas = 0
  const withDeltaLock = Semaphore.makeUnsafe(1).withPermit
  let stepFinish:
    | {
        readonly finish: string
        readonly usage: ReturnType<typeof usageCost>
      }
    | undefined

  const startAssistant = Effect.fnUntraced(function* () {
    if (assistantMessageID !== undefined) return assistantMessageID
    assistantMessageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model,
      assistantMessageID,
      timestamp: yield* timestamp,
      ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
      ...(input.structuredOutputAttempt === undefined ? {} : { structuredOutputAttempt: input.structuredOutputAttempt }),
    })
    return assistantMessageID
  })
  const currentAssistantMessageID = () =>
    assistantMessageID === undefined
      ? Effect.die("Tool event before assistant step start")
      : Effect.succeed(assistantMessageID)

  const emitPendingDelta = Effect.fnUntraced(function* () {
    const current = pendingDelta
    if (!current) return
    pendingDelta = undefined
    publishedDeltas++
    if (current.type === "text") {
      yield* events.publish(SessionEvent.Text.Delta, {
        sessionID: input.sessionID,
        assistantMessageID: current.assistantMessageID,
        timestamp: yield* timestamp,
        textID: current.id,
        delta: current.delta,
      })
      return
    }
    if (current.type === "reasoning") {
      yield* events.publish(SessionEvent.Reasoning.Delta, {
        sessionID: input.sessionID,
        assistantMessageID: current.assistantMessageID,
        timestamp: yield* timestamp,
        reasoningID: current.id,
        delta: current.delta,
      })
      return
    }
    yield* events.publish(SessionEvent.Tool.Input.Delta, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID: current.assistantMessageID,
      callID: current.id,
      delta: current.delta,
    })
  })

  const flushPendingDelta = () => withDeltaLock(emitPendingDelta())
  const queueDelta = (delta: LiveDelta) =>
    withDeltaLock(
      Effect.gen(function* () {
        if (pendingDelta && (pendingDelta.type !== delta.type || pendingDelta.id !== delta.id))
          yield* emitPendingDelta()
        if (pendingDelta) {
          pendingDelta.delta += delta.delta
          pendingDelta.count++
          if (pendingDelta.count >= 64) yield* emitPendingDelta()
          return
        }
        const version = ++deltaVersion
        pendingDelta = { ...delta, count: 1, version }
        yield* Effect.sleep("16 millis").pipe(
          Effect.andThen(
            withDeltaLock(Effect.suspend(() => (pendingDelta?.version === version ? emitPendingDelta() : Effect.void))),
          ),
          Effect.forkChild,
        )
      }),
    )

  const fragments = (
    name: string,
    ended: (id: string, value: string, providerMetadata?: ProviderMetadata) => Effect.Effect<void>,
  ) => {
    const chunks = new Map<string, string[]>()
    const start = (id: string) =>
      Effect.suspend(() => {
        if (chunks.has(id)) return Effect.die(`Duplicate ${name} start: ${id}`)
        chunks.set(id, [])
        return Effect.void
      })
    const append = (id: string, value: string) =>
      Effect.suspend(() => {
        const current = chunks.get(id)
        if (!current) return Effect.die(`${name} delta before start: ${id}`)
        current.push(value)
        return Effect.void
      })
    const end = Effect.fnUntraced(function* (id: string, providerMetadata?: ProviderMetadata) {
      const current = chunks.get(id)
      if (!current) return yield* Effect.die(`${name} end before start: ${id}`)
      yield* ended(id, current.join(""), providerMetadata)
      chunks.delete(id)
    })
    const flush = Effect.fnUntraced(function* () {
      for (const id of chunks.keys()) yield* end(id)
    })
    return { start, append, end, flush }
  }

  const text = fragments("text", (textID, value) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: yield* currentAssistantMessageID(),
        timestamp: yield* timestamp,
        textID,
        text: value,
      })
    }),
  )
  const reasoning = fragments("reasoning", (reasoningID, value, providerMetadata) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Reasoning.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: yield* currentAssistantMessageID(),
        timestamp: yield* timestamp,
        reasoningID,
        text: value,
        providerMetadata,
      })
    }),
  )
  const toolInput = fragments("tool input", (callID, value) =>
    Effect.gen(function* () {
      const tool = tools.get(callID)
      if (!tool) return yield* Effect.die(`Tool input end before start: ${callID}`)
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: tool.assistantMessageID,
        callID,
        text: value,
      })
      tool.inputEnded = true
    }),
  )

  const flushFragments = Effect.fnUntraced(function* () {
    yield* text.flush()
    yield* reasoning.flush()
    yield* toolInput.flush()
  })

  const startToolInput = Effect.fnUntraced(function* (event: { readonly id: string; readonly name: string }) {
    retryBarrier = true
    if (tools.has(event.id)) return yield* Effect.die(`Duplicate tool input start: ${event.id}`)
    const assistantMessageID = yield* startAssistant()
    tools.set(event.id, {
      assistantMessageID,
      name: event.name,
      inputEnded: false,
      called: false,
      settled: false,
      providerExecuted: false,
    })
    yield* toolInput.start(event.id)
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID,
      callID: event.id,
      name: event.name,
    })
  })

  const endToolInput = Effect.fnUntraced(function* (event: { readonly id: string; readonly name: string }) {
    const tool = tools.get(event.id)
    if (!tool) return yield* Effect.die(`Tool input end before start: ${event.id}`)
    if (tool.name !== event.name)
      return yield* Effect.die(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
    if (tool.inputEnded) return yield* Effect.die(`Duplicate tool input end: ${event.id}`)
    yield* toolInput.end(event.id)
  })

  const flush = Effect.fn("SessionRunner.flush")(function* () {
    yield* flushPendingDelta()
    yield* flushFragments()
  })

  const failUnsettledTools = Effect.fn("SessionRunner.failUnsettledTools")(function* (
    message: string,
    hostedOnly = false,
    interruption?: SessionEvent.Tool.Interruption,
    failure?: SessionFailure.Failure,
  ) {
    let uncalled = 0
    for (const [callID, tool] of tools) {
      if (tool.settled || (hostedOnly && !tool.providerExecuted)) continue
      if (tool.receipt) yield* persistReceipt(callID, tool)
      tool.settled = true
      if (!tool.called) uncalled++
      yield* events.publish(SessionEvent.Tool.Failed, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: tool.assistantMessageID,
        callID,
        error: { type: "unknown", message },
        ...(interruption ? { interruption } : {}),
        ...(failure ? { failure } : {}),
        provider: {
          executed: tool.providerExecuted,
          ...(tool.providerMetadata === undefined ? {} : { metadata: tool.providerMetadata }),
        },
      })
    }
    return uncalled
  })

  const assistantMessageIDForTool = (callID: string) => {
    const tool = tools.get(callID)
    return tool ? Effect.succeed(tool.assistantMessageID) : Effect.die(`Unknown tool call: ${callID}`)
  }

  const persistReceipt = (callID: string, tool: { assistantMessageID: SessionMessage.ID; receipt?: Tool.Progress }) =>
    Effect.gen(function* () {
      const receipt = tool.receipt
      if (!receipt) return
      yield* events.publish(SessionEvent.Tool.Progress, {
          sessionID: input.sessionID,
          assistantMessageID: tool.assistantMessageID,
          callID,
          timestamp: yield* timestamp,
          structured: receipt.structured,
          content: receipt.content.filter(
            (part): part is Extract<Tool.Content, { type: "text" }> => part.type === "text",
          ),
        })
    })

  const publish = Effect.fn("SessionRunner.publishLLMEvent")(function* (
    event: LLMEvent,
    outputPaths: ReadonlyArray<string> = [],
  ) {
    if (event.type !== "text-delta" && event.type !== "reasoning-delta" && event.type !== "tool-input-delta")
      yield* flushPendingDelta()
    switch (event.type) {
      case "step-start":
        return
      case "text-start":
        yield* text.start(event.id)
        yield* events.publish(SessionEvent.Text.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          textID: event.id,
        })
        return
      case "text-delta":
        if (event.text !== "") retryBarrier = true
        if (event.text.trim() !== "") usableText = true
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* text.append(event.id, event.text)
            yield* queueDelta({
              type: "text",
              id: event.id,
              assistantMessageID: yield* currentAssistantMessageID(),
              delta: event.text,
            })
          }),
        )
        return
      case "text-end":
        yield* text.end(event.id)
        return
      case "reasoning-start":
        yield* reasoning.start(event.id)
        yield* events.publish(SessionEvent.Reasoning.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          reasoningID: event.id,
          providerMetadata: event.providerMetadata,
        })
        return
      case "reasoning-delta":
        if (event.text !== "") retryBarrier = true
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* reasoning.append(event.id, event.text)
            yield* queueDelta({
              type: "reasoning",
              id: event.id,
              assistantMessageID: yield* currentAssistantMessageID(),
              delta: event.text,
            })
          }),
        )
        return
      case "reasoning-end":
        yield* reasoning.end(event.id, event.providerMetadata)
        return
      case "tool-input-start":
        yield* startToolInput(event)
        return
      case "tool-input-delta": {
        const tool = tools.get(event.id)
        if (!tool) return yield* Effect.die(`Tool input delta before start: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.inputEnded) return yield* Effect.die(`Tool input delta after end: ${event.id}`)
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* toolInput.append(event.id, event.text)
            yield* queueDelta({
              type: "tool-input",
              id: event.id,
              assistantMessageID: tool.assistantMessageID,
              delta: event.text,
            })
          }),
        )
        return
      }
      case "tool-input-end":
        yield* endToolInput(event)
        return
      case "tool-call": {
        if (!tools.has(event.id)) yield* startToolInput(event)
        const tool = tools.get(event.id)!
        if (!tool.inputEnded) yield* endToolInput(event)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool call name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.called) return yield* Effect.die(`Duplicate tool call: ${event.id}`)
        tool.called = true
        tool.providerExecuted = event.providerExecuted === true
        tool.providerMetadata = event.providerMetadata
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          tool: event.name,
          input: record(event.input),
          provider: {
            executed: tool.providerExecuted,
            ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
          },
        })
        return
      }
      case "tool-result": {
        const tool = tools.get(event.id)
        if (!tool?.called) return yield* Effect.die(`Tool result before call: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool result name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.settled) {
          if (event.result.type === "error") return
          return yield* Effect.die(`Duplicate tool result: ${event.id}`)
        }
        if (event.result.type === "error" && tool.receipt) yield* persistReceipt(event.id, tool)
        tool.settled = true
        const result = settledOutput(event.output, event.result)
        const provider = {
          executed: event.providerExecuted === true || tool.providerExecuted,
          ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
        }
        if ("error" in result) {
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID: input.sessionID,
            timestamp: yield* timestamp,
            assistantMessageID: tool.assistantMessageID,
            callID: event.id,
            error: result.error,
            result: event.result,
            provider,
          })
          return
        }
        completedToolResult = true
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          ...result,
          outputPaths,
          ...(provider.executed ? { result: event.result } : {}),
          provider,
        })
        return
      }
      case "tool-error": {
        const tool = tools.get(event.id)
        if (!tool) return yield* Effect.die(`Tool error before call: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool error name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.settled) return yield* Effect.die(`Duplicate tool error: ${event.id}`)
        if (!tool.called) {
          // The provider finished a tool call with unparsable argument JSON. The
          // call exists but its arguments were never valid enough to execute:
          // persist the failed invocation so the model can correct it next turn.
          tool.called = true
          yield* events.publish(SessionEvent.Tool.Called, {
            sessionID: input.sessionID,
            timestamp: yield* timestamp,
            assistantMessageID: tool.assistantMessageID,
            callID: event.id,
            tool: event.name,
            input: {},
            provider: { executed: false },
          })
        }
        tool.settled = true
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          error: { type: "unknown", message: event.message },
          provider: {
            executed: tool.providerExecuted,
            ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
          },
        })
        return
      }
      case "step-finish":
        yield* flush()
        // Some streamed providers repeat the terminal event. The first finish is
        // already durable; treating a replay as idempotent keeps the turn alive.
        if (stepFinish) return
        stepFinish = { finish: event.reason, usage: usageCost(input.cost, event.usage, event.providerMetadata) }
        return
      case "finish":
        return
      case "provider-error":
        providerFailed = true
        yield* flush()
        yield* events.publish(SessionEvent.Step.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: yield* startAssistant(),
          error: { type: "unknown", message: event.message },
          failure:
            event.classification === "context-overflow"
              ? SessionFailure.make("provider.context-overflow", { cause: { raw: event.message } })
              : ProviderError.normalize(event, `${input.model.providerID}/${input.model.id}`),
        })
        stepSettled = true
        return
    }
  })

  return {
    publish,
    flush,
    // Called only inside the cache attempt's atomic parking transaction. Persist
    // our billed usage with an error finish, never buffered content or tool calls.
    accountRejected: Effect.fn("SessionRunner.accountRejected")(function* (
      usage: Usage,
      metadata?: ProviderMetadata,
      generationMs?: number,
    ) {
      if (stepSettled) return
      const measured = usageCost(input.cost, usage, metadata)
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: yield* startAssistant(),
        finish: "error",
        cost: measured.cost,
        tokens: measured.tokens,
        tokenMeasurement: {
          version: 1,
          ...measured.tokenMeasurement,
          ...(generationMs === undefined || !Number.isFinite(generationMs) ? {} : {
            generationMilliseconds: Math.max(0, Math.round(generationMs)),
          }),
        },
      })
      stepSettled = true
    }),
    finishStep: Effect.fn("SessionRunner.finishStep")(function* (
      snapshot?: string,
      structured?: unknown,
      finishOverride?: string,
      generationMs?: number,
    ) {
      if (!stepFinish || stepSettled) return
      const finish = stepFinish
      stepFinish = undefined
      const generationMilliseconds =
        generationMs === undefined || !Number.isFinite(generationMs) ? undefined : Math.max(0, Math.round(generationMs))
      const tokenMeasurement =
        finish.usage.tokenMeasurement === undefined && generationMilliseconds === undefined
          ? undefined
          : {
              version: 1 as const,
              ...(finish.usage.tokenMeasurement ?? {}),
              ...(generationMilliseconds === undefined ? {} : { generationMilliseconds }),
            }
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: yield* startAssistant(),
        finish: finishOverride ?? finish.finish,
        cost: finish.usage.cost,
        tokens: finish.usage.tokens,
        ...(tokenMeasurement === undefined ? {} : { tokenMeasurement }),
        snapshot,
        ...(structured === undefined ? {} : { structured }),
      })
      stepSettled = true
      if (finish.finish === "content-filter") {
        yield* events.publish(SessionEvent.Step.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: yield* startAssistant(),
          error: { type: "unknown", message: "The response was blocked by the provider's content filter" },
          failure: SessionFailure.make("provider.content-policy"),
        })
      }
      if (finish.finish === "error") {
        yield* events.publish(SessionEvent.Step.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: yield* startAssistant(),
          error: { type: "unknown", message: "The provider finished the response with an error" },
          failure: SessionFailure.make("provider.invalid-response", { retryability: "none" }),
        })
      }
    }),
    interruptStep: Effect.fn("SessionRunner.interruptStep")(function* () {
      if (assistantMessageID === undefined || stepSettled) return
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID,
        finish: "interrupted",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      stepSettled = true
    }),
    failUnsettledTools,
    hasAssistantStarted: () => assistantMessageID !== undefined,
    hasRetryBarrier: () => retryBarrier || stepSettled,
    hasUsableText: () => usableText,
    hasCompletedToolResult: () => completedToolResult,
    hasStepFinish: () => stepFinish !== undefined,
    // An empty successful attempt can be retried before any assistant output.
    // Its finish/usage must not mask the next attempt's terminal verdict.
    clearEmptyFinish: () => {
      if (stepSettled || retryBarrier || usableText || completedToolResult || tools.size > 0) return false
      if (stepFinish && stepFinish.finish !== "stop") return false
      stepFinish = undefined
      return true
    },
    stepFinishReason: () => stepFinish?.finish,
    hasProviderError: () => providerFailed,
    startAssistant,
    currentAssistantMessageID: () => assistantMessageID,
    assistantMessageID: assistantMessageIDForTool,
    progress: Effect.fn("SessionRunner.toolProgress")(function* (callID: string, snapshot: Tool.Progress) {
      const tool = tools.get(callID)
      if (!tool || !tool.called || tool.settled || stepSettled || tool.providerExecuted) return
      if (tool.name === "multi_agent_fanout") tool.receipt = snapshot
       // A repair claim is an idempotency record, not optional live UI progress.
       // Persist it before the provider request even when live display is disabled.
       const repairClaimed = tool.name === "multi_agent_fanout" && Array.isArray(snapshot.structured.reviewers) &&
         snapshot.structured.reviewers.some((row: unknown) =>
           row !== null && typeof row === "object" && "repairClaim" in row && typeof row.repairClaim === "string")
       if (input.publishLiveProgress === false && !repairClaimed) return
      yield* events.publish(SessionEvent.Tool.Progress, {
        sessionID: input.sessionID,
        assistantMessageID: tool.assistantMessageID,
        callID,
        timestamp: yield* timestamp,
        structured: snapshot.structured,
        content: snapshot.content.filter(
          (part): part is Extract<Tool.Content, { type: "text" }> => part.type === "text",
        ),
      })
    }),
    publishedDeltaCount: () => publishedDeltas,
  }
}
