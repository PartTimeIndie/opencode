import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigAccessControl } from "@opencode-ai/core/config/access-control"
import { ConfigOptimization } from "@opencode-ai/core/config/optimization"
import { llmClient } from "@opencode-ai/core/effect/layer-node-platform"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Cause, Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { PermissionSafetyReview } from "@/permission/safety-review"
import { PermissionSafetyReviewIntent } from "@opencode-ai/core/permission/safety-review-intent"
import { HeadlessAI } from "@/headless-ai"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import { Perf } from "@opencode-ai/core/observability/perf"

export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  access_control?: ConfigAccessControl.Info
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  abort?: AbortSignal
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

export type WorkflowApprovalSource = "configured" | "safety_review" | "manual"

export type WorkflowApprovalTool = {
  readonly name: string
  readonly args: string
}

export type WorkflowApprovalModel = {
  sessionPreapprovedTools?: string[]
  approvalHandler: ((
    approvalTools: WorkflowApprovalTool[],
  ) => Promise<{ approved: boolean; message?: string }>) | null
}

export function rememberWorkflowToolApproval(input: {
  workflowModel: { sessionPreapprovedTools?: string[] }
  approvedToolsForSession: Set<string>
  accessControlMode?: ConfigAccessControl.Mode
  source: WorkflowApprovalSource
  toolNames: ReadonlyArray<string>
}) {
  if (input.source !== "safety_review" && input.accessControlMode === "approve_for_me") return false
  for (const name of input.toolNames) input.approvedToolsForSession.add(name)
  input.workflowModel.sessionPreapprovedTools = [
    ...new Set([...(input.workflowModel.sessionPreapprovedTools ?? []), ...input.toolNames]),
  ]
  return true
}

export function coalesceWorkflowSafetyReview(
  pending: Map<string, Promise<boolean>>,
  key: string,
  review: () => Promise<boolean>,
) {
  const existing = pending.get(key)
  if (existing) return existing
  const shared = review().finally(() => pending.delete(key))
  pending.set(key, shared)
  return shared
}

const workflowSafetyReviewsInFlight = new Map<string, Promise<boolean>>()

export type WorkflowSafetyReviewInput = {
  readonly accessControl?: ConfigAccessControl.Info
  readonly sessionID: string
  readonly permission: string
  readonly patterns: ReadonlyArray<string>
  readonly metadata: Record<string, unknown>
  readonly intent: PermissionSafetyReviewIntent.Envelope
  readonly tool: { readonly name: string; readonly input: ReadonlyArray<WorkflowApprovalTool> }
}

export function configureWorkflowApproval(input: {
  workflowModel: WorkflowApprovalModel
  toolNames: ReadonlyArray<string>
  ruleset: PermissionV1.Ruleset
  accessControl?: ConfigAccessControl.Info
  sessionID: string
  safetyIntent?: PermissionSafetyReviewIntent.Envelope
  check: (request: PermissionV1.AskInput) => Promise<PermissionV1.Rule>
  review: (request: WorkflowSafetyReviewInput) => Promise<boolean>
  ask: (request: PermissionV1.AskInput) => Promise<void>
  logSafetyApproval?: (input: {
    requestID: PermissionV1.ID
    sessionID: string
    permission: string
    patterns: ReadonlyArray<string>
    tools: ReadonlyArray<string>
  }) => Promise<void>
  logApprovalFailure?: (input: {
    requestID: PermissionV1.ID
    sessionID: string
    tools: ReadonlyArray<string>
    error: unknown
  }) => Promise<void>
  pendingReviews?: Map<string, Promise<boolean>>
}) {
  const approveForMe = input.accessControl?.mode === "approve_for_me"
  input.workflowModel.sessionPreapprovedTools = input.toolNames.filter((name) => {
    const match = input.ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
    if (approveForMe) return match?.action === "allow"
    return !match || match.action !== "ask"
  })

  const approvedToolsForSession = new Set<string>()
  const pendingReviews = input.pendingReviews ?? workflowSafetyReviewsInFlight
  input.workflowModel.approvalHandler = async (approvalTools) => {
    const uniqueNames = [...new Set(approvalTools.map((tool) => tool.name))]
    if (uniqueNames.every((name) => approvedToolsForSession.has(name))) return { approved: true }

    const id = PermissionV1.ID.ascending()
    try {
      const toolPatterns = approvalTools.map((tool) => {
        try {
          const parsed = JSON.parse(tool.args) as Record<string, unknown>
          const title = parsed.title ?? parsed.name
          return typeof title === "string" && title ? `${tool.name}: ${title}` : tool.name
        } catch {
          return tool.name
        }
      })
      const uniquePatterns = [...new Set(toolPatterns)]
      const request = {
        id,
        sessionID: SessionID.make(input.sessionID),
        permission: "workflow_tool_approval",
        patterns: uniquePatterns,
        metadata: { tools: approvalTools },
        always: uniquePatterns,
        ruleset: [],
        access_control: input.accessControl,
      } satisfies PermissionV1.AskInput
      const rule = await input.check(request)
      if (rule.action === "allow") {
        rememberWorkflowToolApproval({
          workflowModel: input.workflowModel,
          approvedToolsForSession,
          accessControlMode: input.accessControl?.mode,
          source: "configured",
          toolNames: uniqueNames,
        })
        return { approved: true }
      }

      const reviewKey = JSON.stringify({
        sessionID: input.sessionID,
        permission: request.permission,
        patterns: [...uniquePatterns].sort(),
        tools: approvalTools
          .map((tool) => ({ name: tool.name, args: tool.args }))
          .sort((left, right) => `${left.name}\0${left.args}`.localeCompare(`${right.name}\0${right.args}`)),
        intent: input.safetyIntent,
        safety: input.accessControl?.safety_review,
      })
      const autoApproved =
        rule.action === "ask" &&
        input.safetyIntent !== undefined &&
        (await coalesceWorkflowSafetyReview(pendingReviews, reviewKey, () =>
          input.review({
            accessControl: input.accessControl,
            sessionID: input.sessionID,
            permission: request.permission,
            patterns: uniquePatterns,
            metadata: request.metadata,
            intent: input.safetyIntent!,
            tool: { name: request.permission, input: approvalTools },
          }),
        ))
      if (autoApproved) {
        await input.logSafetyApproval?.({
          requestID: id,
          sessionID: input.sessionID,
          permission: request.permission,
          patterns: uniquePatterns,
          tools: uniqueNames,
        })
        rememberWorkflowToolApproval({
          workflowModel: input.workflowModel,
          approvedToolsForSession,
          accessControlMode: input.accessControl?.mode,
          source: "safety_review",
          toolNames: uniqueNames,
        })
        return { approved: true }
      }

      await input.ask(request)
      rememberWorkflowToolApproval({
        workflowModel: input.workflowModel,
        approvedToolsForSession,
        accessControlMode: input.accessControl?.mode,
        source: "manual",
        toolNames: uniqueNames,
      })
      return { approved: true }
    } catch (error) {
      await input.logApprovalFailure?.({
        requestID: id,
        sessionID: input.sessionID,
        tools: uniqueNames,
        error,
      })
      return { approved: false }
    }
  }
}

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | LLMClientService
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      const requestAssemblyStarted = Date.now()
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const workflowModel = yield* getGitLabWorkflowLanguageModel(language, input.model)
      const isWorkflow = workflowModel !== undefined
      const optimization = ConfigOptimization.resolve([{ type: "document", info: { optimization: cfg.optimization } }])
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
        optimization,
      })
      const requestSummary = LLMRequestPrep.summarizeRequestFootprint({
        system: prepared.system,
        messages: prepared.messages,
        tools: prepared.tools,
      })
      const requestMetrics = {
        sessionID: input.sessionID,
        providerID: input.model.providerID,
        modelID: input.model.id,
        agent: input.agent.name,
        request_assembly_ms: Date.now() - requestAssemblyStarted,
        message_count: requestSummary.messageCount,
        system_prompt_chars: requestSummary.systemPromptChars,
        system_prompt_estimate_tokens: requestSummary.systemPromptEstimateTokens,
        tool_count: requestSummary.activeToolNames.length,
        tool_names: requestSummary.activeToolNames.join(","),
        agent_tool_mode: input.agent.tools?.mode ?? "inherit",
        tool_schema_bytes: requestSummary.toolSchemaBytes,
        context_estimate_tokens: requestSummary.contextEstimateTokens,
        optimization_profile: optimization.profile,
        optimization_features: Object.entries(optimization.features)
          .flatMap(([name, enabled]) => (enabled ? [name] : []))
          .join(","),
      }
      yield* Perf.record({ kind: "request_assembly", source: "opencode", ...requestMetrics })
      if (optimization.features.runner_request_metrics) {
        yield* Effect.logInfo("session runner request metrics", requestMetrics)
        yield* Effect.sync(() => {
          console.error(
            [
              "session runner request metrics",
              `sessionID=${requestMetrics.sessionID}`,
              `providerID=${requestMetrics.providerID}`,
              `modelID=${requestMetrics.modelID}`,
              `agent=${requestMetrics.agent}`,
              `request_assembly_ms=${requestMetrics.request_assembly_ms}`,
              `message_count=${requestMetrics.message_count}`,
              `system_prompt_chars=${requestMetrics.system_prompt_chars}`,
              `system_prompt_estimate_tokens=${requestMetrics.system_prompt_estimate_tokens}`,
              `tool_count=${requestMetrics.tool_count}`,
              `tool_names=${requestMetrics.tool_names || "none"}`,
              `agent_tool_mode=${requestMetrics.agent_tool_mode}`,
              `tool_schema_bytes=${requestMetrics.tool_schema_bytes}`,
              `context_estimate_tokens=${requestMetrics.context_estimate_tokens}`,
              `optimization_profile=${requestMetrics.optimization_profile}`,
              `optimization_features=${requestMetrics.optimization_features || "none"}`,
            ].join(" "),
          )
        })
      }

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      const bridge = yield* EffectBridge.make()
      if (isWorkflow) {
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        const scopedAccessControl = ConfigAccessControl.fromUnknown(input.access_control)
        const accessControl = scopedAccessControl
          ? {
              mode: scopedAccessControl.mode,
              safety_review:
                (yield* config.getGlobal()).access_control?.safety_review ?? ConfigAccessControl.DEFAULT_INFO.safety_review,
            }
          : undefined
        const safetyIntent = PermissionSafetyReview.intent(input.messages)
        configureWorkflowApproval({
          workflowModel,
          toolNames: Object.keys(prepared.tools),
          ruleset,
          accessControl,
          sessionID: input.sessionID,
          safetyIntent,
          check: (request) => bridge.promise(perm.check(request)),
          review: (request) => bridge.promise(PermissionSafetyReview.review(request)),
          ask: (request) => bridge.promise(perm.ask(request)),
          logSafetyApproval: (approval) =>
            bridge.promise(
              Effect.logInfo("permission auto-approved by safety review", {
                path: "workflow_tool_approval",
                ...approval,
              }),
            ),
          logApprovalFailure: (failure) =>
            bridge.promise(
              Effect.logWarning("workflow tool approval failed", {
                ...failure,
              }),
            ),
        })
        workflowModel.approvalHandler = bridge.bind(workflowModel.approvalHandler!)
      }

      const tracer = cfg.experimental?.openTelemetry ? yield* openTelemetryTracer() : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is the default adapter over @opencode-ai/llm.
      // Unsupported provider/package/auth combinations fall back to AI SDK with
      // a concrete reason so provider coverage can be expanded incrementally.
      const native = LLMNativeRuntime.stream({
        sessionID: input.sessionID,
        model: input.model,
        provider: item,
        auth: info,
        llmClient,
        messages: prepared.messages,
        tools: prepared.tools,
        toolChoice: input.toolChoice,
        temperature: prepared.params.temperature,
        topP: prepared.params.topP,
        topK: prepared.params.topK,
        maxOutputTokens: prepared.params.maxOutputTokens,
        retries: input.retries,
        providerOptions: prepared.params.options,
        headers: prepared.headers,
        abort: input.abort,
      })
      if (native.type === "supported") {
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "native",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
        })
        return {
          type: "native" as const,
          stream: native.stream,
        }
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
        "llm.native_unsupported_reason": native.reason,
      })

      // Fallback runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      return {
        type: "ai-sdk" as const,
        result: streamText({
          onError(error) {
            bridge.fork(
              Effect.logError("stream error", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                "session.id": input.sessionID,
                small: (input.small ?? false).toString(),
                agent: input.agent.name,
                mode: input.agent.mode,
                error,
              }),
            )
          },
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks: input.model.providerID.includes("github-copilot"),
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          messages: prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // @ts-expect-error
                    args.params.prompt = ProviderTransform.message(
                      args.params.prompt,
                      input.model,
                      prepared.messageTransformOptions,
                    )
                  }
                  return args.params
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )
            const abort = input.abort
            if (abort?.aborted) {
              ctrl.abort(abort.reason)
            } else if (abort) {
              const onAbort = () => ctrl.abort(abort.reason)
              abort.addEventListener("abort", onAbort, { once: true })
              yield* Effect.addFinalizer(() => Effect.sync(() => abort.removeEventListener("abort", onAbort)))
            }

            const result = yield* run({ ...input, abort: ctrl.signal })

            if (result.type === "native") return result.stream

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState()
            const iterator = result.result.fullStream[Symbol.asyncIterator]()
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                ctrl.abort()
                void iterator.return?.()
              }),
            )
            return Stream.fromPull(
              Effect.succeed(
                Effect.gen(function* () {
                  type Next = Awaited<ReturnType<typeof iterator.next>>
                  const next = yield* Effect.tryPromise({
                    try: (signal) =>
                      new Promise<Next>((resolve, reject) => {
                        const abort = () => {
                          ctrl.abort(signal.reason)
                          reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
                        }
                        if (signal.aborted) return abort()
                        signal.addEventListener("abort", abort, { once: true })
                        Promise.resolve(iterator.next()).then(resolve, reject).finally(() => {
                          signal.removeEventListener("abort", abort)
                        })
                      }),
                    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
                  })
                  if (next.done) return yield* Cause.done()
                  return [next.value] as [typeof next.value]
                }),
              ),
            ).pipe(
              Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            )
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const layer = live.pipe(
  Layer.provide(Permission.defaultLayer),
  Layer.provide(HeadlessAI.layer),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(
      LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
    ),
    Layer.provide(RuntimeFlags.defaultLayer),
  ),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

const getGitLabWorkflowLanguageModel = Effect.fn("LLM.getGitLabWorkflowLanguageModel")(function* (
  language: unknown,
  model: Provider.Model,
) {
  if (model.api.npm !== "gitlab-ai-provider") return undefined
  const gitlab = yield* Effect.promise(() => import("gitlab-ai-provider"))
  if (!(language instanceof gitlab.GitLabWorkflowLanguageModel)) return undefined
  return language
})

const openTelemetryTracer = Effect.fn("LLM.openTelemetryTracer")(function* () {
  const otel = yield* Effect.promise(() => import("@effect/opentelemetry/Tracer"))
  return Option.getOrUndefined(yield* Effect.serviceOption(otel.OtelTracer))
})

export const node = LayerNode.make(layer, [
  Auth.node,
  Config.node,
  Provider.node,
  Plugin.node,
  Permission.node,
  llmClient,
  RuntimeFlags.node,
])

export * as LLM from "./llm"
