import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  ContentPolicyReason,
  InvalidRequestReason,
  InvalidProviderOutputReason,
  Message,
  SystemPart,
  ToolOutput,
  ToolResultValue,
  isContextOverflowFailure,
  mergeProviderOptions,
  TransportReason,
  type GenerationOptionsFields,
  type LLMRequest,
  type Model,
  type ProviderErrorEvent,
  type ProviderOptions,
  ToolDefinition,
  type ToolChoice,
} from "@opencode-ai/llm"
import { and, eq } from "drizzle-orm"
import { isDeepStrictEqual } from "node:util"
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FiberSet,
  Layer,
  Option,
  Schema,
  SchemaRepresentation,
  Semaphore,
  Stream,
} from "effect"
import { AgentV2 } from "../../agent"
import { AIChain } from "../../ai-chain"
import { SessionFailure } from "../failure"
import { SessionResume } from "../resume"
import { SessionCompaction, SummaryFailed } from "../compaction"
import { Catalog } from "../../catalog"
import { CapabilityLease } from "../../capability/lease"
import { Config } from "../../config"
import { ConfigVision } from "../../config/vision"
import { ConfigOptimization } from "../../config/optimization"
import { ConfigCapabilities } from "../../config/capabilities"
import { Memory } from "../../memory"
import { Database } from "../../database/database"
import { FileKnowledge } from "../../file-knowledge"
import { EventV2 } from "../../event"
import { Global } from "../../global"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { ModelRequest } from "../../model-request"
import { PermissionV2 } from "../../permission"
import { PluginV2 } from "../../plugin"
import { PluginBoot } from "../../plugin/boot"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { QuestionTable } from "../../question/sql"
import { Perf } from "../../observability/perf"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { InstructionContext } from "../../instruction-context"
import { FSUtil } from "../../fs-util"
import { ReferenceGuidance } from "../../reference/guidance"
import { Snapshot } from "../../snapshot"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { ContentStore } from "../../content-store"
import { Token } from "../../util/token"
import { SkillCatalog } from "../../skill/catalog"
import { ContextBudget } from "../../util/context-budget"
import { SessionContextEpoch } from "../context-epoch"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { FileAttachment } from "../prompt"
import { SessionSchema } from "../schema"
import { SessionHostContext } from "../host-context"
import { SessionStore } from "../store"
import { SessionContextEpochTable, SessionTable } from "../sql"
import { SessionToolCancellation } from "../tool-cancellation"
import { SessionTodo } from "../todo"
import { SessionTurnContinuation } from "../turn-continuation"
import { providerHeaders } from "../provider-headers"
import {
  providerStreamIdleTimeouts,
  withProviderStreamAbortNormalization,
  withProviderStreamIdleTimeout,
} from "../provider-stream"
export {
  providerStreamIdleTimeoutMs,
  providerStreamIdleTimeouts,
  withProviderStreamAbortNormalization,
  withProviderStreamIdleTimeout,
} from "../provider-stream"
import { SurfaceTool } from "../../tool/surface"
import { Settled, type RunError, Service, UserDeclinedError, ProviderInterruptedError } from "./index"
import { SessionRunnerModel } from "./model"
import { ToolReadBudget } from "./tool-read-budget"
import { createLLMEventPublisher } from "./publish-llm-event"
import { media, modelSupportsFile, toLLMMessages, type ImageInputCapabilities } from "./to-llm-message"
import { providerFacingRequestTools } from "./tool-compatibility"
import { VisionDelegation } from "./vision-delegation"
import { CircuitBreaker } from "../circuit-breaker"
import { nextModel as nextChainModel, configuredModelRef } from "./model-chain"
import { McpTool } from "../../mcp/tool"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding a prompt-loop monolith.
 * Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Bound model steps.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@opencode-ai/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable activity recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and a
 * bounded explicit loop starts the next provider turn after local settlement.
 */

// A transient provider failure may be retried five times before the turn is marked failed.
// Retrying stops as soon as meaningful assistant output, tool work, or a step finish has been
// published, avoiding duplicate tool execution or continuation after a partially completed turn.
// A locally-failed tool call (for example unparsable provider argument JSON)
// continues the turn so the model can correct it, but only a bounded number of
// correction rounds before the failed call settles terminally.
const MAX_TOOL_ERROR_ROUNDS = 3
// Pre-provider model resolve/init (catalog select, credential, AISDK/native
// plugin init) never reaches the framed event stream, so its own deadline is the
// only thing keeping a stalled init from heartbeating a running activity
// forever. On timeout the configured chain advances one step, or the turn fails
// terminally through the normal RunError funnel when no fallback is configured.
const MODEL_RESOLVE_INIT_TIMEOUT_MS = 30_000
// Materialization is required for the primary request, so a timeout is a normal
// typed runner failure. Vision enrichment is optional and therefore fails open.
const MESSAGE_MATERIALIZATION_TIMEOUT_MS = 60_000
const VISION_MODEL_RESOLVE_TIMEOUT_MS = 15_000
const VISION_STREAM_TIMEOUT_MS = 60_000
const VISION_DELEGATION_TIMEOUT_MS = 90_000
const TITLE_OUTPUT_TOKENS = 256
const TITLE_MAX_LENGTH = 35
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput"

// Z.AI requires tool_stream:true in addition to stream:true for streamed tool argument deltas.
// https://docs.z.ai/guides/tools/stream-tool
export function providerRequestBody(
  model: Model,
  tools: ReadonlyArray<ToolDefinition>,
  body?: Readonly<Record<string, unknown>>,
) {
  if (model.provider !== "zhipuai-coding-plan" || model.id !== "glm-5.3" || tools.length === 0) return body
  return { ...body, tool_stream: true }
}
const SNAPSHOT_MUTATING_TOOLS = new Set(["bash", "edit", "write", "patch", "apply_patch", "task", "echo"])
const STRUCTURED_OUTPUT_DESCRIPTION =
  "Return the final answer as JSON matching the requested schema. Call after necessary work; no further actions run after it."
const STRUCTURED_OUTPUT_SYSTEM_PROMPT =
  "MUST use the StructuredOutput tool for the final answer; do not answer in plain text."
// Tool output can be configured to replay to the provider without host-side
// preview limits. The model itself must then keep its tool results inside the
// advertised context budget, or sessions compact prematurely after a few
// oversized shell outputs.
export const TOOL_OUTPUT_CONTEXT_GUIDANCE =
  "Keep tool output well inside this model's context window: scope shell commands and file or directory searches narrowly, pipe listings through head or Select-Object -First, and never dump unbounded recursive listings. Oversized tool output fills the context and forces premature session compaction."

export const contextPressureWarning = (limitTokens: number) =>
  `Context pressure: session history has passed one quarter of this model's ${limitTokens.toLocaleString("en-US")}-token context window, and this session compacts automatically as it approaches the limit. Keep every remaining tool call strictly bounded (narrow scope, head / Select-Object -First N, targeted patterns); one more oversized output will summarize away recent turns.`

function needsSnapshotForTools(definitions: readonly ToolDefinition[]) {
  return definitions.some((definition) => SNAPSHOT_MUTATING_TOOLS.has(definition.name))
}

export type RequestAssemblyTimings = {
  session_load_ms: number
  plugin_boot_ms: number
  agent_selection_ms: number
  context_epoch_ms: number
  context_source_load_ms: number
  context_snapshot_decode_ms: number
  context_compare_ms: number
  context_fence_ms: number
  model_resolution_ms: number
  model_cost_ms: number
  model_capabilities_ms: number
  history_bound_ms: number
  mcp_ensure_ms: number
  permission_materialization_ms: number
  tool_materialization_ms: number
  snapshot_start_ms: number
  message_materialization_ms: number
  vision_delegation_ms: number
  model_messages_ms: number
  prepare_llm_request_ms: number
  hook_system_transform_ms: number
  hook_messages_transform_ms: number
  hook_params_ms: number
  hook_headers_ms: number
}

function elapsed(started: number) {
  return Math.max(0, performance.now() - started)
}

function fallbackQuestion(target: Model, summarizer: Model) {
  return {
    type: "confirm" as const,
    header: "Context summary",
    question: `Use ${summarizer.id} (${summarizer.provider}) to summarize this Session's context?`,
    options: [
      {
        label: "Yes",
        description: "Send the selected context to this model for this summary only.",
      },
      {
        label: "No",
        description: "Keep the selected model and stop this compaction attempt.",
      },
      {
        label: "I need more info",
        description: "Do not send context to this model; stop the current compaction attempt.",
      },
    ],
    allowOther: true,
    body: [
      {
        id: "context-summary-fallback",
        type: "markdown" as const,
        content: `The selected context will be sent to ${summarizer.provider}/${summarizer.id} to create this summary only. It does not change the Session's selected model (${target.id}) for normal replies. Choosing anything other than Yes keeps the selected model and stops this compaction attempt.`,
      },
    ],
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const permission = yield* PermissionV2.Service
    const tools = yield* ToolRegistry.Service
    const capabilityLeases = Option.getOrUndefined(yield* Effect.serviceOption(CapabilityLease.Service))
    const mcpTools = Option.getOrUndefined(yield* Effect.serviceOption(McpTool.Service))
    const resources = yield* ToolOutputStore.Service
    const plugin = Option.getOrUndefined(yield* Effect.serviceOption(PluginV2.Service))
    const pluginBoot = Option.getOrUndefined(yield* Effect.serviceOption(PluginBoot.Service))
    const models = yield* SessionRunnerModel.Service
    const catalog = Option.getOrUndefined(yield* Effect.serviceOption(Catalog.Service))
    const questions = Option.getOrUndefined(yield* Effect.serviceOption(QuestionV2.Service))
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const snapshots = Option.getOrUndefined(yield* Effect.serviceOption(Snapshot.Service))
    const contentStore = Option.getOrUndefined(yield* Effect.serviceOption(ContentStore.Service))
    const memory = Option.getOrUndefined(yield* Effect.serviceOption(Memory.Service))
    const config = yield* Config.Service
    const fs = Option.getOrUndefined(yield* Effect.serviceOption(FSUtil.Service))
    const db = (yield* Database.Service).db
    const configEntries = yield* config.entries()
    const optimization = ConfigOptimization.resolve(configEntries)
    const capabilities = ConfigCapabilities.resolve(configEntries)
    // Per-session read-tool budget (Pattern 1/2 hard-stop). Default-off feature toggle;
    // when disabled, checks always pass — identical to baseline behavior.
    const toolReadBudgets = ToolReadBudget.sessionStore()
    // One breaker instance per runner service keeps provider failure history
    // scoped to this process's runner instead of leaking across test layers.
    const breakers = CircuitBreaker.make()
    const toolCancellation = Option.getOrUndefined(yield* Effect.serviceOption(SessionToolCancellation.Service))
    const titleInFlight = new Set<SessionSchema.ID>()
    const forkTitle = yield* FiberSet.makeRuntime<never, void, never>()
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })
    const compaction = SessionCompaction.make({
      events,
      llm,
      config: configEntries,
      loadCurrent: (sessionID) =>
        Effect.all({
          entries: SessionHistory.currentEntriesForRunner(db, sessionID),
          todos: SessionTodo.load(db, sessionID),
        }),
      fallbackModel: Effect.fn("SessionRunner.compactionFallbackModel")(function* (input) {
        if (!catalog) return
        if (!input.canSummarize(input.model)) return
        const context = input.model.route.defaults.limits?.context
        if (context === undefined || context <= 0) return
        if (!questions) return
        const session = yield* getSession(input.sessionID)
        const candidates = (yield* catalog.model.available())
          .filter(
            (candidate) =>
              candidate.enabled &&
              candidate.limit.context > context &&
              candidate.capabilities.input.includes("text") &&
              candidate.capabilities.output.includes("text"),
          )
          .sort((left, right) => left.limit.context - right.limit.context)
        for (const candidate of candidates) {
          const model = yield* models
            .resolve({
              ...session,
              model: ModelV2.Ref.make({ id: candidate.id, providerID: candidate.providerID }),
            })
            .pipe(Effect.option)
          if (Option.isNone(model)) continue
          const resolvedContext = model.value.route.defaults.limits?.context
          if (
            String(model.value.id) !== candidate.id ||
            String(model.value.provider) !== candidate.providerID ||
            resolvedContext === undefined ||
            resolvedContext <= context
          )
            continue
          if (!input.canSummarize(model.value)) continue
          const answers = yield* (
            input.detached
              ? questions.askDetached({
                  sessionID: input.sessionID,
                  questions: [fallbackQuestion(input.model, model.value)],
                })
              : questions.ask({
                  sessionID: input.sessionID,
                  questions: [fallbackQuestion(input.model, model.value)],
                })
          ).pipe(
            Effect.catchTag("QuestionV2.RejectedError", () => Effect.succeed(undefined)),
            Effect.catchTag("QuestionV2.ConflictError", () => Effect.succeed(undefined)),
          )
          if (answers?.[0]?.includes("Yes")) return model.value
          return
        }
      }),
    })
    const modelSwitchContext = Effect.fn("SessionRunner.modelSwitchContext")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly model: ModelV2.Ref
    }) {
      const session = yield* getSession(input.sessionID)
      const target = yield* models.resolve({ ...session, model: input.model }).pipe(Effect.option)
      if (
        Option.isNone(target) ||
        String(target.value.id) !== input.model.id ||
        String(target.value.provider) !== input.model.providerID
      )
        return
      const entries = yield* SessionHistory.currentEntriesForRunner(db, input.sessionID)
      const epoch = yield* db
        .select({ baseline: SessionContextEpochTable.baseline })
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      const output = target.value.route.defaults.limits?.output
      const request = LLM.request({
        model: target.value,
        messages: [],
        tools: [],
        generation: output ? { maxTokens: output } : undefined,
      })
      return {
        sessionID: input.sessionID,
        entries,
        model: target.value,
        request,
        contextEstimateTokens:
          SessionCompaction.boundRunnerHistory(entries, Number.POSITIVE_INFINITY, target.value).estimatedTokens +
          Token.estimate(epoch?.baseline ?? ""),
      }
    })
    const requiresModelSwitchCompaction = Effect.fn("SessionRunner.requiresModelSwitchCompaction")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly model: ModelV2.Ref
    }) {
      const context = yield* modelSwitchContext(input)
      if (!context) return false
      return compaction.requiresAutomaticCompaction(context)
    })
    const prepareModelSwitch = Effect.fn("SessionRunner.prepareModelSwitch")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly model: ModelV2.Ref
    }) {
      const context = yield* modelSwitchContext(input)
      if (!context) return false
      return yield* compaction
        .compactForModelSwitch({
          sessionID: context.sessionID,
          entries: context.entries,
          targetModel: context.model,
          targetRequest: context.request,
          additionalContextEstimateTokens:
            context.contextEstimateTokens -
            SessionCompaction.boundRunnerHistory(context.entries, Number.POSITIVE_INFINITY, context.model)
              .estimatedTokens,
          fallbackQuestionDetached: true,
        })
        .pipe(
          Effect.catchTag(
            "LLM.Error",
            (error) =>
              new SummaryFailed({
                sessionID: input.sessionID,
                reason: `model-switch compaction failed: ${error.message}`,
              }),
          ),
        )
    })
    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const recoverSettledSurface = Effect.fn("SessionRunner.recoverSettledSurface")(function* (
      sessionID: SessionSchema.ID,
      message: SessionMessage.Assistant,
      tool: SessionMessage.AssistantTool,
    ) {
      if (tool.name !== SurfaceTool.name || tool.provider?.executed || tool.state.status !== "running") return false
      if (SurfaceTool.validateInput(tool.state.input)) return false
      const input = Schema.decodeUnknownOption(SurfaceTool.BlockingInput)(tool.state.input)
      // Source-backed calls also require a bound source/response artifact. Never reimport
      // files or replay tools/actions just to reconstruct an interrupted tool result.
      if (Option.isNone(input)) return false
      const saved = yield* db
        .select()
        .from(QuestionTable)
        .where(
          and(
            eq(QuestionTable.session_id, sessionID),
            eq(QuestionTable.assistant_message_id, message.id),
            eq(QuestionTable.tool_call_id, tool.id),
            eq(QuestionTable.mode, "blocking"),
            eq(QuestionTable.detached, false),
            eq(QuestionTable.state, "replied"),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!saved?.receipt || saved.request.mode !== "blocking" || saved.request.sessionID !== sessionID) return false
      if (!isDeepStrictEqual(saved.request.tool, { messageID: message.id, callID: tool.id })) return false
      if (
        !isDeepStrictEqual(saved.request.questions, input.value.questions) ||
        saved.request.phase !== input.value.phase
      )
        return false
      const output = Schema.decodeUnknownOption(SurfaceTool.BlockingOutput)({
        mode: "blocking",
        answers: saved.answers,
      })
      if (Option.isNone(output) || output.value.answers.length !== saved.request.questions.length) return false
      const bounded = yield* resources.bound({
        sessionID,
        assistantMessageID: message.id,
        toolCallID: tool.id,
        tool: tool.name,
        output: {
          structured: Schema.encodeSync(SurfaceTool.BlockingOutput)(output.value),
          content: SurfaceTool.toModelContent(input.value, output.value).map((part) =>
            part.type === "text"
              ? part
              : {
                  type: "file" as const,
                  uri: `data:${part.mime};base64,${part.data}`,
                  mime: part.mime,
                  name: part.name,
                },
          ),
        },
      })
      yield* events.publish(SessionEvent.Tool.Success, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID: message.id,
        callID: tool.id,
        structured: bounded.output.structured ?? {},
        content: bounded.output.content,
        outputPaths: [...bounded.outputPaths],
        provider: { executed: false },
      })
      return true
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          if (yield* recoverSettledSurface(sessionID, message, tool)) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            interruption: { source: "recovery", reason: "stale-lease" },
            failure: SessionFailure.fromInterruptReason("stale-lease"),
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: declining a permission prompt halts the loop instead of becoming model-facing tool output.
    const isPermissionDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof PermissionV2.DeclinedError)

    type TurnTransition =
      // Request preparation observed a concurrent Session change and must restart from durable state.
      | { readonly _tag: "RebuildPreparedTurn"; readonly promotion?: SessionInput.Delivery }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction" }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const rebuildPreparedTurn = (promotion?: SessionInput.Delivery) =>
      new TurnTransitionError({ _tag: "RebuildPreparedTurn", promotion })
    const continueAfterOverflowCompaction = new TurnTransitionError({
      _tag: "ContinueAfterOverflowCompaction",
    })

    const retryAgentMismatch = (promotion: SessionInput.Delivery | undefined) =>
      Effect.catchDefect((defect) =>
        defect instanceof SessionContextEpoch.AgentMismatch
          ? Effect.die(rebuildPreparedTurn(promotion))
          : Effect.die(defect),
      )

    const sameModel = Schema.toEquivalence(Schema.UndefinedOr(ModelV2.Ref))
    type RunnerHistorySnapshot = {
      readonly baselineSeq: number
      readonly contextRevision: number
      readonly entries: ReadonlyArray<{ readonly seq: number; readonly message: SessionMessage.Message }>
    }
    type RunTurnResult = {
      readonly needsContinuation: boolean
      readonly toolBudgetExceeded?: boolean
      readonly invalidToolInput?: boolean
      readonly invalidStructuredOutput?: boolean
      readonly history?: RunnerHistorySnapshot
      readonly missingStructuredOutput?: boolean
      readonly structuredRetryCount?: number
      readonly recoveredRetryableFailure?: boolean
      readonly retryDelayMs?: number
    }
    type PrepareLLMRequestInput = (
      | {
          readonly purpose: "session"
          readonly hostSession: Pick<SessionSchema.Info, "id" | "parentID">
        }
      | { readonly purpose: "auxiliary" }
    ) & {
      readonly sessionID: SessionSchema.ID
      readonly agent: string
      readonly model: Model
      readonly system: ReadonlyArray<string>
      readonly messages: ReadonlyArray<Message>
      readonly tools: ReadonlyArray<ToolDefinition>
      readonly toolChoice?: ToolChoice.Input
      readonly generation?: GenerationOptionsFields
      readonly providerOptions?: ProviderOptions
      readonly headers?: Readonly<Record<string, string>>
      readonly requestID?: string
      readonly body?: Readonly<Record<string, unknown>>
      readonly message?: unknown
      readonly transformMessages?: boolean
      readonly timings?: PrepareLLMRequestTimings
    }
    type PrepareLLMRequestTimings = {
      system_transform_ms: number
      messages_transform_ms: number
      params_hook_ms: number
      headers_hook_ms: number
    }
    const prepareLLMRequest = Effect.fn("SessionRunner.prepareLLMRequest")(function* (input: PrepareLLMRequestInput) {
      const generation = defaultOpenRouterMaxTokens(input.model, {
        ...input.model.route.defaults.generation,
        ...input.generation,
      })
      const providerOptions = mergeProviderOptions(input.model.route.defaults.providerOptions, input.providerOptions)
      const system = [...input.system]
      const systemTransformStarted = performance.now()
      const systemOutput = plugin
        ? yield* plugin.trigger(
            "experimental.chat.system.transform",
            { sessionID: input.sessionID, model: input.model },
            { system },
          )
        : { system }
      if (input.timings) input.timings.system_transform_ms = elapsed(systemTransformStarted)
      const messages = [...input.messages]
      const messagesTransformStarted = performance.now()
      const messageOutput =
        plugin && input.transformMessages !== false
          ? yield* plugin.trigger(
              "experimental.chat.messages.transform",
              {
                sessionID: input.sessionID,
                agent: input.agent,
                model: input.model,
                provider: { id: String(input.model.provider) },
                message: input.message,
              },
              { messages },
            )
          : { messages }
      if (input.timings) input.timings.messages_transform_ms = elapsed(messagesTransformStarted)
      const paramsHookStarted = performance.now()
      const params = plugin
        ? yield* plugin.trigger(
            "chat.params",
            {
              sessionID: input.sessionID,
              agent: input.agent,
              model: input.model,
              provider: { id: String(input.model.provider) },
              message: input.message,
            },
            {
              temperature: generation?.temperature,
              topP: generation?.topP,
              topK: generation?.topK,
              frequencyPenalty: generation?.frequencyPenalty,
              presencePenalty: generation?.presencePenalty,
              seed: generation?.seed,
              stop: generation?.stop,
              maxOutputTokens: generation?.maxTokens,
              options: providerOptions ?? {},
            },
          )
        : { ...generation, maxOutputTokens: generation?.maxTokens, options: providerOptions ?? {} }
      if (input.timings) input.timings.params_hook_ms = elapsed(paramsHookStarted)
      const headers = {
        ...providerHeaders({
          provider: String(input.model.provider),
          sessionID: input.sessionID,
          requestID: input.requestID,
          projectID: location.project.id,
        }),
        ...input.headers,
      }
      const headersHookStarted = performance.now()
      const headerOutput = plugin
        ? yield* plugin.trigger(
            "chat.headers",
            {
              sessionID: input.sessionID,
              agent: input.agent,
              model: input.model,
              provider: { id: String(input.model.provider) },
              message: input.message,
            },
            { headers },
          )
        : { headers }
      if (input.timings) input.timings.headers_hook_ms = elapsed(headersHookStarted)
      return LLM.request({
        model: input.model,
        // Bind identity after plugin transforms, from the session read by this runner.
        system: [
          ...systemOutput.system,
          ...(input.purpose === "session" ? [SessionHostContext.render(input.hostSession)] : []),
        ]
          .filter((part) => part.length > 0)
          .map(SystemPart.make),
        messages: messageOutput.messages,
        tools: input.tools,
        toolChoice: input.toolChoice,
        generation: generationFromParams(params),
        providerOptions: providerOptionsFromHook(input.model, params.options),
        http: {
          // The session runner owns retry limits and visible Retried events.
          // Keep the executor's default retry behavior for other callers.
          retries: 0,
          ...(Object.keys(headerOutput.headers).length === 0
            ? Object.keys(input.body ?? {}).length === 0
              ? {}
              : { body: input.body }
            : { headers: headerOutput.headers, body: input.body }),
        },
      })
    })
    const loadSystemContext = (
      agent: AgentV2.Selection,
      sessionID: SessionSchema.ID,
      policy?: AgentV2.Info["tools"],
    ) => {
      const manual = agent.info?.instructions?.mode === "manual"
      return Effect.all(
        [
          systemContext.load(manual ? { exclude: [InstructionContext.contextKey] } : undefined),
          manual
            ? fs
              ? InstructionContext.manual(fs, location.directory, agent.info?.instructions?.files ?? [], [
                  location.project.directory,
                  Global.Path.config,
                ]).pipe(Effect.catch(() => Effect.succeed(SystemContext.empty)))
              : Effect.succeed(SystemContext.empty)
            : Effect.succeed(SystemContext.empty),
          skillGuidance.load(agent, policy),
          referenceGuidance.load(),
          memory && capabilities.reviewed_memory
            ? Effect.succeed(
                Memory.context(memory, {
                  projectID: location.project.id,
                  ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }),
                  sessionID,
                }),
              )
            : Effect.succeed(SystemContext.empty),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map(SystemContext.combine))
    }

    const materializeMessages = Effect.fn("SessionRunner.materializeAttachments")(function* (
      messages: readonly SessionMessage.Message[],
      sessionID: SessionSchema.ID,
    ) {
      if (!contentStore) return messages
      const budget = { remaining: ContentStore.MAX_PROVIDER_TOTAL_BYTES }
      const toolOutputBudget = { remaining: ToolOutputStore.MAX_PROVIDER_TOTAL_PREVIEW_BYTES }
      const materializeFile = Effect.fn("SessionRunner.materializeAttachment")(function* (file: FileAttachment) {
        if (!file.uri.startsWith(ContentStore.URI_PREFIX)) return file
        const located = yield* contentStore.locate({ uri: file.uri, sessionID })
        if (!located)
          return yield* new ContentStore.StorageError({
            operation: "read",
            resource: file.uri,
            cause: new Error("Managed attachment does not belong to this session"),
          })
        if (located.sizeBytes > ContentStore.MAX_PROVIDER_ATTACHMENT_BYTES || located.sizeBytes > budget.remaining)
          return yield* new ContentStore.StorageError({
            operation: "limit",
            resource: file.uri,
            cause: new Error("Provider attachment materialization budget exceeded"),
          })
        budget.remaining -= located.sizeBytes
        return yield* contentStore.materialize({
          file,
          sessionID,
          maxBytes: ContentStore.MAX_PROVIDER_ATTACHMENT_BYTES,
        })
      })
      return yield* Effect.forEach(
        messages,
        Effect.fnUntraced(function* (message): Effect.fn.Return<
          SessionMessage.Message,
          ContentStore.Error | ToolOutputStore.Error
        > {
          if (message.type === "user" && message.files?.length) {
            const files = yield* Effect.forEach(message.files, materializeFile, { concurrency: 1 })
            return new SessionMessage.User({ ...message, files })
          }
          if (message.type !== "assistant") return message
          const content = yield* Effect.forEach(
            message.content,
            Effect.fnUntraced(function* (part) {
              if (part.type !== "tool") return part
              if (part.provider?.executed !== true) {
                if (!("content" in part.state) || part.state.content.length === 0) return part
                const content = yield* Effect.forEach(
                  part.state.content,
                  Effect.fnUntraced(function* (item) {
                    if (item.type !== "file") return item
                    const file = yield* materializeFile(
                      FileAttachment.create({ uri: item.uri, mime: item.mime, name: item.name }),
                    )
                    return { ...item, uri: file.uri, mime: file.mime, name: file.name }
                  }),
                  { concurrency: 1 },
                )
                const state =
                  part.state.status === "running"
                    ? new SessionMessage.ToolStateRunning({ ...part.state, content })
                    : part.state.status === "completed"
                      ? new SessionMessage.ToolStateCompleted({ ...part.state, content })
                      : new SessionMessage.ToolStateError({ ...part.state, content })
                return new SessionMessage.AssistantTool({ ...part, state })
              }
              if (part.state.status !== "completed" && part.state.status !== "error") return part
              const stored = { structured: part.state.structured, content: part.state.content }
              const result =
                part.provider?.executed === true && ToolResultValue.is(part.state.result)
                  ? yield* materializeProviderResult(
                      resources,
                      sessionID,
                      part.state.result,
                      storedProviderResult(stored),
                      toolOutputBudget,
                      budget,
                    )
                  : part.state.result
              const output = removeStoredProviderResult(
                yield* resources.materialize({
                  sessionID,
                  output: stored,
                  budget: toolOutputBudget,
                  attachmentBudget: budget,
                }),
              )
              const structured = isRecord(output.structured) ? output.structured : { value: output.structured }
              const state =
                part.state.status === "completed"
                  ? new SessionMessage.ToolStateCompleted({ ...part.state, ...output, structured, result })
                  : new SessionMessage.ToolStateError({ ...part.state, ...output, structured, result })
              return new SessionMessage.AssistantTool({ ...part, state })
            }),
            { concurrency: 1 },
          )
          return new SessionMessage.Assistant({ ...message, content })
        }),
        { concurrency: 1 },
      )
    })

    const readAnalyses = Effect.fn("SessionRunner.readVisionAnalyses")(function* (sessionID: SessionSchema.ID) {
      const row = yield* db
        .select({ metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return VisionDelegation.decodeAnalyses(row?.metadata?.[VisionDelegation.SIDECAR_KEY])
    })

    const writeAnalysis = Effect.fn("SessionRunner.writeVisionAnalysis")(function* (
      sessionID: SessionSchema.ID,
      key: string,
      analysis: string,
    ) {
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select({ metadata: SessionTable.metadata })
                .from(SessionTable)
                .where(eq(SessionTable.id, sessionID))
                .get()
                .pipe(Effect.orDie)
              if (!row) return
              const metadata = row.metadata ?? {}
              const analyses = VisionDelegation.decodeAnalyses(metadata[VisionDelegation.SIDECAR_KEY])
              yield* tx
                .update(SessionTable)
                .set({
                  metadata: {
                    ...metadata,
                    [VisionDelegation.SIDECAR_KEY]: { ...analyses, [key]: analysis },
                  },
                })
                .where(eq(SessionTable.id, sessionID))
                .run()
                .pipe(Effect.orDie)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const imageInputForRef = Effect.fn("SessionRunner.imageInputForRef")(function* (ref: ModelV2.Ref | undefined) {
      if (!catalog || !ref) return undefined
      const info = yield* catalog.model.get(ref.providerID, ref.id).pipe(Effect.option)
      if (Option.isNone(info)) return undefined
      return { input: info.value.capabilities.input }
    })

    const analyzeWithCandidate = Effect.fn("SessionRunner.analyzeImage")(function* (
      session: SessionSchema.Info,
      candidate: VisionDelegation.Candidate,
      pending: VisionDelegation.PendingImage,
      vision: ConfigVision.Info | undefined,
    ) {
      const resolved = yield* withVisionBoundary({
        sessionID: session.id,
        phase: "model_resolve",
        timeoutMs: visionModelResolveTimeoutMs(),
        effect: models.resolve({ ...session, model: VisionDelegation.visionRef(candidate) }),
        fallback: undefined,
        model: candidate.model,
        messageID: pending.message.id,
      })
      if (!resolved) return undefined
      const candidateInput = yield* imageInputForRef(VisionDelegation.visionRef(candidate))
      if (!modelSupportsFile(resolved, pending.file, candidateInput)) return undefined
      return yield* withVisionBoundary({
        sessionID: session.id,
        phase: "stream",
        timeoutMs: visionStreamTimeoutMs(),
        fallback: undefined,
        model: candidate.model,
        messageID: pending.message.id,
        effect: Effect.gen(function* () {
          const template = VisionDelegation.resolveTemplate(vision)
          const system = VisionDelegation.buildPrompt(template, pending.userText, pending.file.name)
          const request = yield* prepareLLMRequest({
            purpose: "auxiliary",
            sessionID: session.id,
            agent: "vision",
            requestID: pending.message.id,
            model: resolved,
            system: [system],
            messages: [Message.make({ role: "user", content: [media(pending.file)] })],
            tools: [],
            transformMessages: false,
          })
          const chunks: string[] = []
          let failed = false
          yield* llm.stream(request).pipe(
            Stream.runForEach((event) => {
              if (LLMEvent.is.providerError(event)) failed = true
              else if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
              return Effect.void
            }),
          )
          return failed || chunks.length === 0 ? undefined : chunks.join("").trim()
        }),
      })
    })

    // Transparently delegate image analysis to a configured vision model when the active model
    // cannot ingest images. Results are persisted to the session metadata sidecar so resume and
    // multi-turn conversations reuse the analysis instead of re-running it each turn.
    const visionDelegation = Effect.fn("SessionRunner.visionDelegation")(function* (
      messages: readonly SessionMessage.Message[],
      targetModel: Model,
      session: SessionSchema.Info,
    ) {
      const vision = Config.latest(configEntries, "vision")
      if (!vision?.enabled) return messages
      if (VisionDelegation.candidates(vision).length === 0) return messages
      const targetInput = yield* imageInputForRef(session.model)
      const analyses = yield* readAnalyses(session.id)
      let enriched = messages
      for (const pending of VisionDelegation.pendingImages(messages, targetModel, targetInput)) {
        const existing = analyses[VisionDelegation.sidecarKey(pending.message.id, pending.fileIndex)]
        if (existing)
          enriched = VisionDelegation.withAnalysis(enriched, pending.message.id, pending.fileIndex, existing)
      }
      for (const pending of VisionDelegation.pendingImages(enriched, targetModel, targetInput)) {
        for (const candidate of VisionDelegation.candidates(vision)) {
          const analysis = yield* analyzeWithCandidate(session, candidate, pending, vision)
          if (!analysis) continue
          yield* writeAnalysis(session.id, VisionDelegation.sidecarKey(pending.message.id, pending.fileIndex), analysis)
          enriched = VisionDelegation.withAnalysis(enriched, pending.message.id, pending.fileIndex, analysis)
          break
        }
      }
      return enriched
    })

    const maybeGenerateTitle = Effect.fn("SessionRunner.generateTitle")(function* (sessionID: SessionSchema.ID) {
      const session = yield* getSession(sessionID)
      if (session.parentID || !isDefaultTitle(session.title)) return
      const defaultTitle = session.title
      const context = yield* getContext(sessionID)
      const firstUserIndex = context.findIndex((message) => message.type === "user")
      if (firstUserIndex === -1) return
      const firstUser = context[firstUserIndex]
      if (firstUser.type !== "user") return
      const fallbackTitle = cleanTitle(firstUser.text.replace(/\s+/g, " "))
      const titleAgent = yield* agents.get(AgentV2.ID.make("title"))
      const generated = titleAgent
        ? yield* Effect.gen(function* () {
            const model = titleAgent.model
              ? yield* models.resolve({ ...session, model: titleAgent.model })
              : yield* models
                  .resolveSmall(session)
                  .pipe(
                    Effect.flatMap((model) =>
                      Option.isSome(model) ? Effect.succeed(model.value) : models.resolve(session),
                    ),
                  )
            const generate = (generation?: GenerationOptionsFields) =>
              Effect.gen(function* () {
                const chunks: string[] = []
                let failure: string | undefined
                const request = yield* prepareLLMRequest({
                  purpose: "auxiliary",
                  sessionID,
                  agent: String(titleAgent.id),
                  requestID: firstUser.id,
                  model,
                  system: titleAgent.system ? [titleAgent.system] : [],
                  messages: [
                    Message.user("Generate a title for this conversation:\n"),
                    ...toLLMMessages(
                      yield* materializeMessages(context.slice(0, firstUserIndex + 1), sessionID),
                      model,
                    ),
                  ],
                  tools: [],
                  generation,
                  message: firstUser,
                  transformMessages: false,
                })
                yield* llm.stream(request).pipe(
                  Stream.runForEach((event) => {
                    if (LLMEvent.is.providerError(event)) failure = event.message
                    if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
                    return Effect.void
                  }),
                )
                const title = cleanTitle(chunks.join(""))
                return {
                  title: failure ? undefined : title,
                  failure: failure ?? (title ? undefined : "empty output"),
                }
              }).pipe(
                Effect.catchCause((cause) => {
                  if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
                  const error = Cause.squash(cause)
                  return Effect.succeed({
                    title: undefined,
                    failure: error instanceof Error ? error.message : String(error),
                  })
                }),
              )
            const first = yield* generate({ maxTokens: TITLE_OUTPUT_TOKENS })
            if (first.failure !== "empty output" && !unsupportedTitleOutputLimit(first.failure)) return first
            yield* Effect.logWarning("session title generation retrying without output token limit", { sessionID })
            // An explicit undefined overrides a route-level default maxTokens, which is
            // exactly the parameter combination the provider just rejected.
            return yield* generate({ maxTokens: undefined })
          }).pipe(
            Effect.timeoutOrElse({
              duration: "15 seconds",
              orElse: () => Effect.succeed({ title: undefined, failure: "timeout" }),
            }),
            Effect.catchCause((cause) => {
              if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
              const error = Cause.squash(cause)
              return Effect.succeed({
                title: undefined,
                failure: error instanceof Error ? error.message : String(error),
              })
            }),
          )
        : { title: undefined, failure: "title agent unavailable" }
      const title = generated.title ?? fallbackTitle
      if (!title) return
      if (!generated.title)
        yield* Effect.logWarning("session title generation used prompt fallback", {
          sessionID,
          reason: generated.failure,
        })
      if (!shouldPublishGeneratedTitle((yield* getSession(sessionID)).title, defaultTitle)) return
      yield* events.publish(
        SessionEvent.TitleUpdated,
        {
          sessionID,
          timestamp: yield* DateTime.now,
          title,
        },
        { metadata: { [SessionEvent.GeneratedTitleExpectedMetadataKey]: defaultTitle } },
      )
    })

    const generateTitleSafely = Effect.fn("SessionRunner.generateTitleSafely")(function* (sessionID: SessionSchema.ID) {
      yield* maybeGenerateTitle(sessionID).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Cause.squash(cause) instanceof SessionEvent.GeneratedTitleSuperseded
              ? Effect.void
              : Effect.logError("failed to generate session title", { error: Cause.squash(cause) }),
        ),
      )
    })

    const scheduleTitle = Effect.fn("SessionRunner.scheduleTitle")(function* (sessionID: SessionSchema.ID) {
      if (titleInFlight.has(sessionID)) return
      titleInFlight.add(sessionID)
      forkTitle(
        generateTitleSafely(sessionID).pipe(
          Effect.ignore,
          Effect.ensuring(Effect.sync(() => titleInFlight.delete(sessionID))),
        ),
      )
    })

    const updateSummaryFromSnapshots = Effect.fn("SessionRunner.updateSummaryFromSnapshots")(function* (
      sessionID: SessionSchema.ID,
      sessionLocation: Location.Ref,
      from: string,
      to: string,
    ) {
      if (!snapshots) return
      const diffs = yield* withSnapshotBoundary("summary", snapshots.diffFull({ location: sessionLocation, from, to }))
      if (!diffs || diffs.length === 0) return
      yield* events.publish(SessionEvent.SummaryUpdated, {
        sessionID,
        timestamp: yield* DateTime.now,
        summary: {
          additions: diffs.reduce((sum, diff) => sum + diff.additions, 0),
          deletions: diffs.reduce((sum, diff) => sum + diff.deletions, 0),
          files: diffs.length,
          diffs,
        },
      })
    })

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      options?: {
        readonly recoverOverflow?: typeof compaction.compactAfterOverflow
        readonly history?: RunnerHistorySnapshot
        readonly finalTurn?: "step-limit" | "structured-retry" | "tool-budget"
        readonly providerRecovery?: ReturnType<typeof SessionResume.recoveryBudget>
        readonly continuation?: SessionTurnContinuation.Info
      },
    ) {
      const recoverOverflow = options?.recoverOverflow
      const providerRecovery = options?.providerRecovery ?? SessionResume.recoveryBudget()
      let continuation = options?.continuation ?? (yield* SessionTurnContinuation.pending(db, sessionID))
      const requestAssemblyStarted = performance.now()
      const assemblyTimings: RequestAssemblyTimings = {
        session_load_ms: 0,
        plugin_boot_ms: 0,
        agent_selection_ms: 0,
        context_epoch_ms: 0,
        context_source_load_ms: 0,
        context_snapshot_decode_ms: 0,
        context_compare_ms: 0,
        context_fence_ms: 0,
        model_resolution_ms: 0,
        model_cost_ms: 0,
        model_capabilities_ms: 0,
        history_bound_ms: 0,
        mcp_ensure_ms: 0,
        permission_materialization_ms: 0,
        tool_materialization_ms: 0,
        snapshot_start_ms: 0,
        message_materialization_ms: 0,
        vision_delegation_ms: 0,
        model_messages_ms: 0,
        prepare_llm_request_ms: 0,
        hook_system_transform_ms: 0,
        hook_messages_transform_ms: 0,
        hook_params_ms: 0,
        hook_headers_ms: 0,
      }
      const sessionLoadStarted = performance.now()
      const initial = yield* getSession(sessionID)
      if (!Location.same(initial.location, location)) return yield* Effect.interrupt
      assemblyTimings.session_load_ms = elapsed(sessionLoadStarted)
      // Agent defaults and configured overrides are installed asynchronously by PluginBoot.
      // Selecting before it settles returns only the requested ID with no Info, which silently
      // falls back to the full build context and tool set. This is especially harmful for compact
      // local-model agents because their explicit prompt/context/tool policy is then ignored.
      const pluginBootStarted = performance.now()
      if (pluginBoot) yield* pluginBoot.wait()
      assemblyTimings.plugin_boot_ms = elapsed(pluginBootStarted)
      const snapshotEnabled = snapshots !== undefined && Config.latest(configEntries, "snapshots") !== false
      const agentSelectionStarted = performance.now()
      const preflightAgent = yield* agents.select(initial.agent)
      yield* SessionContextEpoch.resetIfAgentChanged(db, initial.id, preflightAgent.id)
      if (preflightAgent.info?.instructions?.mode === "manual" && preflightAgent.info.instructions.files.length === 0)
        yield* SessionContextEpoch.resetIfEmptyManualInstructionsLeaked(db, initial.id)
      assemblyTimings.agent_selection_ms = elapsed(agentSelectionStarted)
      const contextEpochStarted = performance.now()
      const preinitialized = yield* SessionContextEpoch.initialize(
        db,
        loadSystemContext(preflightAgent, initial.id, initial.agentPolicy?.tools),
        initial.id,
        initial.location,
        preflightAgent.id,
      ).pipe(retryAgentMismatch(promotion))
      assemblyTimings.context_epoch_ms = elapsed(contextEpochStarted)
      const ready = yield* getSession(sessionID)
      if (!Location.same(ready.location, location)) return yield* Effect.interrupt
      if ((yield* agents.select(ready.agent)).id !== preflightAgent.id || !sameModel(ready.model, initial.model))
        return yield* Effect.die(rebuildPreparedTurn(promotion))
      let needsContinuation = false
      let toolBudgetExceeded = false
      let invalidToolInput = false
      let invalidStructuredOutput = false
      let finalTurnToolRejected = false
      let capabilityRebuildRequested = false
      // Tool-call ids observed in this provider turn. A tool-error whose call
      // was never announced failed before its arguments could be used at all.
      const calledToolIds = new Set<string>()
      let promotedInput = false
      if (promotion) {
        const cutoff = yield* SessionInput.latestSeq(db, ready.id)
        if (promotion === "steer") promotedInput = (yield* SessionInput.promoteSteers(db, events, ready.id, cutoff)) > 0
        if (promotion === "queue") {
          const queued = yield* SessionInput.promoteNextQueued(db, events, ready.id)
          const steers = yield* SessionInput.promoteSteers(db, events, ready.id, cutoff)
          promotedInput = queued || steers > 0
        }
      }
      if (promotedInput) {
        yield* SessionTurnContinuation.reset(db, ready.id)
        continuation = undefined
      }
      // Promotion can persist the first model/agent selected for a migrated session and invalidate the
      // preinitialized epoch. Reconcile that epoch before assembling history, tools, and request metrics.
      const session = promotedInput ? yield* getSession(sessionID) : ready
      const finalAgentSelectionStarted = performance.now()
      const agent = yield* agents.select(session.agent)
      assemblyTimings.agent_selection_ms += elapsed(finalAgentSelectionStarted)
      const initializedStarted = performance.now()
      const initialized =
        agent.id !== preflightAgent.id
          ? yield* SessionContextEpoch.initialize(
              db,
              loadSystemContext(agent, session.id, session.agentPolicy?.tools),
              session.id,
              session.location,
              agent.id,
            ).pipe(retryAgentMismatch(undefined))
          : preinitialized && (yield* SessionContextEpoch.current(db, session.id, agent.id, preinitialized.revision))
            ? preinitialized
            : undefined
      assemblyTimings.context_epoch_ms += elapsed(initializedStarted)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      const clearToolFibers = FiberSet.clear(toolFibers)
      const awaitAllToolFibers = awaitToolFibers(toolFibers)
      const questionDismissed = yield* Deferred.make<void>()
      const contextEpochPrepareStarted = performance.now()
      const contextEpochPhases: SessionContextEpoch.ContextEpochPhases = {
        load_ms: 0,
        snapshot_decode_ms: 0,
        compare_ms: 0,
        fence_ms: 0,
      }
      const system =
        initialized ??
        (yield* SessionContextEpoch.prepare(
          db,
          events,
          loadSystemContext(agent, session.id, session.agentPolicy?.tools),
          session.id,
          session.location,
          agent.id,
          contextEpochPhases,
        ).pipe(retryAgentMismatch(undefined)))
      if (!initialized) {
        assemblyTimings.context_epoch_ms += elapsed(contextEpochPrepareStarted)
        assemblyTimings.context_source_load_ms = contextEpochPhases.load_ms
        assemblyTimings.context_snapshot_decode_ms = contextEpochPhases.snapshot_decode_ms
        assemblyTimings.context_compare_ms = contextEpochPhases.compare_ms
        assemblyTimings.context_fence_ms = contextEpochPhases.fence_ms
      }
      const current = yield* getSession(sessionID)
      if ((yield* agents.select(current.agent)).id !== agent.id || !sameModel(current.model, session.model))
        return yield* Effect.die(rebuildPreparedTurn())
      // A session that never chose a model follows its agent's configured model,
      // including the Settings chain. Direct REST or desktop-bridge sessions are
      // created without a model and would otherwise silently run on the newest
      // catalog model behind the user's configured default chain. Persisting the
      // adopted ref through ModelSwitched keeps every downstream path on the
      // regular session-model contract; the rebuild reloads the persisted ref.
      if (!current.model && agent.info?.model) {
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: session.id,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: agent.info.model,
        })
        yield* Effect.logWarning("session runner adopted the agent's configured model for a model-less session", {
          sessionID: session.id,
          agent: agent.id,
          providerID: agent.info.model.providerID,
          modelID: agent.info.model.id,
          chain: agent.info.model.chain?.id,
        })
        return yield* Effect.die(rebuildPreparedTurn(promotion))
      }
      const advanceMissingModel = (error: Catalog.ModelNotFoundError | Catalog.ProviderNotFoundError) => {
        const next = session.model && nextChainModel(session.model)
        if (!next || providerRecovery.next() === undefined) return Effect.fail(error)
        return Effect.gen(function* () {
          yield* events.publish(SessionEvent.ModelSwitched, {
            sessionID: session.id,
            messageID: SessionMessage.ID.create(),
            timestamp: yield* DateTime.now,
            model: next,
          })
          yield* Effect.logWarning("session runner advancing persisted model chain after catalog resolution failure", {
            sessionID: session.id,
            from: session.model,
            to: next,
          })
          return yield* Effect.die(rebuildPreparedTurn())
        })
      }
      const modelResolutionStarted = performance.now()
      const model = yield* models.resolve(session).pipe(
        Effect.timeoutOrElse({
          duration: modelResolveInitTimeoutMs(),
          orElse: () =>
            Effect.fail(
              new SessionRunnerModel.ModelResolveTimeoutError({
                sessionID: session.id,
                providerID: session.model?.providerID,
                modelID: session.model?.id,
                timeoutMs: modelResolveInitTimeoutMs(),
              }),
            ),
        }),
        Effect.catchTag("SessionRunnerModel.ModelResolveTimeoutError", (error) =>
          Effect.gen(function* () {
            // The deadline can span seconds, and a concurrent user or steer
            // switch may have persisted a newer model while resolve was
            // stalled. Rebuild against that model instead of publishing the
            // captured snapshot's chain fallback over it.
            const reloaded = yield* getSession(sessionID)
            if (!sameModel(reloaded.model, session.model)) return yield* Effect.die(rebuildPreparedTurn())
            const observed = reloaded.model
            if (!observed) return yield* Effect.fail(error)
            const next = reloaded.model && nextChainModel(reloaded.model)
            if (!next || providerRecovery.next() === undefined) return yield* Effect.fail(error)
            // The fallback commits only while the persisted model is still the
            // one this attempt captured. A concurrent newer switch that commits
            // first supersedes it atomically inside the projection transaction;
            // the turn then rebuilds against that newer model instead.
            yield* events
              .publish(
                SessionEvent.ModelSwitched,
                {
                  sessionID: session.id,
                  messageID: SessionMessage.ID.create(),
                  timestamp: yield* DateTime.now,
                  model: next,
                },
                {
                  metadata: {
                    [SessionEvent.ModelSwitchedExpectedMetadataKey]: { ...observed },
                  },
                },
              )
              .pipe(
                Effect.catchCause((cause) => {
                  if (Cause.squash(cause) instanceof SessionEvent.ModelSwitchSuperseded)
                    return Effect.die(rebuildPreparedTurn())
                  return Effect.failCause(cause)
                }),
              )
            yield* Effect.logWarning(
              "session runner advancing persisted model chain after pre-provider model resolve timeout",
              {
                sessionID: session.id,
                from: session.model,
                to: next,
              },
            )
            return yield* Effect.die(rebuildPreparedTurn())
          }),
        ),
        Effect.catchTag("CatalogV2.ModelNotFound", advanceMissingModel),
        Effect.catchTag("CatalogV2.ProviderNotFound", advanceMissingModel),
        Effect.catchTag("Integration.Authorization", (error) => {
          const next = session.model && nextChainModel(session.model)
          if (!next || providerRecovery.next() === undefined) return Effect.fail(error)
          return Effect.gen(function* () {
            yield* events.publish(SessionEvent.ModelSwitched, {
              sessionID: session.id,
              messageID: SessionMessage.ID.create(),
              timestamp: yield* DateTime.now,
              model: next,
            })
            yield* Effect.logWarning(
              "session runner advancing persisted model chain after authorization refresh failure",
              {
                sessionID: session.id,
                from: session.model,
                to: next,
              },
            )
            return yield* Effect.die(rebuildPreparedTurn())
          })
        }),
      )
      assemblyTimings.model_resolution_ms = elapsed(modelResolutionStarted)
      // Only an explicitly selected chain authorizes provider fallback. A direct
      // selection must not inherit the agent's chain after a provider failure.
      const nextConfiguredModel = () => {
        let current = configuredModelRef(session.model, agent.info?.model, model)
        while (true) {
          const next = nextChainModel(current)
          if (!next) return
          if (!breakers.shouldSkip(next.providerID)) return next
          current = next
        }
      }
      const agentRequest = agent.info
        ? normalizeAgentRequest(model, agent.info.request.body, plugin?.requestProfiles())
        : undefined
      const modelCostStarted = performance.now()
      const modelCost = yield* models.cost(session)
      assemblyTimings.model_cost_ms = elapsed(modelCostStarted)
      const modelCapabilitiesStarted = performance.now()
      const modelCapabilities = yield* models.capabilities(session)
      assemblyTimings.model_capabilities_ms = elapsed(modelCapabilitiesStarted)
      const cachedHistory =
        !promotedInput &&
        options?.history?.baselineSeq === system.baselineSeq &&
        options.history.contextRevision === system.revision
          ? options.history
          : undefined
      const historyLoadStarted = Date.now()
      const loadedEntries =
        cachedHistory?.entries ?? (yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq))
      const historyLoadMs = cachedHistory ? 0 : Date.now() - historyLoadStarted
      const historyBoundStarted = performance.now()
      const historyLimit = SessionCompaction.runnerHistoryTokenLimit(model)
      const boundedHistory = SessionCompaction.boundRunnerHistory(loadedEntries, historyLimit, model)
      const historyEstimateTokens = boundedHistory.estimatedTokens
      assemblyTimings.history_bound_ms = elapsed(historyBoundStarted)
      const historyCompactionRequest = LLM.request({
        model,
        messages: [],
        tools: [],
        generation: agentRequest?.generation,
      })
      if (
        historyEstimateTokens > historyLimit &&
        (yield* compaction.compactAfterOverflow({
          sessionID: session.id,
          entries: loadedEntries,
          model,
          request: historyCompactionRequest,
        }))
      ) {
        if (optimization.features.runner_request_metrics)
          yield* Effect.logInfo("session runner compaction triggered", {
            sessionID: session.id,
            reason: "history-preflight",
            historyEstimateTokens,
            historyLimit,
          })
        return yield* Effect.die(continueAfterOverflowCompaction)
      }
      const entries = boundedHistory.entries
      const context = entries.map((entry) => entry.message)
      const lastUser = context.findLast((message): message is SessionMessage.User => message.type === "user")
      const structuredOutput = lastUser?.format?.type === "json_schema" ? lastUser.format : undefined
      const effectiveToolPolicy = session.agentPolicy?.tools ?? agent.info?.tools
      const mcpEnsureStarted = performance.now()
      if (mcpTools) yield* mcpTools.ensurePolicy(effectiveToolPolicy).pipe(Effect.orDie)
      assemblyTimings.mcp_ensure_ms = elapsed(mcpEnsureStarted)
      if (lastUser && capabilityLeases) {
        yield* CapabilityLease.activateFromSlash({
          sessionID: session.id,
          agent: agent.id,
          text: lastUser.text,
        })
      }
      const capabilitySnapshotBeforeTools = capabilityLeases
        ? yield* capabilityLeases.snapshot(session.id, agent.id)
        : undefined
      const permissionMaterializationStarted = performance.now()
      const materializationRules = yield* permission
        .materializationRules({ sessionID: session.id, agent: agent.id })
        .pipe(Effect.orDie)
      assemblyTimings.permission_materialization_ms = elapsed(permissionMaterializationStarted)
      const toolMaterializationStarted = performance.now()
      const toolMaterialization = yield* tools.materialize(materializationRules, effectiveToolPolicy, {
        sessionID: session.id,
        agent: agent.id,
        // Contract-scoped tools (scheduler result contract) are advertised only
        // while the latest user prompt still carries their marker; a plain chat
        // message hides them again.
        lastUserText: lastUser?.text,
      })
      assemblyTimings.tool_materialization_ms = elapsed(toolMaterializationStarted)
      const snapshotStartStarted = performance.now()
      const startSnapshotFiber =
        snapshotEnabled && needsSnapshotForTools(toolMaterialization.definitions)
          ? yield* withSnapshotBoundary("start", snapshots.track(initial.location)).pipe(Effect.forkScoped)
          : undefined
      assemblyTimings.snapshot_start_ms = elapsed(snapshotStartStarted)
      const structuredOutputTool = structuredOutput ? createStructuredOutputTool(structuredOutput.schema) : undefined
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const requestSystem = [
        agent.info?.system,
        system.baseline,
        Number.isFinite(historyLimit) ? TOOL_OUTPUT_CONTEXT_GUIDANCE : undefined,
        boundedHistory.omittedEntries > 0
          ? "Older session history was omitted from this provider context to keep memory bounded; it remains stored durably. Ask the user for missing details if needed."
          : undefined,
        // The warning stays byte-identical as history grows, preserving the
        // reusable system prefix after the pressure threshold is crossed.
        Number.isFinite(historyLimit) && historyEstimateTokens > historyLimit / 4
          ? contextPressureWarning(historyLimit)
          : undefined,
        continuation
          ? "The previous turn was judged incomplete. Continue the original unfinished request from the conversation history and summary now. Use the available tools to complete the remaining work. Do not ask the user for new input or wait for another instruction; finish the work and then provide a final report."
          : undefined,
        options?.finalTurn === "step-limit"
          ? "The configured agent step limit has been reached. Investigation tools are unavailable for this final turn. Return the final answer now using only the evidence already present in the conversation. State any remaining uncertainty instead of requesting or inventing more evidence."
          : options?.finalTurn === "structured-retry"
            ? "The requested structured output is still missing or did not match the requested schema. Investigation tools are unavailable for this retry turn. Call StructuredOutput now with the final answer derived from the evidence already present in the conversation. Record remaining uncertainty inside the structured fields instead of requesting more evidence."
            : options?.finalTurn === "tool-budget"
              ? "The investigation tool budget has been exhausted. Investigation tools are unavailable for this final turn. Synthesize the best final answer now from the evidence already present in the conversation. State unfinished work and uncertainty explicitly instead of requesting more evidence or another tool call."
              : undefined,
      ]
        .concat(structuredOutput ? [STRUCTURED_OUTPUT_SYSTEM_PROMPT] : [])
        .filter((part): part is string => part !== undefined && part.length > 0)
      const modelMessagesStarted = performance.now()
      const messageMaterializationStarted = performance.now()
      const materializedMessages = yield* withMessageMaterializationBoundary(
        session.id,
        materializeMessages(context, session.id),
      )
      assemblyTimings.message_materialization_ms = elapsed(messageMaterializationStarted)
      const visionDelegationStarted = performance.now()
      const visionEnriched = yield* withVisionBoundary({
        sessionID: session.id,
        phase: "delegation",
        timeoutMs: visionDelegationTimeoutMs(),
        effect: visionDelegation(materializedMessages, model, session),
        fallback: materializedMessages,
        model: model.id,
      })
      assemblyTimings.vision_delegation_ms = elapsed(visionDelegationStarted)
      const requestMessages = toLLMMessagesWithPostCompactionSteerReminder(
        visionEnriched,
        model,
        yield* imageInputForRef(session.model),
      )
      const modelMessagesMs = elapsed(modelMessagesStarted)
      assemblyTimings.model_messages_ms = modelMessagesMs
      const composedRequestTools = options?.finalTurn
        ? structuredOutputTool
          ? [structuredOutputTool]
          : []
        : structuredOutputTool
          ? [...toolMaterialization.definitions, structuredOutputTool]
          : modelCapabilities.tools
            ? toolMaterialization.definitions
            : []
      const providerFacingTools = providerFacingRequestTools(model, composedRequestTools)
      const prepareTimings: PrepareLLMRequestTimings = {
        system_transform_ms: 0,
        messages_transform_ms: 0,
        params_hook_ms: 0,
        headers_hook_ms: 0,
      }
      const prepareLLMRequestStarted = performance.now()
      const request = yield* prepareLLMRequest({
        purpose: "session",
        hostSession: session,
        sessionID: session.id,
        agent: String(agent.id),
        requestID: lastUser?.id,
        model,
        system: requestSystem,
        message: lastUser,
        messages: requestMessages,
        tools: providerFacingTools,
        toolChoice: structuredOutputTool ? "required" : undefined,
        generation: agentRequest?.generation,
        providerOptions: mergeProviderOptions(
          agentRequest && providerOptionsFromHook(model, agentRequest.options),
          providerOptionNamespace(model) === "openrouter"
            ? { openrouter: { promptCacheKey } }
            : { openai: { promptCacheKey } },
        ),
        headers: agent.info?.request.headers,
        body: providerRequestBody(model, providerFacingTools, agentRequest?.body),
        timings: prepareTimings,
      })
      // Activate only exact read outputs retained after bounds and plugin transforms.
      // Freeze once per provider request: parallel sibling calls cannot adopt each
      // other's later reads/writes by looking up a newer index at execution time.
      const deliveredFileKnowledge = yield* Effect.cached(
        FileKnowledge.make(db).deliver(session.id, FileKnowledge.retainedReads(request.messages)).pipe(Effect.orDie),
      )
      assemblyTimings.prepare_llm_request_ms = elapsed(prepareLLMRequestStarted)
      assemblyTimings.hook_system_transform_ms = prepareTimings.system_transform_ms
      assemblyTimings.hook_messages_transform_ms = prepareTimings.messages_transform_ms
      assemblyTimings.hook_params_ms = prepareTimings.params_hook_ms
      assemblyTimings.hook_headers_ms = prepareTimings.headers_hook_ms
      const systemText = request.system.map((part) => part.text).join("\n")
      const footprint = { system: request.system, messages: request.messages, tools: request.tools }
      const contextEstimateStarted = performance.now()
      const contextEstimateTokens = Token.estimateFootprint(footprint)
      const contextEstimateMs = performance.now() - contextEstimateStarted
      const toolSchemaBytes = Buffer.byteLength(JSON.stringify(toolMaterialization.definitions), "utf8")
      const toolIDs = toolMaterialization.definitions.map((tool) => tool.name).toSorted()
      const requestMetrics = {
        sessionID: session.id,
        model: model.id,
        provider: model.provider,
        history_load_ms: historyLoadMs,
        request_assembly_ms: elapsed(requestAssemblyStarted),
        message_count: request.messages.length,
        system_prompt_chars: systemText.length,
        system_prompt_estimate_tokens: Token.estimate(systemText),
        tool_count: toolMaterialization.definitions.length,
        tool_ids: toolIDs,
        surface_available: toolIDs.includes(SurfaceTool.name),
        tool_policy_source: session.agentPolicy?.source.type ?? (agent.info?.tools ? "agent" : "default"),
        tool_schema_bytes: toolSchemaBytes,
        prepared_tool_schema_bytes: Buffer.byteLength(JSON.stringify(request.tools), "utf8"),
        context_budget: optimization.features.runner_request_metrics
          ? {
              boundary: "prepared-runner",
              system: ContextBudget.measure(systemText),
              messages: ContextBudget.measure(JSON.stringify(request.messages)),
              tools: ContextBudget.tools(request.tools ?? []),
            }
          : undefined,
        context_estimate_ms: contextEstimateMs,
        context_estimate_tokens: contextEstimateTokens,
        history_estimate_tokens: historyEstimateTokens,
        history_limit_tokens: historyLimit,
        history_omitted_entries: boundedHistory.omittedEntries,
        context_epoch_revision: system.revision,
        context_baseline_seq: system.baselineSeq,
        ...assemblyTimings,
      }
      if (optimization.features.runner_request_metrics) {
        yield* Effect.logInfo("session runner request metrics", requestMetrics)
      }
      yield* Perf.record({ kind: "request_assembly", source: "core-session-runner", ...requestMetrics })
      if (yield* SessionInput.hasPending(db, session.id, "steer"))
        return yield* Effect.die(rebuildPreparedTurn("steer"))
      const automaticCompactionRequired = compaction.requiresAutomaticCompaction({
        sessionID: session.id,
        entries,
        model,
        request,
        contextEstimateTokens,
      })
      if (
        yield* compaction.compactIfNeeded({
          sessionID: session.id,
          entries,
          model,
          request,
          contextEstimateTokens,
        })
      ) {
        if (optimization.features.runner_request_metrics)
          yield* Effect.logInfo("session runner compaction triggered", { sessionID: session.id, reason: "auto" })
        return yield* Effect.die(continueAfterOverflowCompaction)
      }
      if (
        SessionCompaction.exceedsInputTokenLimit({
          sessionID: session.id,
          entries,
          model,
          request,
          contextEstimateTokens,
        })
      ) {
        if (
          recoverOverflow &&
          !automaticCompactionRequired &&
          (yield* recoverOverflow({ sessionID: session.id, entries, model, request }))
        ) {
          if (optimization.features.runner_request_metrics)
            yield* Effect.logInfo("session runner compaction triggered", { sessionID: session.id, reason: "preflight" })
          return yield* Effect.die(continueAfterOverflowCompaction)
        }
        const publisher = createLLMEventPublisher(events, {
          sessionID: session.id,
          agent: agent.id,
          model: {
            id: ModelV2.ID.make(model.id),
            providerID: ProviderV2.ID.make(model.provider),
            ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
          },
          cost: modelCost,
        })
        yield* publisher.publish(
          LLMEvent.providerError({
            message: preflightContextOverflowMessage(model, request, contextEstimateTokens),
            classification: "context-overflow",
          }),
        )
        return yield* Effect.fail(
          new LLMError({
            module: "SessionRunner",
            method: "runTurn",
            reason: new InvalidRequestReason({
              message: preflightContextOverflowMessage(model, request, contextEstimateTokens),
              classification: "context-overflow",
            }),
          }),
        )
      }
      const startSnapshot = startSnapshotFiber ? yield* Fiber.join(startSnapshotFiber) : undefined
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        cost: modelCost,
        snapshot: startSnapshot,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let structuredValue: unknown
      let missingStructuredOutput = false
      let continuationHistory: RunnerHistorySnapshot | undefined
      let recoveredRetryableFailure = false
      let continuationRetryDelayMs: number | undefined
      let workspaceMutationAttempted = false
      // Provider streaming time across attempts: wall-clock between the first and
      // last model-output token of each attempt, excluding request assembly,
      // first-token latency, tool execution, and inter-attempt recovery waits.
      let providerGenerationMs = 0
      if (!(yield* SessionContextEpoch.current(db, session.id, agent.id, system.revision)))
        return yield* Effect.die(rebuildPreparedTurn())
      if (yield* SessionInput.hasPending(db, session.id, "steer"))
        return yield* Effect.die(rebuildPreparedTurn("steer"))
      const runProviderStream: (attempt: number) => Effect.Effect<boolean, RunError> = Effect.fn(
        "SessionRunner.runProviderStream",
      )(function* (attempt: number) {
        let overflowFailure: ProviderErrorEvent | undefined
        let retryFailure: ProviderErrorEvent | undefined
        let continuationFailure: ProviderErrorEvent | undefined
        let chainFailure: ProviderErrorEvent | undefined
        let providerEventFailure: ProviderErrorEvent | undefined
        const providerStarted = Date.now()
        let providerFirstEventAt: number | undefined
        let providerTTFBMs: number | undefined
        let providerFirstContentAt: number | undefined
        let providerLastContentAt: number | undefined
        let providerContentObserved = false
        let providerEventCount = 0
        let providerDeltaCount = 0
        const publishedDeltaStart = publisher.publishedDeltaCount()
        let providerToolCalls = 0
        let blockingQuestionStarted = false
        let blockingQuestionCompleted = false
        let blockingQuestionCancelled = false
        const idleTimeouts = providerStreamIdleTimeouts(model)
        // Moves the current attempt's streaming window into the cross-attempt total
        // and reports the measured value for one Step.Ended. Resetting the window
        // markers makes the later post-race accumulation idempotent. Steps without
        // any streamed content stay unknown instead of inventing a zero sample.
        const takeGenerationMs = () => {
          const window =
            providerFirstContentAt !== undefined && providerLastContentAt !== undefined
              ? Math.max(0, providerLastContentAt - providerFirstContentAt)
              : 0
          providerGenerationMs += window
          providerFirstContentAt = undefined
          providerLastContentAt = undefined
          const observed = providerContentObserved
          providerContentObserved = false
          return observed ? providerGenerationMs : undefined
        }
        const providerStream = withProviderStreamIdleTimeout(
          llm.stream(request),
          idleTimeouts.initialMs,
          idleTimeouts.afterProgressMs,
        ).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              const now = Date.now()
              providerEventCount++
              providerFirstEventAt ??= now
              // Model-output tokens only. Hosted tools (for example web_search)
              // emit tool-call after provider-side execution, so bare tool-call
              // events must not extend the window across that wait.
              if (
                event.type === "text-delta" ||
                event.type === "reasoning-delta" ||
                event.type === "tool-input-delta"
              ) {
                // Keep first-token latency after the generation window is drained.
                providerTTFBMs ??= now - providerStarted
                providerFirstContentAt ??= now
                providerLastContentAt = now
                providerContentObserved = true
                providerDeltaCount++
              }
            }),
          ),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type === "tool-call") calledToolIds.add(event.id)
              if (overflowFailure || retryFailure || chainFailure || publisher.hasProviderError()) return
              if (
                event.type === "tool-call" ||
                (LLMEvent.is.textDelta(event) && event.text.trim().length > 0) ||
                (LLMEvent.is.reasoningDelta(event) && event.text.trim().length > 0) ||
                (event.type === "finish" && event.reason !== "error" && !providerEventFailure)
              )
                yield* deliveredFileKnowledge
              if (LLMEvent.is.providerError(event)) {
                providerEventFailure = event
                if (invalidStructuredOutput || finalTurnToolRejected) return
                if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                  overflowFailure = event
                  return
                }
                if (
                  nextConfiguredModel() &&
                  AIChain.chainStepFailureEligible(event, { authorization: true, provider: true })
                ) {
                  chainFailure = event
                  return
                }
                if (
                  (event.retryable === true || AIChain.isProviderStreamAbortError(event)) &&
                  !isTerminalProviderEvent(event) &&
                  !publisher.hasRetryBarrier() &&
                  !publisher.hasStepFinish()
                ) {
                  retryFailure = event
                  return
                }
                if (event.retryable === true || AIChain.isProviderStreamAbortError(event)) continuationFailure = event
              }
              if (event.type === "tool-result") {
                const assistantMessageID = yield* publisher.assistantMessageID(event.id)
                const result = yield* resources.bound({
                  sessionID: session.id,
                  assistantMessageID,
                  toolCallID: `${event.id}:provider-result`,
                  tool: event.name,
                  output:
                    ToolOutput.fromResultValue(event.result) ??
                    (event.result.type === "error" && typeof event.result.value === "string"
                      ? ToolOutput.make({}, [{ type: "text", text: event.result.value }])
                      : ToolOutput.make(event.result.value)),
                })
                const output = event.output
                  ? yield* resources.bound({
                      sessionID: session.id,
                      assistantMessageID,
                      toolCallID: `${event.id}:provider-output`,
                      tool: event.name,
                      output: event.output,
                    })
                  : result
                yield* publish(
                  LLMEvent.toolResult({
                    ...event,
                    result: storeProviderResult(event.result.type, result.output),
                    output: storeProviderOutput(output.output, result.output),
                  }),
                  [...new Set([...result.outputPaths, ...output.outputPaths])],
                )
                if (event.providerExecuted && event.result.type === "error") needsContinuation = true
                return
              }
              // A tool-error without a preceding tool-call event settles a
              // call whose arguments never parsed (the stream emits tool-error
              // instead of tool-call for unparsable provider argument JSON).
              // The call was never executed, so continue so the model can
              // correct it (budgeted per activity). Errors for executed calls
              // keep their existing contracts below.
              if (event.type === "tool-error" && !calledToolIds.has(event.id)) {
                needsContinuation = true
                invalidToolInput = true
              }
              if (event.type === "tool-error" && event.name === "apply_patch") needsContinuation = true
              if (
                event.type === "tool-call" &&
                options?.finalTurn &&
                !(event.name === STRUCTURED_OUTPUT_TOOL && structuredOutput)
              ) {
                // Advertising no tools is not an execution boundary. Reject
                // unexpected calls before plugin hooks or local settlement.
                finalTurnToolRejected = true
                yield* publish(event)
                yield* publish(
                  LLMEvent.toolResult({
                    id: event.id,
                    name: event.name,
                    result: { type: "error", value: "Investigation tools are disabled on the final answer turn" },
                  }),
                )
                return
              }
              if (event.type !== "tool-call" || event.providerExecuted) {
                yield* publish(event)
                return
              }
              if (event.name === STRUCTURED_OUTPUT_TOOL) {
                yield* publish(event)
                if (structuredOutput && !isValidStructuredOutput(structuredOutput.schema, event.input)) {
                  invalidStructuredOutput = true
                  yield* publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: {
                        type: "error",
                        value:
                          "StructuredOutput input does not match the requested schema. Call StructuredOutput again with the final answer matching the requested schema; do not answer in plain text.",
                      },
                    }),
                  )
                  return
                }
                structuredValue = event.input
                yield* publish(
                  LLMEvent.toolResult({
                    id: event.id,
                    name: event.name,
                    result: { type: "text", value: "Structured output captured successfully." },
                    output: {
                      structured: { valid: true },
                      content: [{ type: "text", text: "Structured output captured successfully." }],
                    },
                  }),
                )
                return
              }
              // The announced call exists even while its asynchronous before hook waits.
              providerToolCalls++
              yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const cancellation = toolCancellation
                    ? yield* toolCancellation.register({ sessionID: session.id, callID: event.id })
                    : undefined
                  const unregisterCancellation = cancellation?.unregister ?? Effect.void
                  const execute = Effect.gen(function* () {
                    const before = plugin
                      ? yield* plugin.trigger(
                          "tool.execute.before",
                          { tool: event.name, sessionID: session.id, callID: event.id },
                          { args: event.input },
                        )
                      : { args: event.input }
                    const toolCall =
                      before.args === event.input ? event : LLMEvent.toolCall({ ...event, input: before.args })
                    if (SNAPSHOT_MUTATING_TOOLS.has(toolCall.name)) workspaceMutationAttempted = true
                    const blockingSurface =
                      toolCall.name === SurfaceTool.name && SurfaceTool.isBlockingInput(toolCall.input)
                    yield* publish(toolCall).pipe(Effect.onError(() => unregisterCancellation))
                    const budgetCategory = toolMaterialization.budgetCategory(toolCall)
                    const readBudget = (toolReadBudgets.get(session.id) ?? ToolReadBudget.make(false)).check(
                      budgetCategory,
                      toolCall.input,
                    )
                    if (readBudget.exceeded) {
                      const pollTool = budgetCategory === "poll"
                      // The budget rejection is a normal tool result that the model must see.
                      // Keep the activity open for a synthesis turn just like every other
                      // locally settled tool call; otherwise a tool-calls finish silently
                      // closes as completed/incomplete with no assistant response.
                      needsContinuation = true
                      toolBudgetExceeded = true
                      yield* publish(
                        LLMEvent.toolResult({
                          id: toolCall.id,
                          name: toolCall.name,
                          result: {
                            type: "error",
                            value: pollTool
                              ? `Repeated identical ${toolCall.name} calls without progress detected (self-loop). The observation has not changed. Stop polling and summarize or surface the current state to the user instead of repeating this call.`
                              : `Read-tool budget exceeded for this session (${toolCall.name}). Stop reading and synthesize findings from the evidence already gathered.`,
                          },
                        }),
                      )
                      return
                    }
                    const assistantMessageID = yield* publisher.assistantMessageID(toolCall.id)
                    const fileKnowledgeCutoff = yield* deliveredFileKnowledge
                    const toolStarted = Date.now()
                    let dismissed = false
                    const settle = toolMaterialization.settle({
                      sessionID: session.id,
                      agent: agent.id,
                      assistantMessageID,
                      call: toolCall,
                      skillGroupOutputs: SkillCatalog.retainedOutputs(request.messages),
                      fileKnowledgeCutoff,
                    })
                    const cancel = cancellation?.cancelled.pipe(
                      Effect.map((cancelled) => {
                        if (blockingSurface) blockingQuestionCancelled = true
                        return {
                          result: { type: "error" as const, value: cancelled.message },
                          output: undefined,
                          outputPaths: [],
                        }
                      }),
                    )
                    const settlement = (
                      blockingSurface ? settle : cancel ? Effect.raceFirst(settle, cancel) : settle
                    ).pipe(
                      Effect.catchDefect((defect) => {
                        if (defect instanceof PermissionV2.DeclinedError) return Effect.die(defect)
                        if (defect instanceof PermissionV2.CorrectedError)
                          return Effect.succeed({
                            result: ToolResultValue.make(defect.feedback, "error"),
                            output: undefined,
                            outputPaths: [],
                          })
                        if (defect instanceof QuestionV2.RejectedError) {
                          dismissed = true
                          return Effect.succeed({
                            result: ToolResultValue.make(defect.message, "error"),
                            output: undefined,
                            outputPaths: [],
                          })
                        }
                        const message = defect instanceof Error ? defect.message : String(defect)
                        return Effect.succeed({
                          result: { type: "error" as const, value: `Tool execution failed: ${message}` },
                          output: undefined,
                          outputPaths: [],
                        })
                      }),
                      Effect.tap((settlement) =>
                        Perf.record({
                          kind: "tool_call",
                          sessionID: session.id,
                          agent: agent.id,
                          tool: toolCall.name,
                          callID: toolCall.id,
                          duration_ms: Date.now() - toolStarted,
                          success: settlement.result.type !== "error",
                          result_type: settlement.result.type,
                        }),
                      ),
                      Effect.flatMap((settlement) =>
                        plugin
                          ? plugin.trigger(
                              "tool.execute.after",
                              {
                                tool: toolCall.name,
                                sessionID: session.id,
                                callID: toolCall.id,
                                args: before.args,
                              },
                              settlement,
                            )
                          : Effect.succeed(settlement),
                      ),
                      Effect.tap((settlement) =>
                        Effect.sync(() => {
                          needsContinuation = true
                          if (event.name === "skill" && settlement.result.type !== "error" && capabilityLeases) {
                            capabilityRebuildRequested = true
                          }
                        }),
                      ),
                      Effect.flatMap((settlement) =>
                        publish(
                          LLMEvent.toolResult({
                            id: toolCall.id,
                            name: toolCall.name,
                            result: settlement.result,
                            output: settlement.output,
                          }),
                          settlement.outputPaths ?? [],
                        ),
                      ),
                      Effect.tap(() =>
                        dismissed && blockingSurface ? Deferred.succeed(questionDismissed, undefined) : Effect.void,
                      ),
                      Effect.ensuring(unregisterCancellation),
                    )
                    yield* blockingSurface ? settlement : restore(settlement)
                  }).pipe(
                    Effect.onError(() => unregisterCancellation),
                    Effect.onInterrupt(() => unregisterCancellation),
                  )
                  if (event.name === SurfaceTool.name && SurfaceTool.isBlockingInput(event.input)) {
                    blockingQuestionStarted = true
                    yield* restore(execute).pipe(
                      Effect.tap(() => Effect.sync(() => (blockingQuestionCompleted = true))),
                      FiberSet.run(toolFibers),
                    )
                    return
                  }
                  yield* restore(execute).pipe(FiberSet.run(toolFibers))
                }),
              )
            }),
          ),
          Effect.andThen(
            Effect.gen(function* () {
              if (publisher.hasProviderError() || providerEventFailure) return
              const finish = publisher.stepFinishReason()
              const missingVisibleAnswer =
                finish === "stop" &&
                !publisher.hasUsableText() &&
                !publisher.hasCompletedToolResult() &&
                !needsContinuation &&
                publisher.hasRetryBarrier() &&
                providerToolCalls === 0
              if (finish === "length" || finish === "unknown" || missingVisibleAnswer) {
                yield* withPublication(publisher.finishStep(undefined, undefined, undefined, takeGenerationMs()))
                return yield* Effect.fail(
                  new LLMError({
                    module: "SessionRunner",
                    method: "runProviderStream",
                    reason: new TransportReason({
                      message: missingVisibleAnswer
                        ? "Provider response is incomplete: no visible answer after reasoning"
                        : `Provider response is incomplete: finish reason ${finish}`,
                      kind: "invalid-response",
                      canRetry: true,
                    }),
                  }),
                )
              }
              if (!publisher.hasStepFinish() && publisher.hasRetryBarrier())
                return yield* Effect.fail(
                  new LLMError({
                    module: "SessionRunner",
                    method: "runProviderStream",
                    reason: new TransportReason({
                      message: "Provider stream ended without a finish reason",
                      kind: "stream-ended",
                      canRetry: true,
                    }),
                  }),
                )
            }),
          ),
          Effect.ensuring(withPublication(publisher.flush())),
          withProviderStreamAbortNormalization,
        )
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const raced = yield* restore(
              Effect.raceFirst(
                providerStream.pipe(
                  Effect.exit,
                  Effect.map((stream) => ({ type: "stream" as const, stream })),
                ),
                Deferred.await(questionDismissed).pipe(Effect.as({ type: "dismissed" as const })),
              ),
            ).pipe(Effect.ensuring(withPublication(publisher.flush())), Effect.exit)
            const dismissed = raced._tag === "Success" && raced.value.type === "dismissed"
            const stream = yield* Effect.gen(function* () {
              if (raced._tag === "Failure") return raced
              if (raced.value.type === "dismissed") return yield* Effect.interrupt.pipe(Effect.exit)
              return raced.value.stream
            })
            const questionWasDismissed = dismissed || (yield* Deferred.isDone(questionDismissed))
            let recoveredQuestionInterruption = false
            const providerStreamMs = Date.now() - providerStarted
            const stepGenerationMs = takeGenerationMs()
            const failure =
              stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
            const streamInterrupted = stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)
            // Provider plugins may bundle another copy of @opencode-ai/llm; decode
            // its tagged error before applying the session-owned retry policy.
            const streamFailure =
              failure instanceof LLMError
                ? failure
                : Option.getOrUndefined(Schema.decodeUnknownOption(LLMError)(failure))
            // Local cleanup aborts and idle deadlines are secondary evidence.
            // They cannot turn an already-known terminal rejection into a retry.
            // Genuine raw provider failures and Effect interrupts keep authority.
            const terminalProviderEvent =
              providerEventFailure !== undefined && isTerminalProviderEvent(providerEventFailure)
            const terminalProviderFinish =
              publisher.stepFinishReason() === "content-filter" || publisher.stepFinishReason() === "error"
            const eventFailureAuthoritative =
              !streamInterrupted &&
              (terminalProviderEvent || terminalProviderFinish) &&
              streamFailure?.reason._tag === "Transport" &&
              (streamFailure.reason.kind === "stream-aborted" || streamFailure.reason.kind === "stream-inactivity")
            const llmFailure = eventFailureAuthoritative ? undefined : streamFailure
            if (questionWasDismissed) {
              yield* clearToolFibers
              yield* withPublication(
                publisher.failUnsettledTools(
                  "Tool execution interrupted",
                  false,
                  { source: "session", reason: "user-stop" },
                  SessionFailure.fromInterruptReason("user-stop"),
                ),
              )
              return yield* new UserDeclinedError()
            }
            const retryableFailure = llmFailure
              ? retryableProviderFailure(model, llmFailure)
                ? llmFailure
                : undefined
              : !eventFailureAuthoritative && !AIChain.isQuotaExceededFailure(providerEventFailure)
                ? (retryFailure ?? continuationFailure)
                : undefined
            const fallback = nextConfiguredModel()
            const retryDeferred =
              retryableFailure !== undefined && !SessionResume.canWaitForRetry(retryDelayMs(retryableFailure, 1))
            const chainEligible =
              !invalidStructuredOutput &&
              !finalTurnToolRejected &&
              !(eventFailureAuthoritative && terminalProviderFinish) &&
              fallback !== undefined &&
              (chainFailure !== undefined ||
                (failure !== undefined &&
                  AIChain.chainStepFailureEligible(failure, { authorization: true, provider: true }))) &&
              !streamInterrupted
            const chainRecoveryAttempt = chainEligible ? providerRecovery.next() : undefined
            if (
              fallback &&
              chainRecoveryAttempt !== undefined &&
              !publisher.hasAssistantStarted() &&
              !publisher.hasRetryBarrier() &&
              !publisher.hasStepFinish()
            ) {
              breakers.recordFailure(model.provider)
              yield* withPublication(
                events.publish(SessionEvent.ModelSwitched, {
                  sessionID: session.id,
                  messageID: SessionMessage.ID.create(),
                  timestamp: yield* DateTime.now,
                  model: fallback,
                }),
              )
              yield* withPublication(
                Effect.logWarning("model chain advancing after provider failure", {
                  sessionID: session.id,
                  chain: fallback.chain?.id,
                  step: fallback.chain?.active,
                  provider: fallback.providerID,
                  model: fallback.id,
                  // Surface the underlying failure so provider rejections like a
                  // bare 400 are diagnosable from the runtime log.
                  error: chainFailure
                    ? retryError(chainFailure)
                    : failure instanceof Error
                      ? failure.message
                      : failure === undefined
                        ? undefined
                        : String(failure),
                }),
              )
              return yield* Effect.die(rebuildPreparedTurn())
            }
            const chainContinuation = chainRecoveryAttempt !== undefined ? fallback : undefined
            const retryAttempt =
              !invalidStructuredOutput &&
              !finalTurnToolRejected &&
              !terminalProviderEvent &&
              !retryDeferred &&
              retryableFailure &&
              !chainContinuation &&
              !publisher.hasRetryBarrier() &&
              !publisher.hasProviderError() &&
              !publisher.hasStepFinish() &&
              !streamInterrupted &&
              attempt < SessionResume.retryBudget(AIChain.providerFailureCode(retryableFailure))
                ? providerRecovery.next()
                : undefined
            if (retryableFailure && retryAttempt !== undefined) {
              const retryInMs = retryDelayMs(retryableFailure, retryAttempt)
              yield* withPublication(
                events.publish(SessionEvent.Retried, {
                  sessionID: session.id,
                  timestamp: yield* DateTime.now,
                  attempt: retryAttempt,
                  error: retryError(retryableFailure),
                  code: AIChain.providerFailureCode(retryableFailure),
                  provider: model.provider,
                  next: Date.now() + retryInMs,
                }),
              )
              yield* restore(Effect.sleep(retryInMs))
              if (yield* SessionInput.hasPending(db, session.id, "steer"))
                return yield* Effect.die(rebuildPreparedTurn("steer"))
              return yield* runProviderStream(attempt + 1)
            }
            // Durable output is a replay barrier. Recover with a fresh provider turn from projected history
            // instead of reissuing a request that may already have executed tools or emitted user-visible text.
            // A StructuredOutput schema violation is never recoverable: the
            // model produced a terminal typed failure, not retryable
            // transport. Routing it into recovery would replace the typed
            // invalid-tool-input failure with a later successful answer.
            const continuationAttempt =
              !invalidStructuredOutput &&
              !finalTurnToolRejected &&
              !terminalProviderEvent &&
              !retryDeferred &&
              !chainContinuation &&
              options?.providerRecovery !== undefined &&
              retryableFailure !== undefined &&
              SessionResume.retryBudget(AIChain.providerFailureCode(retryableFailure)) > 0 &&
              !AIChain.isQuotaExceededFailure(retryableFailure) &&
              (publisher.hasRetryBarrier() || publisher.hasStepFinish() || publisher.hasProviderError()) &&
              !streamInterrupted
                ? providerRecovery.next()
                : undefined
            const continueAfterRetryableFailure = continuationAttempt !== undefined
            if (retryableFailure && continuationAttempt !== undefined) {
              recoveredRetryableFailure = true
              continuationRetryDelayMs = retryDelayMs(retryableFailure, continuationAttempt)
              yield* withPublication(
                events.publish(SessionEvent.Retried, {
                  sessionID: session.id,
                  timestamp: yield* DateTime.now,
                  attempt: continuationAttempt,
                  error: retryError(retryableFailure),
                  code: AIChain.providerFailureCode(retryableFailure),
                  provider: model.provider,
                  next: Date.now() + continuationRetryDelayMs,
                }),
              )
            }
            const terminalSettlement =
              !streamInterrupted &&
              (invalidStructuredOutput || finalTurnToolRejected || (retryDeferred && !chainContinuation))
            if (retryFailure && !llmFailure && !terminalSettlement) yield* publish(retryFailure)
            if (chainFailure && !llmFailure && !terminalSettlement) yield* publish(chainFailure)
            if (
              recoverOverflow &&
              !streamInterrupted &&
              !publisher.hasAssistantStarted() &&
              isContextOverflowFailure(failure ?? overflowFailure) &&
              providerRecovery.next() !== undefined &&
              (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, request })))
            ) {
              if (optimization.features.runner_request_metrics)
                yield* withPublication(
                  Effect.logInfo("session runner compaction triggered", {
                    sessionID: session.id,
                    reason: "context_overflow",
                  }),
                )
              return yield* Effect.die(continueAfterOverflowCompaction)
            }
            if (overflowFailure && !failure && !streamInterrupted) yield* publish(overflowFailure)
            if (llmFailure && !publisher.hasProviderError() && !terminalSettlement && !streamInterrupted) {
              yield* withPublication(
                publisher.failUnsettledTools(
                  "Provider did not return a tool result",
                  true,
                  undefined,
                  AIChain.providerFailure(llmFailure),
                ),
              )
              yield* withPublication(
                events.publish(SessionEvent.Step.Failed, {
                  sessionID: session.id,
                  timestamp: yield* DateTime.now,
                  assistantMessageID: yield* publisher.startAssistant(),
                  error: { type: "unknown", message: llmFailure.reason.message },
                  failure: AIChain.providerFailure(llmFailure),
                }),
              )
            }
            if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause) && !blockingQuestionStarted)
              yield* FiberSet.clear(toolFibers)
            if (questionWasDismissed) {
              yield* clearToolFibers
              yield* withPublication(
                publisher.failUnsettledTools(
                  "Tool execution interrupted",
                  false,
                  { source: "session", reason: "user-stop" },
                  SessionFailure.fromInterruptReason("user-stop"),
                ),
              )
              return yield* new UserDeclinedError()
            }
            const settled = yield* restore(
              Effect.raceFirst(
                awaitAllToolFibers.pipe(Effect.as(false)),
                Deferred.await(questionDismissed).pipe(Effect.as(true)),
              ),
            ).pipe(Effect.exit)
            recoveredQuestionInterruption =
              blockingQuestionStarted &&
              blockingQuestionCompleted &&
              !blockingQuestionCancelled &&
              stream._tag === "Failure" &&
              Cause.hasInterrupts(stream.cause)
            yield* Perf.record({
              kind: "provider_turn",
              source: "core-session-runner",
              sessionID: session.id,
              agent: agent.id,
              model: model.id,
              provider: model.provider,
              first_event_ms: providerFirstEventAt === undefined ? undefined : providerFirstEventAt - providerStarted,
              ttfb_ms: providerTTFBMs,
              stream_ms: providerStreamMs,
              events_count: providerEventCount,
              published_events_count:
                providerEventCount - providerDeltaCount + publisher.publishedDeltaCount() - publishedDeltaStart,
              tool_calls_count: providerToolCalls,
              success:
                (stream._tag === "Success" || recoveredQuestionInterruption) &&
                providerEventFailure === undefined &&
                !terminalProviderFinish,
              interrupted: stream._tag === "Failure" && Cause.hasInterrupts(stream.cause),
              recovered_blocking_question: recoveredQuestionInterruption,
              error:
                failure instanceof Error
                  ? failure.message
                  : failure === undefined
                    ? providerEventFailure?.message
                    : String(failure),
            })
            if (settled._tag === "Failure" && isPermissionDeclined(settled.cause)) {
              yield* clearToolFibers
              yield* withPublication(
                publisher.failUnsettledTools(
                  "Tool execution interrupted",
                  false,
                  { source: "session", reason: "user-stop" },
                  SessionFailure.fromInterruptReason("user-stop"),
                ),
              )
              return yield* new UserDeclinedError()
            }
            if (settled._tag === "Success" && settled.value) {
              yield* clearToolFibers
              yield* withPublication(
                publisher.failUnsettledTools(
                  "Tool execution interrupted",
                  false,
                  { source: "session", reason: "user-stop" },
                  SessionFailure.fromInterruptReason("user-stop"),
                ),
              )
              return yield* new UserDeclinedError()
            }
            if (
              (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause) && !recoveredQuestionInterruption) ||
              (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            ) {
              yield* clearToolFibers
              yield* withPublication(
                publisher.failUnsettledTools(
                  "Tool execution interrupted",
                  false,
                  { source: "session", reason: "user-stop" },
                  SessionFailure.fromInterruptReason("user-stop"),
                ),
              )
              yield* withPublication(publisher.interruptStep())
            }
            if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
              const failure = Cause.squash(settled.cause)
              const message = failure instanceof Error ? failure.message : String(failure)
              yield* withPublication(
                publisher.failUnsettledTools(
                  `Tool execution failed: ${message}`,
                  false,
                  undefined,
                  SessionFailure.make("tool.defect", { cause: { raw: message } }),
                ),
              )
            }
            if (publisher.hasProviderError())
              yield* withPublication(
                publisher.failUnsettledTools(
                  "Tool execution interrupted",
                  false,
                  { source: "provider" },
                  SessionFailure.make("provider.transport"),
                ),
              )
            const unfinishedTools = yield* withPublication(
              publisher.failUnsettledTools(
                "Provider stream ended before completing the tool call",
                false,
                undefined,
                SessionFailure.make("provider.transport"),
              ),
            )
            if (unfinishedTools > 0) needsContinuation = true
            if (
              finalTurnToolRejected &&
              !streamInterrupted &&
              !(settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            ) {
              const failure = finalTurnToolFailure()
              yield* withPublication(
                events.publish(SessionEvent.Step.Failed, {
                  sessionID: session.id,
                  timestamp: yield* DateTime.now,
                  assistantMessageID: yield* publisher.startAssistant(),
                  error: { type: "unknown", message: failure.reason.message },
                  failure: SessionFailure.make("provider.invalid-response", {
                    retryability: "none",
                    cause: { raw: failure.reason.message, detail: "unexpected-final-tool" },
                    providerRef: `${model.provider}/${model.id}`,
                  }),
                }),
              )
              return yield* Effect.fail(failure)
            }
            if (
              invalidStructuredOutput &&
              !streamInterrupted &&
              !(settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            ) {
              const failure = invalidStructuredOutputFailure()
              const message = "StructuredOutput input does not match the requested schema"
              yield* withPublication(
                events.publish(SessionEvent.Step.Failed, {
                  sessionID: session.id,
                  timestamp: yield* DateTime.now,
                  assistantMessageID: yield* publisher.startAssistant(),
                  error: { type: "unknown", message },
                  failure: SessionFailure.make("provider.invalid-response", {
                    cause: { raw: message, detail: "structured output" },
                    providerRef: `${model.provider}/${model.id}`,
                  }),
                }),
              )
              return yield* Effect.fail(failure)
            }
            if (
              retryDeferred &&
              retryableFailure &&
              !chainContinuation &&
              !streamInterrupted &&
              !(settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            ) {
              const failure = new LLMError({
                module: "SessionRunner",
                method: "runProviderStream",
                reason: new TransportReason({
                  kind: "retry-deferred",
                  canRetry: false,
                  message: `${retryError(retryableFailure).message}. Automatic retry deferred: Retry-After ${retryableFailure.retryAfterMs} ms exceeds the ${SessionResume.MAX_AUTO_RETRY_WAIT_MS} ms automatic wait limit. No retry was sent before the provider deadline.`,
                }),
              })
              yield* withPublication(
                events.publish(SessionEvent.Step.Failed, {
                  sessionID: session.id,
                  timestamp: yield* DateTime.now,
                  assistantMessageID: yield* publisher.startAssistant(),
                  error: { type: "unknown", message: failure.reason.message },
                  failure: SessionFailure.make(AIChain.providerFailureCode(retryableFailure), {
                    ...AIChain.providerFailure(retryableFailure),
                    retryAfterMs: retryableFailure.retryAfterMs,
                    retryability: "none",
                    remediation: "report",
                    cause: { raw: failure.reason.message, detail: "retry-deferred" },
                    providerRef: `${model.provider}/${model.id}`,
                  }),
                }),
              )
              return yield* Effect.fail(failure)
            }
            // A completion without usable final text or tool results leaves the pending
            // context unanswered while still ending the activity as a normal stop. Recover with
            // another provider attempt instead of silently ending the turn.
            const emptyCompletion =
              (stream._tag === "Success" || recoveredQuestionInterruption) &&
              providerEventFailure === undefined &&
              !publisher.hasProviderError() &&
              !publisher.hasRetryBarrier() &&
              providerToolCalls === 0 &&
              // Terminal provider verdicts must not enter missing-answer recovery.
              !terminalProviderFinish
            const emptyCompletionFallback = emptyCompletion
              ? nextChainModel(
                  session.model ?? {
                    id: ModelV2.ID.make(model.id),
                    providerID: ProviderV2.ID.make(model.provider),
                  },
                )
              : undefined
            if (emptyCompletionFallback && providerRecovery.next() !== undefined) {
              yield* withPublication(
                events.publish(SessionEvent.ModelSwitched, {
                  sessionID: session.id,
                  messageID: SessionMessage.ID.create(),
                  timestamp: yield* DateTime.now,
                  model: emptyCompletionFallback,
                }),
              )
              yield* withPublication(
                Effect.logWarning("model chain advancing after empty completion", {
                  sessionID: session.id,
                  chain: emptyCompletionFallback.chain?.id,
                  step: emptyCompletionFallback.chain?.active,
                  provider: emptyCompletionFallback.providerID,
                  model: emptyCompletionFallback.id,
                }),
              )
              return yield* Effect.die(rebuildPreparedTurn())
            }
            const emptyRetryAttempt =
              emptyCompletion &&
              SessionResume.decide({
                failure: AIChain.providerFailure(emptyCompletionFailure()),
                attempt,
              }).action === "auto-retry"
                ? providerRecovery.next()
                : undefined
            if (emptyRetryAttempt !== undefined) {
              const failure = emptyCompletionFailure()
              yield* withPublication(
                events.publish(SessionEvent.Retried, {
                  sessionID: session.id,
                  timestamp: yield* DateTime.now,
                  attempt: emptyRetryAttempt,
                  error: retryError(failure),
                  code: AIChain.providerFailureCode(failure),
                  provider: model.provider,
                  next: Date.now(),
                }),
              )
              // An empty completion means the provider answered successfully, so an
              // immediate retry is safe and keeps recovery free of timer scheduling.
              if (yield* SessionInput.hasPending(db, session.id, "steer"))
                return yield* Effect.die(rebuildPreparedTurn("steer"))
              return yield* runProviderStream(attempt + 1)
            }
            // Exhausted retries must not fall through to a successful stop: that is
            // exactly the silent busy-indicator loss this recovery exists to prevent.
            if (emptyCompletion) {
              const failure = emptyCompletionFailure()
              yield* withPublication(
                events.publish(SessionEvent.Step.Failed, {
                  sessionID: session.id,
                  timestamp: yield* DateTime.now,
                  assistantMessageID: yield* publisher.startAssistant(),
                  error: { type: "unknown", message: failure.reason.message },
                  failure: SessionFailure.make("provider.invalid-response", {
                    cause: { raw: failure.reason.message, detail: "empty provider completion" },
                    providerRef: `${model.provider}/${model.id}`,
                  }),
                }),
              )
              return yield* Effect.fail(failure)
            }
            const completedStream =
              stream._tag === "Success" ||
              recoveredQuestionInterruption ||
              (eventFailureAuthoritative && terminalProviderFinish)
            if (completedStream && !publisher.hasProviderError())
              yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            if (completedStream && !publisher.hasProviderError()) {
              const endSnapshot =
                snapshots === undefined || !snapshotEnabled || !workspaceMutationAttempted
                  ? undefined
                  : yield* withSnapshotBoundary("end", snapshots.track(session.location))
              const finishReason = publisher.stepFinishReason()
              yield* withPublication(
                publisher.finishStep(
                  endSnapshot,
                  structuredValue,
                  structuredValue === undefined ? undefined : "stop",
                  stepGenerationMs,
                ),
              )
              if (finishReason === "content-filter")
                return yield* Effect.fail(
                  new LLMError({
                    module: "SessionRunner",
                    method: "runProviderStream",
                    reason: new ContentPolicyReason({
                      message: "The response was blocked by the provider's content filter",
                    }),
                  }),
                )
              if (finishReason === "error")
                return yield* Effect.fail(
                  new LLMError({
                    module: "SessionRunner",
                    method: "runProviderStream",
                    reason: new InvalidProviderOutputReason({
                      message: "The provider finished the response with an error",
                    }),
                  }),
                )
              if (structuredOutput && structuredValue === undefined && !needsContinuation) {
                missingStructuredOutput = true
                yield* withPublication(
                  events.publish(SessionEvent.Step.Failed, {
                    sessionID: session.id,
                    timestamp: yield* DateTime.now,
                    assistantMessageID: yield* publisher.startAssistant(),
                    error: { type: "unknown", message: "Model did not produce structured output" },
                    failure: SessionFailure.make("provider.invalid-response", {
                      cause: { raw: "Model did not produce structured output", detail: "structured output" },
                      providerRef: `${model.provider}/${model.id}`,
                    }),
                  }),
                )
              }
              if (startSnapshot && endSnapshot)
                yield* updateSummaryFromSnapshots(session.id, session.location, startSnapshot, endSnapshot)
            }
            if (chainContinuation) {
              recoveredRetryableFailure = true
              yield* withPublication(
                events.publish(SessionEvent.ModelSwitched, {
                  sessionID: session.id,
                  messageID: SessionMessage.ID.create(),
                  timestamp: yield* DateTime.now,
                  model: chainContinuation,
                }),
              )
              yield* withPublication(
                Effect.logWarning("model chain continuing after partial provider failure", {
                  sessionID: session.id,
                  chain: chainContinuation.chain?.id,
                  step: chainContinuation.chain?.active,
                  provider: chainContinuation.providerID,
                  model: chainContinuation.id,
                }),
              )
            }
            if (
              stream._tag === "Failure" &&
              !eventFailureAuthoritative &&
              !recoveredQuestionInterruption &&
              !continueAfterRetryableFailure &&
              !chainContinuation
            ) {
              // A returned child-stream interrupt is not a shutdown of its owner.
              // External cancellation fails the outer race/tool wait instead.
              if (streamInterrupted && raced._tag === "Success" && settled._tag === "Success")
                return yield* Effect.failCause(Cause.combine(stream.cause, Cause.fail(new ProviderInterruptedError())))
              return yield* Effect.failCause(stream.cause)
            }
            if (settled._tag === "Failure") return yield* Effect.failCause(settled.cause)
            // An error event can be followed by a clean transport close. Its
            // Step.Failed is not a successful activity: once recovery is
            // exhausted, fail the drain too. Raw failures and interrupts above
            // remain authoritative; a fresh recovery turn is still allowed.
            if (providerEventFailure && !continueAfterRetryableFailure && !chainContinuation)
              return yield* Effect.fail(
                new LLMError({
                  module: "SessionRunner",
                  method: "runProviderStream",
                  reason: new TransportReason({
                    message: providerEventFailure.message,
                    kind: "provider-error",
                    canRetry: providerEventFailure.retryable === true && !terminalProviderEvent,
                    status: providerEventFailure.statusCode,
                    responseHeaders: providerEventFailure.responseHeaders,
                    responseBody: providerEventFailure.responseBody,
                    retryAfterMs: providerEventFailure.retryAfterMs,
                  }),
                }),
              )
            if ((stream._tag === "Success" || recoveredQuestionInterruption) && !publisher.hasProviderError())
              breakers.recordSuccess(model.provider)
            const shouldContinue =
              chainContinuation !== undefined ||
              continueAfterRetryableFailure ||
              (structuredValue === undefined && !publisher.hasProviderError() && needsContinuation)
            // A newly activated capability cannot rescue a failed turn or
            // bypass cancellation. Only successful or budgeted continuation rebuilds.
            if (shouldContinue && capabilityRebuildRequested && capabilityLeases) {
              const capabilitySnapshotAfterTool = yield* capabilityLeases.snapshot(session.id, agent.id)
              if (capabilitySnapshotChanged(capabilitySnapshotBeforeTools ?? {}, capabilitySnapshotAfterTool))
                return yield* Effect.die(rebuildPreparedTurn())
            }
            if (!shouldContinue && !missingStructuredOutput) return false
            const assistantMessageID = publisher.currentAssistantMessageID()
            if (assistantMessageID === undefined)
              return yield* Effect.die("Continuation requested before assistant step start")
            const assistantEntry = yield* SessionHistory.entryForMessage(db, session.id, assistantMessageID)
            if (!assistantEntry) return yield* Effect.die(`Missing projected assistant message: ${assistantMessageID}`)
            continuationHistory = {
              baselineSeq: system.baselineSeq,
              contextRevision: system.revision,
              entries: [...entries, assistantEntry],
            }
            return shouldContinue
          }),
        )
      }, Effect.scoped)
      const continueRun = yield* runProviderStream(0)
      if (continuation) yield* SessionTurnContinuation.consume(db, session.id, continuation.activityID)
      yield* scheduleTitle(session.id)
      return {
        needsContinuation: continueRun,
        ...(toolBudgetExceeded ? { toolBudgetExceeded: true } : {}),
        ...(invalidToolInput ? { invalidToolInput: true } : {}),
        ...(invalidStructuredOutput ? { invalidStructuredOutput: true } : {}),
        ...(continuationHistory === undefined ? {} : { history: continuationHistory }),
        ...(missingStructuredOutput ? { missingStructuredOutput: true } : {}),
        ...(structuredOutput?.retryCount === undefined ? {} : { structuredRetryCount: structuredOutput.retryCount }),
        ...(recoveredRetryableFailure ? { recoveredRetryableFailure: true } : {}),
        ...(continuationRetryDelayMs === undefined ? {} : { retryDelayMs: continuationRetryDelayMs }),
      }
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      history?: RunnerHistorySnapshot,
      finalTurn?: "step-limit" | "structured-retry" | "tool-budget",
      providerRecovery?: ReturnType<typeof SessionResume.recoveryBudget>,
    ) => Effect.Effect<RunTurnResult, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(
      function* (sessionID, promotion, history, finalTurn, providerRecovery) {
        return yield* runTurnAttempt(sessionID, promotion, {
          ...(history === undefined ? {} : { history }),
          ...(finalTurn === undefined ? {} : { finalTurn }),
          ...(providerRecovery === undefined ? {} : { providerRecovery }),
        }).pipe(
          Effect.catchDefect(
            Effect.fnUntraced(function* (defect) {
              if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
              if (defect.transition._tag === "ContinueAfterOverflowCompaction")
                return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
              yield* Effect.yieldNow
              return yield* runAfterOverflowCompaction(
                sessionID,
                defect.transition.promotion,
                undefined,
                finalTurn,
                providerRecovery,
              )
            }),
          ),
        )
      },
    )

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, history, finalTurn, providerRecovery) {
      return yield* runTurnAttempt(sessionID, promotion, {
        recoverOverflow: compaction.compactAfterOverflow,
        ...(history === undefined ? {} : { history }),
        ...(finalTurn === undefined ? {} : { finalTurn }),
        ...(providerRecovery === undefined ? {} : { providerRecovery }),
      }).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, undefined, finalTurn, providerRecovery)
            return yield* runTurn(sessionID, defect.transition.promotion, undefined, finalTurn, providerRecovery)
          }),
        ),
      )
    })

    const runSession = Effect.fn("SessionRunner.runSession")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force?: boolean
    }) {
      const session = yield* getSession(input.sessionID)
      const selectedAgent = yield* agents.select(session.agent)
      const multiAgentUnlimited =
        Config.latest(configEntries, "multi_agent")?.unlimited === true &&
        selectedAgent.id === AgentV2.ID.make("review")
      const taskBudget = mergeReadBudgetLimits(
        selectedAgent.info?.toolBudget,
        readBudgetLimits(session.metadata?.tool_budget),
      )
      const createReadBudget = () =>
        taskBudget
          ? ToolReadBudget.limited(taskBudget)
          : multiAgentUnlimited
            ? ToolReadBudget.make(false)
            : ToolReadBudget.make(optimization.features.tool_read_budget)
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (input.force !== true && !hasSteer && !hasQueue) return
      yield* failInterruptedTools(input.sessionID)
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let openActivity = input.force === true || hasSteer || hasQueue
      while (openActivity) {
        toolReadBudgets.acquire(input.sessionID, createReadBudget)
        let needsContinuation = true
        let history: RunnerHistorySnapshot | undefined
        let step = 0
        let structuredRetries = 0
        let structuredFinalTurn: "structured-retry" | undefined = undefined
        let toolBudgetFinalTurn: "tool-budget" | undefined = undefined
        const providerRecovery = SessionResume.recoveryBudget()
        let toolErrorRounds = 0
        while (needsContinuation) {
          const stepLimit = (yield* agents.select((yield* getSession(input.sessionID)).agent)).info?.steps
          if (stepLimit !== undefined && step >= stepLimit) {
            const result = yield* runTurn(input.sessionID, promotion, history, "step-limit", providerRecovery)
            // A malformed tool call on the final turn must not exit
            // successfully: the persisted failed call would otherwise let
            // LocalExecution complete the activity. Settle it terminally.
            if (result.invalidToolInput) return yield* Effect.fail(invalidToolInputFailure())
            if (result.invalidStructuredOutput) return yield* Effect.fail(invalidStructuredOutputFailure())
            if (result.missingStructuredOutput) {
              if (structuredRetries >= (result.structuredRetryCount ?? 0))
                return yield* Effect.fail(missingStructuredOutputFailure())
              structuredRetries++
              history = result.history
              promotion = "steer"
              continue
            }
            if (result.recoveredRetryableFailure && result.needsContinuation) {
              // Recovery is activity-budgeted even on the final answer lane.
              // Keep tools disabled and reload durable history before continuing.
              history = undefined
              promotion = "steer"
              yield* Effect.sleep(result.retryDelayMs ?? 0)
              continue
            }
            needsContinuation = false
            history = result.history
            break
          }
          const result: RunTurnResult = yield* runTurn(
            input.sessionID,
            promotion,
            history,
            structuredFinalTurn ?? toolBudgetFinalTurn,
            providerRecovery,
          )
          step++
          if (result.invalidStructuredOutput) return yield* Effect.fail(invalidStructuredOutputFailure())
          // Missing structured output follows the bounded correction lane. A
          // schema-invalid StructuredOutput call already failed terminally
          // inside runProviderStream with a typed Step.Failed event; routing it
          // through the missing-output retry lane would silently convert that
          // typed failure into another provider turn.
          const retryStructuredOutput =
            result.missingStructuredOutput === true && structuredRetries < (result.structuredRetryCount ?? 0)
          if (result.missingStructuredOutput && !retryStructuredOutput)
            return yield* Effect.fail(missingStructuredOutputFailure())
          if (retryStructuredOutput) structuredRetries++
          structuredFinalTurn = retryStructuredOutput ? "structured-retry" : undefined
          toolBudgetFinalTurn = result.toolBudgetExceeded ? "tool-budget" : undefined
          needsContinuation = result.needsContinuation || retryStructuredOutput
          // Bounded model correction after a locally-failed tool call: allow up
          // to MAX_TOOL_ERROR_ROUNDS consecutive provider turns triggered by
          // tool-error events, then settle the failed call terminally instead of
          // looping. A turn without a tool-error resets the streak. Schema-form
          // StructuredOutput violations already failed inside runProviderStream
          // with a typed Step.Failed event because fanout children carry an
          // explicit retryCount yet arrive with a single terminal tool call;
          // reusing the missing-output retry lane here would silently swallow
          // that typed failure, so do not re-enter correction handling.
          if (result.invalidToolInput) {
            toolErrorRounds++
            if (toolErrorRounds > MAX_TOOL_ERROR_ROUNDS) return yield* Effect.fail(invalidToolInputFailure())
          } else {
            toolErrorRounds = 0
          }
          history = result.recoveredRetryableFailure ? undefined : result.history
          if (result.recoveredRetryableFailure) {
            yield* Effect.sleep(result.retryDelayMs ?? 0)
          }
          promotion = "steer"
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
          if (!needsContinuation) {
            history = undefined
            break
          }
        }
        openActivity = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        if (openActivity) toolReadBudgets.settle(input.sessionID)
        promotion = openActivity ? "queue" : undefined
      }
    })

    const run = Effect.fn("SessionRunner.run")(
      (input: { readonly sessionID: SessionSchema.ID; readonly force?: boolean }) =>
        runSession(input).pipe(
          // A drain can fail before the first provider turn (for example when model
          // resolution rejects the configured model). The session still deserves a
          // generated or prompt-fallback title, so scheduling is not success-only.
          Effect.onExit((exit) =>
            events
              .publish(Settled, {
                sessionID: input.sessionID,
                status:
                  exit._tag === "Success" ? "completed" : Cause.hasInterrupts(exit.cause) ? "interrupted" : "error",
              })
              .pipe(
                Effect.ignore,
                Effect.andThen(
                  exit._tag === "Failure" && !Cause.hasInterrupts(exit.cause)
                    ? scheduleTitle(input.sessionID)
                    : Effect.void,
                ),
              ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              toolReadBudgets.settle(input.sessionID)
            }),
          ),
        ),
    )

    return Service.of({
      run,
      requiresModelSwitchCompaction,
      prepareModelSwitch,
    })
  }),
)

export const SessionRunnerLLM = {
  layer,
}

export const defaultLayer = layer.pipe(
  Layer.provide(ToolOutputStore.defaultLayer),
  Layer.provide(ContentStore.defaultLayer),
  Layer.provide(Snapshot.defaultLayer),
)

export function capabilitySnapshotChanged(before: CapabilityLease.Snapshot, after: CapabilityLease.Snapshot) {
  const capabilities = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...capabilities].some((capability) => capability in before !== capability in after)
}

function storeProviderResult(type: ToolResultValue["type"], output: ToolOutput): ToolResultValue {
  if (type === "json") return { type, value: output.structured }
  if (type === "error") {
    if (hasExternalText(output)) return { type, value: output.structured }
    const result = ToolOutput.toResultValue(output)
    return { type, value: result.type === "text" ? result.value : output.structured }
  }
  if (type === "text") {
    if (hasExternalText(output)) return { type, value: output.structured }
    const result = ToolOutput.toResultValue(output)
    return { type, value: result.type === "text" ? result.value : output.content }
  }
  return { type, value: output.content }
}

function storeProviderOutput(output: ToolOutput, result: ToolOutput): ToolOutput {
  const structured = isRecord(output.structured) ? output.structured : { value: output.structured }
  const metadata = isRecord(structured.$opencode) ? structured.$opencode : {}
  return {
    structured: { ...structured, $opencode: { ...metadata, providerResult: result } },
    content: output.content,
  }
}

const materializeProviderResult = Effect.fn("SessionRunner.materializeProviderResult")(function* (
  resources: ToolOutputStore.Interface,
  sessionID: SessionSchema.ID,
  result: ToolResultValue,
  stored: ToolOutput | undefined,
  budget: ToolOutputStore.MaterializeBudget,
  attachmentBudget: ToolOutputStore.MaterializeBudget,
) {
  const output = yield* resources.materialize({
    sessionID,
    budget,
    attachmentBudget,
    output:
      stored ??
      (result.type === "content"
        ? ToolOutput.fromResultValue(result)!
        : (result.type === "text" || result.type === "error") && hasExternalTextValue(result.value)
          ? ToolOutput.make(result.value)
          : result.type === "error" || result.type === "json"
            ? ToolOutput.make(result.value)
            : ToolOutput.fromResultValue(result)!),
  })
  if (result.type === "json") return { type: result.type, value: output.structured }
  if (result.type === "error") {
    if (!hasExternalTextValue(result.value)) return { type: result.type, value: output.structured }
    const restored = ToolOutput.toResultValue(output)
    return { type: result.type, value: restored.type === "text" ? restored.value : output.structured }
  }
  if (result.type === "content") return { type: result.type, value: output.content }
  const restored = ToolOutput.toResultValue(output)
  return { type: result.type, value: restored.type === "text" ? restored.value : output.content }
})

function hasExternalText(output: ToolOutput) {
  return hasExternalTextValue(output.structured)
}

function hasExternalTextValue(value: unknown) {
  if (!isRecord(value) || !isRecord(value.$opencode) || !isRecord(value.$opencode.text)) return false
  return value.$opencode.text.type === "content-reference" && typeof value.$opencode.text.uri === "string"
}

function storedProviderResult(output: ToolOutput) {
  if (!isRecord(output.structured) || !isRecord(output.structured.$opencode)) return
  const result = output.structured.$opencode.providerResult
  if (!isRecord(result) || !("structured" in result) || !Array.isArray(result.content)) return
  return result as unknown as ToolOutput
}

function removeStoredProviderResult(output: ToolOutput): ToolOutput {
  if (!isRecord(output.structured) || !isRecord(output.structured.$opencode)) return output
  const metadata = Object.fromEntries(
    Object.entries(output.structured.$opencode).filter(([key]) => key !== "providerResult"),
  )
  const structured = Object.fromEntries(Object.entries(output.structured).filter(([key]) => key !== "$opencode"))
  return {
    structured: Object.keys(metadata).length === 0 ? structured : { ...structured, $opencode: metadata },
    content: output.content,
  }
}

function isDefaultTitle(title: string) {
  return /^New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

export function shouldPublishGeneratedTitle(currentTitle: string, observedDefaultTitle: string) {
  return currentTitle === observedDefaultTitle
}

function cleanTitle(text: string) {
  const title = text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.replace(/^#+\s*/, "")
    .replace(/^(?:title|titel)\s*:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
  if (!title) return undefined
  if (title.length <= TITLE_MAX_LENGTH) return title
  const clipped = title.slice(0, TITLE_MAX_LENGTH - 3)
  const breakAt = clipped.lastIndexOf(" ")
  return `${(breakAt >= Math.round(TITLE_MAX_LENGTH * 0.6) ? clipped.slice(0, breakAt) : clipped).trimEnd()}...`
}

function unsupportedTitleOutputLimit(message: string | undefined) {
  return message !== undefined && /unsupported parameter:\s*max_output_tokens/i.test(message)
}

function generationFromParams(input: GenerationOptionsFields & { readonly maxOutputTokens?: number }) {
  const generation = {
    maxTokens: input.maxTokens ?? input.maxOutputTokens,
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    frequencyPenalty: input.frequencyPenalty,
    presencePenalty: input.presencePenalty,
    seed: input.seed,
    stop: input.stop,
  }
  return Object.values(generation).some((value) => value !== undefined) ? generation : undefined
}

function providerOptionsFromHook(model: Model, options: Record<string, unknown> | ProviderOptions) {
  if (Object.keys(options).length === 0) return undefined
  if (Object.entries(options).every(([key, value]) => providerOptionNamespaces.has(key) && isRecord(value)))
    return options as ProviderOptions
  return { [providerOptionNamespace(model)]: options }
}

// Provider plugins own live request profiles keyed by AI-SDK package. Direct
// models (CLI, older clients, test harnesses) bypass the catalog resolve path,
// so the package association from `rememberPackage` is missing; without any
// profile the partitioner would file known provider options into the raw HTTP
// body and agent request overrides would be silently dropped. Fall back to
// conservative per-route-namespace semantics; loaded plugin profiles keep
// priority for their own packages.
const fallbackRequestProfiles: ModelRequest.Profiles = {
  openai: {
    namespace: "openai",
    semantics: {
      store: "store",
      promptCacheKey: "promptCacheKey",
      reasoning: "reasoning",
      reasoningEffort: "reasoningEffort",
      reasoning_effort: "reasoningEffort",
      reasoningMode: "reasoningMode",
      reasoningSummary: "reasoningSummary",
      textVerbosity: "textVerbosity",
      serviceTier: "serviceTier",
      service_tier: "serviceTier",
    },
  },
  openrouter: {
    namespace: "openrouter",
    semantics: {
      usage: "usage",
      reasoning: "reasoning",
      promptCacheKey: "promptCacheKey",
      prompt_cache_key: "promptCacheKey",
    },
  },
  anthropic: {
    namespace: "anthropic",
    semantics: { thinking: "thinking" },
  },
}

function normalizeAgentRequest(
  model: Model,
  body: Readonly<Record<string, unknown>>,
  profiles: ModelRequest.Profiles | undefined,
) {
  const requestPackage = SessionRunnerModel.requestPackage(model)
  if (requestPackage && profiles && Object.hasOwn(profiles, requestPackage))
    return ModelRequest.normalizeAiSdkOptions(requestPackage, body, profiles)
  const namespace = providerOptionNamespace(model)
  const fallback = fallbackRequestProfiles[namespace]
  if (!fallback) return ModelRequest.normalizeAiSdkOptions(requestPackage, body, profiles)
  return ModelRequest.normalizeAiSdkOptions(requestPackage ?? namespace, body, {
    [namespace]: fallback,
    ...(profiles ?? {}),
  })
}

const POST_COMPACTION_STEER_REMINDER = `The following user messages were sent after the conversation checkpoint while the session was recovering from compaction. Treat each of them as current, binding steering or correction from the user. Apply all of them in chronological order; do not ignore, merge away, or treat any as optional.`

function toLLMMessagesWithPostCompactionSteerReminder(
  context: readonly SessionMessage.Message[],
  model: Model,
  capabilities?: ImageInputCapabilities,
) {
  const insert = postCompactionSteerIndex(context)
  if (insert < 0) return toLLMMessages(context, model, capabilities)
  return [
    ...toLLMMessages(context.slice(0, insert), model, capabilities),
    Message.system(POST_COMPACTION_STEER_REMINDER),
    ...toLLMMessages(context.slice(insert), model, capabilities),
  ]
}

function postCompactionSteerIndex(context: readonly SessionMessage.Message[]) {
  const compaction = context.findLastIndex((message) => message.type === "compaction")
  if (compaction < 0) return -1
  const assistant = context.findLastIndex((message) => message.type === "assistant")
  if (assistant > compaction) return -1
  return context.findIndex((message, index) => index > compaction && message.type === "user")
}

const providerOptionNamespaces = new Set(["openai", "openrouter", "anthropic", "gemini", "bedrock"])

function providerOptionNamespace(model: Model) {
  const route = String(model.route.id)
  if (route.includes("openrouter")) return "openrouter"
  if (route.includes("anthropic")) return "anthropic"
  if (route.includes("gemini")) return "gemini"
  return "openai"
}

// Reserve conservatively because OpenRouter counts prompt tokens plus requested output
// against an effective budget that can be lower than the catalog context window.
const IMPLICIT_OPENROUTER_MAX_TOKENS = 2_048

export function defaultOpenRouterMaxTokens(model: Model, generation: GenerationOptionsFields | undefined) {
  if (generation?.maxTokens !== undefined || providerOptionNamespace(model) !== "openrouter") return generation
  const output = model.route.defaults.limits?.output
  return {
    ...generation,
    maxTokens: output === undefined ? IMPLICIT_OPENROUTER_MAX_TOKENS : Math.min(output, IMPLICIT_OPENROUTER_MAX_TOKENS),
  }
}

function isTerminalProviderEvent(event: ProviderErrorEvent) {
  const failure = AIChain.providerFailure(event)
  // Unknown text is not an authoritative rejection. Keep the provider's explicit
  // transient hint, but never let it override known auth/quota/invalid requests.
  return event.retryable === false || (failure.code !== "internal.defect" && failure.retryability === "none")
}

export function retryableProviderFailure(model: Model, error: LLMError) {
  return error.retryable && error.reason._tag !== "QuotaExceeded" && !isOpenRouterPaymentRequired(model, error)
}

function isOpenRouterPaymentRequired(model: Model, error: LLMError) {
  if (providerOptionNamespace(model) !== "openrouter") return false
  const http = "http" in error.reason ? error.reason.http : undefined
  return http?.response?.status === 402
}

function retryError(error: LLMError | ProviderErrorEvent): SessionEvent.RetryError {
  if (!(error instanceof LLMError))
    return {
      message: error.message,
      isRetryable: error.retryable === true,
      ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
      ...(error.responseHeaders === undefined ? {} : { responseHeaders: error.responseHeaders }),
      ...(error.responseBody === undefined ? {} : { responseBody: error.responseBody }),
    }
  const http = "http" in error.reason ? error.reason.http : undefined
  const statusCode = "status" in error.reason ? error.reason.status : http?.response?.status
  const responseHeaders =
    http?.response?.headers ?? ("responseHeaders" in error.reason ? error.reason.responseHeaders : undefined)
  const responseBody = http?.body ?? ("responseBody" in error.reason ? error.reason.responseBody : undefined)
  return {
    message: error.reason.message,
    isRetryable: error.retryable,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(responseHeaders === undefined ? {} : { responseHeaders }),
    ...(responseBody === undefined ? {} : { responseBody }),
  }
}

export function retryDelayMs(error: LLMError | ProviderErrorEvent, attempt: number) {
  return SessionResume.delayMs(AIChain.providerFailureCode(error), attempt, error.retryAfterMs)
}

export function modelResolveInitTimeoutMs(
  configured: string | undefined = process.env.OPENCODE_SESSION_MODEL_RESOLVE_INIT_TIMEOUT_MS,
) {
  const value = Number(configured)
  if (!Number.isFinite(value) || value <= 0) return MODEL_RESOLVE_INIT_TIMEOUT_MS
  return value
}

export function messageMaterializationTimeoutMs(
  configured: string | undefined = process.env.OPENCODE_SESSION_MESSAGE_MATERIALIZATION_TIMEOUT_MS,
) {
  return positiveTimeout(configured, MESSAGE_MATERIALIZATION_TIMEOUT_MS)
}

export function visionModelResolveTimeoutMs(
  configured: string | undefined = process.env.OPENCODE_SESSION_VISION_MODEL_RESOLVE_TIMEOUT_MS,
) {
  return positiveTimeout(configured, VISION_MODEL_RESOLVE_TIMEOUT_MS)
}

export function visionStreamTimeoutMs(
  configured: string | undefined = process.env.OPENCODE_SESSION_VISION_STREAM_TIMEOUT_MS,
) {
  return positiveTimeout(configured, VISION_STREAM_TIMEOUT_MS)
}

export function visionDelegationTimeoutMs(
  configured: string | undefined = process.env.OPENCODE_SESSION_VISION_DELEGATION_TIMEOUT_MS,
) {
  return positiveTimeout(configured, VISION_DELEGATION_TIMEOUT_MS)
}

function positiveTimeout(configured: string | undefined, fallback: number) {
  const value = Number(configured)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return value
}

export function withMessageMaterializationBoundary<A, E>(
  sessionID: SessionSchema.ID,
  effect: Effect.Effect<A, E>,
  timeoutMs: number = messageMaterializationTimeoutMs(),
) {
  const started = performance.now()
  return Effect.timeoutOrElse(effect, {
    duration: timeoutMs,
    orElse: () =>
      Effect.gen(function* () {
        yield* Effect.logWarning("session runner message materialization timed out", { sessionID, timeoutMs })
        yield* Perf.record({
          kind: "runner_boundary",
          source: "core-session-runner",
          sessionID,
          phase: "message_materialization",
          status: "timeout",
          duration_ms: elapsed(started),
          timeout_ms: timeoutMs,
        })
        return yield* new ContentStore.StorageError({
          operation: "read",
          resource: `session:${sessionID}:messages`,
          cause: new Error(`Message materialization timed out after ${timeoutMs}ms`),
        })
      }),
  })
}

export function withVisionBoundary<A, E>(input: {
  sessionID: SessionSchema.ID
  phase: "delegation" | "model_resolve" | "stream"
  timeoutMs: number
  effect: Effect.Effect<A, E>
  fallback: A
  model?: string
  messageID?: string
}) {
  const started = performance.now()
  const report = (status: "error" | "timeout", cause?: unknown) =>
    Effect.gen(function* () {
      const action = input.phase === "delegation" ? "using original messages" : "skipping candidate"
      yield* Effect.logWarning(`vision delegation ${input.phase} ${status}; ${action}`, {
        sessionID: input.sessionID,
        phase: input.phase,
        timeoutMs: input.timeoutMs,
        model: input.model,
        messageID: input.messageID,
        ...(cause === undefined ? {} : { cause }),
      })
      yield* Perf.record({
        kind: "runner_boundary",
        source: "core-session-runner",
        sessionID: input.sessionID,
        phase: `vision_${input.phase}`,
        status,
        duration_ms: elapsed(started),
        timeout_ms: input.timeoutMs,
        model: input.model,
        message_id: input.messageID,
      })
    })
  return Effect.timeoutOrElse(input.effect, {
    duration: input.timeoutMs,
    orElse: () => report("timeout").pipe(Effect.as(input.fallback)),
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
      return report("error", Cause.squash(cause)).pipe(Effect.as(input.fallback))
    }),
  )
}

// Snapshots are best-effort evidence for the assistant step, never a prerequisite for it. A
// wedged git invocation over a large worktree (for example a never-returning `git add --all`)
// must not terminally block the drain while the activity keeps heartbeating, so every
// runner-side snapshot wait is bounded and fails open to "no snapshot". Step.Ended
// publication and pending-steer promotion then still happen on schedule.
export const SNAPSHOT_BOUNDARY_TIMEOUT_MS = 120_000

export function snapshotBoundaryTimeoutMs() {
  const value = Number(process.env.OPENCODE_SNAPSHOT_BOUNDARY_TIMEOUT_MS)
  if (!Number.isFinite(value) || value <= 0) return SNAPSHOT_BOUNDARY_TIMEOUT_MS
  // Operators may only tighten the boundary; an oversized override must not lift the
  // hard cap that keeps a wedged git snapshot from blocking a drain indefinitely.
  return Math.min(value, SNAPSHOT_BOUNDARY_TIMEOUT_MS)
}

export function withSnapshotBoundary<A, E>(
  boundary: string,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A | undefined, E> {
  return Effect.timeoutOrElse(effect, {
    duration: snapshotBoundaryTimeoutMs(),
    orElse: () =>
      Effect.logWarning("session runner snapshot boundary timed out; continuing without snapshot", {
        boundary,
        timeoutMs: snapshotBoundaryTimeoutMs(),
      }).pipe(Effect.as(undefined)),
  })
}

function emptyCompletionFailure() {
  return new LLMError({
    module: "SessionRunner",
    method: "runProviderStream",
    reason: new TransportReason({
      message: "Provider returned an empty completion without usable final text or tool results",
      kind: "empty-completion",
      canRetry: true,
    }),
  })
}

function invalidToolInputFailure() {
  return new LLMError({
    module: "SessionRunner",
    method: "runProviderStream",
    reason: new TransportReason({
      message: "Invalid JSON input: provider repeatedly returned an incomplete tool call",
      kind: "invalid-tool-input",
      canRetry: false,
    }),
  })
}

function invalidStructuredOutputFailure() {
  return new LLMError({
    module: "SessionRunner",
    method: "runProviderStream",
    reason: new TransportReason({
      message: "Invalid structured output: StructuredOutput input does not match the requested schema",
      kind: "invalid-tool-input",
      canRetry: false,
    }),
  })
}

function missingStructuredOutputFailure() {
  return new LLMError({
    module: "SessionRunner",
    method: "runProviderStream",
    reason: new TransportReason({
      message: "Model did not produce structured output",
      kind: "missing-structured-output",
      canRetry: false,
    }),
  })
}

function finalTurnToolFailure() {
  return new LLMError({
    module: "SessionRunner",
    method: "runProviderStream",
    reason: new TransportReason({
      message: "Investigation tools are disabled on the final answer turn",
      kind: "unexpected-final-tool",
      canRetry: false,
    }),
  })
}

function isValidStructuredOutput(schema: Record<string, unknown>, input: unknown) {
  // Validate the raw tool input against the compiled schema. Schema.Top is
  // only the JSON-Schema representation's carrier for custom revivers; the
  // UnknownFromJsonString wrapper in the fanout text path is not applicable
  // to already-parsed provider tool input. Closed schema objects reject
  // excess properties instead of silently stripping them: a stripped decode
  // would mark payloads valid that the parent JSON decoder rejects.
  const compiled = structuredOutputSchema(schema) as Schema.Codec<unknown>
  const decode = Schema.decodeUnknownOption(compiled, { onExcessProperty: "error" })
  return decode(input)._tag === "Some"
}

function structuredOutputSchema(schema: Record<string, unknown>) {
  // Preserve local $defs/definitions so valid $ref schemas do not fail as
  // unresolvable references during input validation.
  const { $defs, definitions, ...rest } = schema as Record<string, unknown> & {
    readonly $defs?: Record<
      string,
      Parameters<typeof SchemaRepresentation.fromJsonSchemaDocument>[0]["definitions"][string]
    >
    readonly definitions?: Record<
      string,
      Parameters<typeof SchemaRepresentation.fromJsonSchemaDocument>[0]["definitions"][string]
    >
  }
  return SchemaRepresentation.toSchema(
    SchemaRepresentation.fromJsonSchemaDocument({
      dialect: "draft-2020-12",
      schema: rest,
      definitions: { ...definitions, ...$defs },
    }),
  )
}

function preflightContextOverflowMessage(model: Model, request: LLMRequest, contextEstimateTokens: number) {
  const context = model.route.defaults.limits?.context
  const limit = SessionCompaction.inputTokenLimit({ model, request })
  const output = SessionCompaction.outputTokenReserve({ model, request })
  return `Request was not sent: the estimated ${contextEstimateTokens} context tokens exceed this model's ${limit} input token budget (${context} context tokens after reserving ${output} output tokens). OpenCode could not compact this session safely; the conversation is preserved. Send a shorter follow-up or switch to a model with more context, then retry.`
}

function createStructuredOutputTool(schema: Record<string, unknown>) {
  const { $schema, ...inputSchema } = schema
  return new ToolDefinition({
    name: STRUCTURED_OUTPUT_TOOL,
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema,
  })
}

function readBudgetLimits(value: unknown) {
  if (!isRecord(value)) return
  const read = positiveInteger(value.read)
  const grep = positiveInteger(value.grep)
  const glob = positiveInteger(value.glob)
  if (read === undefined && grep === undefined && glob === undefined) return
  return {
    ...(read === undefined ? {} : { read }),
    ...(grep === undefined ? {} : { grep }),
    ...(glob === undefined ? {} : { glob }),
  }
}
function mergeReadBudgetLimits(
  configured: ReturnType<typeof readBudgetLimits>,
  metadata: ReturnType<typeof readBudgetLimits>,
) {
  const stricter = (left: number | undefined, right: number | undefined) => {
    if (left === undefined) return right
    if (right === undefined) return left
    return Math.min(left, right)
  }
  const read = stricter(configured?.read, metadata?.read)
  const grep = stricter(configured?.grep, metadata?.grep)
  const glob = stricter(configured?.glob, metadata?.glob)
  if (read === undefined && grep === undefined && glob === undefined) return
  return {
    ...(read === undefined ? {} : { read }),
    ...(grep === undefined ? {} : { grep }),
    ...(glob === undefined ? {} : { glob }),
  }
}

function positiveInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
