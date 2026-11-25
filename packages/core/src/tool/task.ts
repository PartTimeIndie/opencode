export * as TaskTool from "./task"

import { ToolFailure } from "@opencode-ai/llm"
import { Cause, Effect, Exit, Fiber, Layer, Option, Schema, Semaphore } from "effect"
import { createHash } from "node:crypto"
import { AgentV2 } from "../agent"
import { FanoutWorkflow } from "../fanout-workflow"
import { Config } from "../config"
import { ConfigMultiAgent } from "../config/multi-agent"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import { ProjectV2 } from "../project"
import { QuestionV2 } from "../question"
import { SessionV2, admitPrompt, createSession, type CreateInput, type PromptInput } from "../session"
import { SessionExecution } from "../session/execution"
import { SessionFork } from "../session/fork"
import { SessionHistory } from "../session/history"
import { SessionInput } from "../session/input"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { SessionAgentPolicy } from "../session/agent-policy"
import { TaskAdmission } from "../session/task-admission"
import { TaskContext } from "../session/task-context"
import { DelegationPreferences } from "../session/delegation-preferences"
import { WorkspaceCheckout } from "../session/workspace/checkout"
import { WorkspaceBasis } from "../session/workspace/basis"
import { MirrorRoot } from "../session/workspace/mirror-root"
import { ContentStore } from "../content-store"
import { Tool } from "./tool"
import { ModelPolicy } from "./model-policy"
import { TaskJob } from "./task-job"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"
import { reviewerText } from "../util/tool-details"
import { ReviewerLoopPolicy } from "./reviewer-loop-policy"
import { collectReviewResult, type ReviewEvidenceReference } from "./review-result-recovery"

export const name = "task"
export const fanoutName = "multi_agent_fanout"

export function reviewRecoveryEnabled(settings: ConfigMultiAgent.Info | undefined) {
  const review = settings?.review
  return typeof review === "object" && review !== null ? review.result_recovery !== false : true
}

const UNLIMITED = Number.POSITIVE_INFINITY
const REVIEWER_STATUS_POLL_MS = 15_000

const PositiveBudget = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
const ToolBudget = Schema.Struct({
  read: PositiveBudget.pipe(Schema.optional),
  grep: PositiveBudget.pipe(Schema.optional),
  glob: PositiveBudget.pipe(Schema.optional),
})

export const Input = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  topics: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: "Explicitly judged task topics for saved delegation rules and advice. These are not permission or model grants.",
  }),
  workspace: Schema.Literals(["mirror", "main", "readonly"]).pipe(Schema.optional).annotate({
    description: "Defaults to mirror: independent private project files. Readonly restricts this task to read, grep and glob in Main. Main writing requires a separate single-use host approval; this choice grants no file or Shell permission.",
  }),
  untracked_paths: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: "Up to 256 explicitly selected repository-relative non-ignored untracked files to include in a new mirror. Tracked dirty files are included automatically. No free destination path or implicit private-file scan.",
  }),
  context: TaskContext.Mode.pipe(Schema.optional).annotate({
    description: "Initial conversation context, independent of workspace. Defaults to fork (sanitized parent history). Use fresh for a self-contained assignment with only the child's own instructions, no parent history or attachments. Choose explicitly; a failed fork never falls back. Follow-ups retain the original mode and child history.",
  }),
  subagent_type: Schema.String.annotate({
    description: "The configured agent ID or a plugin-registered alias. Unknown IDs fail closed.",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Optional model override. Omit this to inherit the configured agent/session chain. Only models configured on the selected agent, on the parent session, or in its Settings model chain are accepted; never guess a model from prior defaults. Unconfigured models are rejected with the allowed list.",
  }),
  variant: Schema.String.pipe(Schema.optional).annotate({
    description: "Optional model variant or thinking amount for this task",
  }),
  task_id: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Set only to send a new follow-up prompt to a terminal child Session. It is not a result handle: never pass a running task_id to task to collect status or output; use task_wait or task_result instead.",
  }),
  background: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Start the task in the background and return immediately instead of waiting for the result",
  }),
  timeout_ms: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.optional).annotate({
    description:
      "Optional hard runtime ceiling in milliseconds for non-review tasks. Reviewer and registered fanout workflow tasks always run without a runtime ceiling and ignore this field.",
  }),
  result_schema: Schema.Record(Schema.String, Schema.Any).pipe(Schema.optional).annotate({
    description: "Optional JSON Schema for the final result. Registered workflows supply their own default schema.",
  }),
  tool_budget: ToolBudget.pipe(Schema.optional).annotate({
    description:
      "Optional hard per-tool limits for read, grep, and glob. Omit this for unlimited tool use, including review tasks.",
  }),
  workflow: Schema.String.pipe(Schema.optional).annotate({
    description:
      'Optional registered plugin workflow ID, command, or public name (for example "review" or "/multi-agent-review"); commands may include or omit a leading slash. Never pass the tool name "multi_agent_fanout" as the workflow.',
  }),
  command: Schema.String.pipe(Schema.optional).annotate({ description: "The command that triggered this task" }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  task_id: SessionSchema.ID,
  state: Schema.Literals(["running", "completed", "error"]),
  summary: Schema.String.pipe(Schema.optional),
  text: Schema.String,
  background: Schema.Boolean.pipe(Schema.optional),
  next_action: Schema.Literals(["wait", "resume", "none"]).pipe(Schema.optional),
})
export type Output = typeof Output.Type

const FanoutInput = Schema.Struct({
  context: TaskContext.Mode.pipe(Schema.optional).annotate({
    description: "Initial reviewer context: fork (default) inherits sanitized dialogue; fresh receives only the complete review brief and its own instructions. Independent of the enforced read-only workspace. No automatic fallback.",
  }),
  topics: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: "Explicit task topics used by saved delegation rules, not keyword routing or permission grants.",
  }),
  workflow: Schema.String.annotate({
    description:
      'The registered plugin workflow ID, command, or public name (for example "review" or "/multi-agent-review"). Never pass the tool name "multi_agent_fanout" as the workflow. Commands may include or omit a leading slash; the workflow supplies the configured worker models and result schema.',
  }),
  prompt: Schema.String.annotate({ description: "The identical read-only task sent to every configured reviewer." }),
  requested_reviewers: Schema.Array(ConfigMultiAgent.Reviewer).pipe(Schema.optional).annotate({
    description:
      "Optional explicit reviewer override from the current user request. Reviewer models must be configured (Settings reviewer list, agent, session, or Settings model chain); reviewers with unconfigured models fail with the allowed model list.",
  }),
  injected_reviewers: Schema.Array(ConfigMultiAgent.Reviewer).pipe(Schema.optional).annotate({
    description:
      "Optional reviewer snapshot for callers without live Settings. Current OpenCode config is authoritative, including a missing or empty reviewer list, and never falls back to this snapshot.",
  }),
  timeout_ms: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
    .pipe(Schema.optional)
    .annotate({
      description:
        "Deprecated compatibility field; ignored. Reviewers always run without a runtime ceiling. Omit this field.",
    }),
  tool_budget: ToolBudget.pipe(Schema.optional).annotate({
    description: "Optional hard per-reviewer limits for read, grep, and glob. Omit this for unlimited tool use.",
  }),
})

const FanoutResult = Schema.Struct({
  reviewer: ConfigMultiAgent.Reviewer,
  sessionID: Schema.String.pipe(Schema.optional),
  status: Schema.Literals(["success", "partial", "spawn_no_output", "error"]),
  task: Output,
  result: Schema.Unknown.pipe(Schema.optional),
  repairClaim: Schema.String.pipe(Schema.optional),
  recovery: Schema.Struct({
    source: Schema.Literals(["original", "repaired"]),
    findings: Schema.Array(Schema.Unknown),
    original: Schema.String,
    repaired: Schema.String.pipe(Schema.optional),
    issues: Schema.Array(Schema.String),
    evidence: Schema.Array(Schema.Struct({
      messageID: SessionMessage.ID,
      partIDs: Schema.Array(Schema.String),
      digest: Schema.String,
      phase: Schema.Literals(["initial", "correction", "legacy"]),
      findingIndexes: Schema.Array(Schema.Number),
    })).pipe(Schema.optional),
    // Maps each retained receipt finding back to the full evidence-index space.
    retainedFindingIndexes: Schema.Array(Schema.Number).pipe(Schema.optional),
    omittedFindings: Schema.Number.pipe(Schema.optional),
    usage: Schema.Unknown.pipe(Schema.optional),
    repairStatus: Schema.Literals(["success", "failed", "unavailable"]).pipe(Schema.optional),
  }).pipe(Schema.optional),
})

const FanoutOutput = Schema.Struct({
  workflow: Schema.String,
  source: Schema.Literals(["user override", "active config", "injected snapshot"]),
  configured_path: Schema.String,
  changed_from_injected: Schema.Boolean,
  results: Schema.Array(FanoutResult),
})

type RenderOutput = {
  readonly sessionID: string
  readonly task_id: string
  readonly state: "running" | "completed" | "error"
  readonly summary?: string
  readonly text: string
  readonly background?: boolean
  readonly next_action?: "wait" | "resume" | "none"
}

const TaskStatus = Schema.Struct({
  task_id: SessionSchema.ID,
  parent_session_id: SessionSchema.ID,
  state: Schema.Literals(["running", "completed", "error", "cancelled"]),
  title: Schema.String,
  background: Schema.Literal(true),
  started_at: Schema.Number,
  updated_at: Schema.Number,
  heartbeat_at: Schema.Number.pipe(Schema.optional),
  completed_at: Schema.Number.pipe(Schema.optional),
  result: Schema.String.pipe(Schema.optional),
  error: Schema.String.pipe(Schema.optional),
  delivery: Schema.Literals(["new", "already_delivered"]).pipe(Schema.optional),
  next_action: Schema.Literals(["wait", "resume", "none"]),
})
type TaskStatus = typeof TaskStatus.Type

const TaskResultInput = Schema.Struct({
  task_id: Schema.String.annotate({
    description: "The child Session ID returned by task. This reads durable status and never resumes the child.",
  }),
})

const TaskWaitInput = Schema.Struct({
  task_ids: Schema.Array(Schema.String).annotate({
    description: "One or more child Session IDs returned by task, collected together in input order",
  }),
  timeout_ms: Schema.Number.pipe(Schema.optional).annotate({
    description:
      "Optional maximum time to wait in milliseconds. Omit for an unlimited wait; a timeout does not fail or cancel the task.",
  }),
})

const TaskWaitOutput = Schema.Struct({
  tasks: Schema.Array(TaskStatus),
  timed_out: Schema.Boolean,
})

export const description = `Launch a new agent to handle complex, multistep tasks autonomously.

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

Use a fast/low agent only for simple, mechanical lookups whose answer you will verify yourself. Use a deeper agent whenever the subagent's judgment is the deliverable. Do not use the Task tool when a direct Read, Glob, or Grep call would answer the question more quickly.

Each invocation starts a fresh child session unless you provide task_id to send a new follow-up prompt to a terminal child session. A task_id is not a result handle. Never call task with a running task_id to collect it. When background is omitted or false, the tool waits and returns the final result. With background: true, it returns quickly with state running; collect one or more children with task_wait, recover durable status with task_result, and use task_cancel only to stop work.

Every child stores a session-scoped capability snapshot. Its tools and permissions are always the intersection of the selected subagent and every parent in the spawn chain; a child can never escalate beyond its parent. Legacy task sessions without this snapshot cannot be resumed.

Context and files are independent: context=fork (default) inherits sanitized conversation history; context=fresh uses only your self-contained assignment and the child's own instructions, with no parent attachments. Choose fresh for bounded independent work; choose fork when prior dialogue matters. Workspace still defaults to mirror. Neither choice bypasses permissions, new steer input, source drift or Main consent. A failed fork never silently becomes fresh. Follow-ups keep the child's history and original mode.

Tasks have no implicit runtime ceiling. Reviewer and registered fanout workflow tasks ignore timeout_ms and always run without a runtime ceiling. For other tasks, set timeout_ms only when the caller explicitly wants a hard deadline; use task_cancel to stop background work manually.

To hand work between models without losing child history, resume the same task_id with the same subagent_type and pass the new model and optional variant. The override applies to the resumed prompt and its execution. Model overrides are restricted to the models configured on the selected agent, the parent session, and its model chain; unconfigured models are rejected with the allowed list instead of being executed.`

export const renderOutput = (input: RenderOutput) => {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.task_id}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    ...(input.next_action ? [`<next_action>${input.next_action}</next_action>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

function unknownAgentMessage(input: string, agents: ReadonlyArray<AgentV2.Info>) {
  const available = agents
    .filter((agent) => !agent.hidden)
    .map((agent) => agent.id)
    .sort()
  const suffix = available.length ? ` Available agent types: ${available.join(", ")}.` : ""
  return `Unknown agent type: ${input} is not a valid agent type.${suffix}`
}

type TaskSessionOps = {
  readonly start?: (input: TaskAdmission.Input) => Effect.Effect<SessionSchema.Info, unknown>
  readonly followup?: (input: TaskAdmission.FollowupInput) => Effect.Effect<SessionSchema.Info, unknown>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info, unknown>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, unknown>
  readonly find: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info | undefined, unknown>
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionInput.Admitted, unknown>
  readonly run: (sessionID: SessionSchema.ID, admitted: SessionInput.Admitted) => Effect.Effect<void, unknown>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void, unknown>
  readonly messages: (sessionID: SessionSchema.ID, promptID?: SessionMessage.ID) => Effect.Effect<ReadonlyArray<SessionMessage.Message>, unknown>
  readonly limits: () => Effect.Effect<{ maxThreads: number; maxDepth: number }>
  readonly reviewers: (
    input: ConfigMultiAgent.ResolveReviewerInput,
  ) => Effect.Effect<ConfigMultiAgent.ResolveReviewerResult>
  readonly reviewRecovery: () => Effect.Effect<boolean>
}

export function resolveConfiguredReviewers(config: Config.Interface, input: ConfigMultiAgent.ResolveReviewerInput) {
  return config.entries({ refresh: true }).pipe(
    Effect.map((entries) =>
      ConfigMultiAgent.resolveReviewers({
        ...input,
        active: Config.latest(entries, "multi_agent"),
        injectedReviewers: undefined,
      }),
    ),
  )
}

/** Run durable task input without granting a forced, input-free provider turn. */
export const runAdmitted = (execution: SessionExecution.Interface, admitted: SessionInput.Admitted) =>
  execution.wake(admitted.sessionID, admitted.admittedSeq).pipe(Effect.andThen(execution.wait(admitted.sessionID)))

const layerWith = <R>(sessionOps: Effect.Effect<TaskSessionOps, never, R>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const tools = yield* Tools.Service
      const permission = yield* PermissionV2.Service
      const agents = yield* AgentV2.Service
      const registry = yield* ToolRegistry.Service
      const jobs = yield* TaskJob.Service
      const sessions = yield* sessionOps
      const delivered = new Set<SessionSchema.ID>()
      const workflows = Option.getOrUndefined(yield* Effect.serviceOption(FanoutWorkflow.Service))
      // Fanout worker call IDs are local correlation keys, not persisted tool
      // calls. Keep the actual host call separately and out of model input.
      const fanoutBoundaries = new WeakMap<Tool.Context, { readonly messageID: SessionMessage.ID; readonly callID: string }>()

      const task = Tool.make({
        description,
        input: Input,
        output: Output,
        toModelOutput: ({ output }) => [{ type: "text", text: renderOutput(output) }],
        execute: (input, context) =>
          Effect.gen(function* () {
            const workflow = input.workflow ? workflows?.resolve(input.workflow) : workflows?.command(input.command)
            if (input.workflow && !workflow)
              return yield* Effect.fail(new ToolFailure({ message: unregisteredWorkflow(input.workflow) }))
            const subagentType = AgentV2.ID.make(workflows?.agent(input.subagent_type) ?? input.subagent_type)
            // A model-supplied deadline must not cut off a working reviewer.
            // Keep explicit deadlines for ordinary tasks and cancellation for all children.
            const timeout = workflow || subagentType === "review" ? undefined : input.timeout_ms
            if (workflow && subagentType !== workflow.agentID)
              return yield* Effect.fail(
                new ToolFailure({
                  message: `${workflow.id} requires subagent_type ${workflow.agentID}; received ${input.subagent_type}`,
                }),
              )
            yield* permission
              .assert({
                action: workflow ? fanoutName : name,
                resources: [subagentType],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                metadata: {
                  description: input.description,
                  subagent_type: subagentType,
                },
                source: { type: "tool", ...(fanoutBoundaries.get(context) ?? {
                  messageID: context.assistantMessageID, callID: context.toolCallID,
                }) },
              })
              .pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied: task ${subagentType}` })))

            const nextAgent = yield* agents.get(subagentType).pipe(
              Effect.flatMap((agent) =>
                agent
                  ? Effect.succeed(agent)
                  : agents.all().pipe(
                      Effect.flatMap((available) =>
                        Effect.fail(
                          new ToolFailure({
                            message: unknownAgentMessage(input.subagent_type, available),
                          }),
                        ),
                      ),
                    ),
              ),
            )
            const parent = yield* sessions
              .get(context.sessionID)
              .pipe(Effect.mapError(() => new ToolFailure({ message: `Session not found: ${context.sessionID}` })))
            const taskID = input.task_id ? yield* parseTaskID(input.task_id) : undefined
            const placement = yield* taskPlacement(parent, sessions)
            const limits = yield* sessions.limits()
            if (placement.depth > limits.maxDepth)
              return yield* Effect.fail(
                new ToolFailure({
                  message: `Task depth limit reached (${limits.maxDepth}). Continue the work in the current agent.`,
                }),
              )
            const modelSelection = ModelPolicy.selectModel({
              model: input.model,
              variant: input.variant,
              agent: nextAgent.model,
              parent: parent.model,
              extra: context.allowedModels,
              direct: workflow !== undefined,
            })
            if (!modelSelection.ok)
              return yield* Effect.fail(new ToolFailure({ message: ModelPolicy.rejectionMessage(modelSelection) }))
            const correlatedID = taskID ?? taskSessionID(context)
            const existing = taskID
              ? yield* sessions.get(taskID).pipe(
                  Effect.mapError(() => new ToolFailure({ message: `Task not found: ${input.task_id}` })),
                  Effect.flatMap((session) => validateTaskSession(session, context.sessionID, parent, nextAgent)),
                )
              : yield* sessions.find(correlatedID).pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Unable to reconcile task retry: ${formatRunError(error)}` }),
                  ),
                  Effect.flatMap((session) =>
                    session
                      ? validateTaskSession(session, context.sessionID, parent, nextAgent)
                      : Effect.succeed(undefined),
                  ),
                )
            // Preserve an explicitly saved child selection on RESUME follow-ups
            // (task_id) without a human override: re-select from the saved
            // child model (inherit) so an explicit chain null survives. An
            // explicit new model or variant override is respected instead.
            // Correlation retries WITHOUT task_id keep the original
            // modelSelection: the admitted prompt ID is deterministic per
            // invocation context, and real admission compares the full encoded
            // prompt including its model — sending a newly inherited model
            // with the original prompt ID would fail as PromptConflictError
            // instead of reconciling the already-admitted task.
            const reselected =
              taskID !== undefined && existing?.model && input.model === undefined && input.variant === undefined
                ? ModelPolicy.selectModel({
                    agent: nextAgent.model,
                    parent: parent.model,
                    inherit: existing.model,
                    extra: context.allowedModels,
                  })
                : undefined
            const model =
              reselected !== undefined
                ? reselected.ok
                  ? reselected.model
                  : modelSelection.model
                : modelSelection.model
            const parentAgent = yield* agents
              .get(context.agent)
              .pipe(
                Effect.flatMap((agent) =>
                  agent
                    ? Effect.succeed(agent)
                    : Effect.fail(new ToolFailure({ message: `Parent agent not found: ${context.agent}` })),
                ),
              )
            const childID = existing?.id ?? correlatedID
            const active = yield* jobs.get(childID)
            if (active?.status === "running")
              return {
                sessionID: childID,
                task_id: childID,
                state: "running" as const,
                summary: active.title,
                text: `Task ${childID} is already running. The supplied follow-up prompt was not admitted or stored. Collect the task with task_wait, then send the follow-up again only after the child is terminal.`,
                background: true,
                next_action: "wait" as const,
              }

            const prompt = taskPrompt(input, workflow)
            // A native dispatch child needs a fresh admitted scope: its saved
            // binding accepts exactly one input, and a main-writing follow-up
            // needs its own single-use host consent. Legacy children keep the
            // ordinary prompt path.
            if (taskID !== undefined && existing && sessions.followup && existing.agentPolicy?.source.type === "task")
              yield* sessions.followup({
                childID,
                parentID: context.sessionID,
                parentAgent: context.agent,
                boundary: {
                  assistantMessageID: context.assistantMessageID,
                  toolCallID: fanoutBoundaries.get(context)?.callID ?? context.toolCallID,
                },
                prompt: { id: taskPromptID(context), sessionID: childID, prompt, agent: nextAgent.id,
                  ...(model === undefined ? {} : { model }), resume: false },
                agent: nextAgent.id,
                ...(model === undefined ? {} : { model }),
                topics: input.topics,
                context: input.context,
                workflowTools: workflow?.tools,
                action: workflow ? "multi_agent_fanout" : "task",
                modelSelection: { requested: input.model, variant: input.variant, workflow: workflow?.configKey },
              }).pipe(
                Effect.mapError((error) => admissionFailure(error, "Unable to admit the task follow-up")),
              )

            return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
            if (input.background) {
              yield* jobs
                .reserve({
                  taskID: childID,
                  parentSessionID: context.sessionID,
                  parentMessageID: context.assistantMessageID,
                  parentCallID: context.toolCallID,
                  title: input.description,
                  rootSessionID: placement.rootSessionID,
                  maxThreads: limits.maxThreads,
                  metadata: {
                    background: true,
                    description: input.description,
                    subagentType: nextAgent.id,
                    rootSessionID: placement.rootSessionID,
                    depth: placement.depth,
                    ...(input.model ? { model: input.model } : {}),
                    ...(input.variant ? { variant: input.variant } : {}),
                  },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
            }

            // Acquisition and cleanup registration share one mask. Restore only
            // preparation so a pending interrupt cannot orphan a renewed lease.
            return yield* restore(Effect.gen(function* () {
            const child = existing && (taskID !== undefined || !sessions.start)
              ? existing
              : yield* Effect.gen(function* () {
                  const parentDelegableTools = yield* registry.materialize(
                    yield* permission.materializationRules({ sessionID: parent.id, agent: parentAgent.id }),
                    SessionAgentPolicy.delegable(parent.agentPolicy?.tools ?? parentAgent.tools),
                  )
                  const childTools = yield* registry.materialize(nextAgent.permissions, nextAgent.tools)
                  const create: CreateInput = {
                    id: childID,
                    parentID: context.sessionID,
                    title: `${input.description} (@${nextAgent.id} subagent)`,
                    agent: nextAgent.id,
                    ...(model === undefined ? {} : { model }),
                    metadata: taskMetadata(parent, input),
                    agentPolicy: SessionAgentPolicy.derive({
                      parent: parent.agentPolicy,
                      parentSessionID: parent.id,
                      parentAgent,
                      parentDelegableTools: parentDelegableTools.definitions.map((tool) => tool.name),
                      childTools: childTools.definitions
                        .map((tool) => tool.name)
                        .filter((name) => !workflow || workflow.tools.includes(name)),
                      type: "task",
                    }),
                    location: parent.location,
                  }
                  return yield* sessions.start
                    ? sessions.start({
                        create,
                        prompt: { id: taskPromptID(context), sessionID: childID, prompt: taskPrompt(input, workflow),
                          agent: nextAgent.id, ...(model === undefined ? {} : { model }), resume: false },
                        parentAgent: context.agent,
                        boundary: { assistantMessageID: context.assistantMessageID,
                          toolCallID: fanoutBoundaries.get(context)?.callID ?? context.toolCallID },
                        workflowTools: workflow?.tools,
                        action: workflow ? "multi_agent_fanout" : "task",
                        topics: input.topics,
                        workspace: input.workspace,
                        context: input.context,
                        untrackedPaths: input.untracked_paths,
                        modelSelection: { requested: input.model, variant: input.variant, workflow: workflow?.configKey },
                      })
                    : sessions.create(create)
                }).pipe(
                  Effect.mapError(
                    (error) => admissionFailure(error, "Unable to create task session"),
                  ),
                )

            yield* context.progress?.({ structured: { sessionID: child.id, state: "starting" }, content: [] }) ??
              Effect.void
            const decodeResult =
              prompt.format?.type === "json_schema" ? FanoutWorkflow.resultDecoder(prompt.format.schema) : undefined
            if (input.background) {
              const admission = yield* sessions
                .prompt({
                  id: taskPromptID(context),
                  sessionID: child.id,
                  prompt,
                  agent: nextAgent.id,
                  ...(model === undefined ? {} : { model }),
                  resume: false,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      jobs
                        .fail(child.id, formatRunError(error))
                        .pipe(Effect.as(taskError(child.id, input.description, formatRunError(error)))),
                    onSuccess: (admitted) => Effect.succeed({ admitted }),
                  }),
                )
              if (!("admitted" in admission)) return admission

              const backgroundRun = sessions.run(child.id, admission.admitted).pipe(
                Effect.andThen(readTaskText(sessions, child.id, admission.admitted, !!prompt.format, decodeResult)),
              )
              yield* jobs.launch(
                child.id,
                (timeout === undefined
                  ? backgroundRun
                  : backgroundRun.pipe(
                      Effect.timeoutOrElse({
                        duration: timeout,
                        orElse: () =>
                          sessions
                            .interrupt(child.id)
                            .pipe(
                              Effect.ignore,
                              Effect.andThen(
                                Effect.fail(new ToolFailure({ message: `Task timed out after ${timeout}ms` })),
                              ),
                            ),
                      }),
                    )
                ).pipe(Effect.onInterrupt(() => sessions.interrupt(child.id).pipe(Effect.ignore))),
              )
              return {
                sessionID: child.id,
                task_id: child.id,
                state: "running" as const,
                summary: `Background task started: ${input.description}`,
                text: `Task ${child.id} is running in the background. Use task_wait or task_result to retrieve its result.`,
                background: true,
                next_action: "wait" as const,
              }
            }

            const childRun = sessions
              .prompt({
                id: taskPromptID(context),
                sessionID: child.id,
                prompt,
                agent: nextAgent.id,
                ...(model === undefined ? {} : { model }),
                resume: false,
              })
              .pipe(
                Effect.flatMap((admitted) =>
                  (
                    context.progress?.({ structured: { sessionID: child.id, state: "running" }, content: [] }) ??
                    Effect.void
                  ).pipe(
                    Effect.andThen(sessions.run(child.id, admitted)),
                    Effect.as(admitted),
                  ),
                ),
              )
            const run = (
              timeout === undefined
                ? childRun
                : childRun.pipe(
                    Effect.timeoutOrElse({
                      duration: timeout,
                      orElse: () =>
                        sessions.interrupt(child.id).pipe(
                          Effect.ignore,
                          Effect.andThen(
                            Effect.fail(
                              new ToolFailure({
                                message: `Task timed out after ${timeout}ms`,
                              }),
                            ),
                          ),
                        ),
                    }),
                  )
            ).pipe(Effect.onInterrupt(() => sessions.interrupt(child.id).pipe(Effect.ignore)))
            const runResult = yield* run.pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasDies(cause)) return Effect.failCause(cause)
                if (Cause.hasInterruptsOnly(cause))
                  return Effect.fail(new ToolFailure({ message: "Task was interrupted before completing" }))
                return Effect.fail(Cause.squash(cause))
              }),
              Effect.matchEffect({
                onFailure: (error) => Effect.succeed(taskError(child.id, input.description, formatRunError(error))),
                onSuccess: (admitted) => Effect.succeed({ admitted }),
              }),
            )
            if (!("admitted" in runResult)) return runResult

            const text = yield* readTaskText(
              sessions,
              child.id,
              runResult.admitted,
              !!prompt.format,
              decodeResult,
            ).pipe(Effect.catch((error) => Effect.succeed(taskError(child.id, input.description, error.message))))
            if (typeof text !== "string") return text
            return {
              sessionID: child.id,
              task_id: child.id,
              state: "completed" as const,
              text,
              next_action: "none" as const,
            }
            })).pipe(Effect.onExit((exit) =>
              input.background && Exit.isFailure(exit)
                ? jobs.fail(childID, Cause.hasInterruptsOnly(exit.cause)
                  ? "Task preparation was interrupted before launch"
                  : formatRunError(Cause.squash(exit.cause))).pipe(Effect.asVoid)
                : Effect.void,
            ))
            }))
          }),
      })

      yield* tools
        .register({
          [name]: task,
          [fanoutName]: Tool.make({
            description:
              "Use this tool when the current user request explicitly asks for multiple independent agents to review, investigate, or compare proposals, or when an already authorized workflow requires that fanout (for example /multi-agent-review or /multi-agent-problem-solver). For ordinary questions, document lookup, file search, or source inspection, use read, grep, or glob directly. A configured model chain selects models; it is not a request for parallel reviewers. If the user asks to look directly instead of using multiple agents, follow that instruction. Run the selected registered plugin workflow through its configured worker models without reviewer runtime ceilings, enforce its declared result schema and tool scope, and collect every worker exactly once.",
            input: FanoutInput,
            output: FanoutOutput,
            toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const workflow = workflows?.resolve(input.workflow)
                if (!workflow)
                  return yield* Effect.fail(new ToolFailure({ message: unregisteredWorkflow(input.workflow) }))
                const resolved = yield* sessions.reviewers({
                  skillKey: workflow.configKey,
                  requestedReviewers: input.requested_reviewers,
                  injectedReviewers: input.injected_reviewers,
                })
                if (!resolved.ok) return yield* Effect.fail(new ToolFailure({ message: resolved.reason }))
                const limits = yield* sessions.limits()
                const recoveryEnabled = workflow.configKey === "review" && (yield* sessions.reviewRecovery())
                // Only reviewers proven persisted in Settings extend the model
                // policy. Requested and injected reviewers are model input:
                // their models must resolve inside the configured agent,
                // session, or Settings reviewer models, or the reviewer child
                // fails closed before its session is created.
                const reviewerModels = ModelPolicy.refs(resolved.configuredReviewers)
                const prior = yield* Effect.exit(sessions.messages(context.sessionID))
                // Keep readable legacy claims; recovery never dispatches collector HTTP.
                const claimsReadable = Exit.isSuccess(prior)
                const savedClaims = (claimsReadable ? prior.value : []).flatMap((message) => message.type === "assistant" ? message.content : [])
                  .filter((part): part is SessionMessage.AssistantTool => part.type === "tool" && part.id === context.toolCallID && part.name === fanoutName)
                  .flatMap((part) => part.state.status === "pending" ? [] : [
                    ...(Array.isArray(part.state.structured.reviewers) ? part.state.structured.reviewers : []),
                    ...(Array.isArray(part.state.structured.results) ? part.state.structured.results : []),
                  ])
                  .flatMap((row) => row && typeof row === "object" && typeof row.repairClaim === "string" ? [row.repairClaim] : [])
                // Historical claims remain diagnostic data only.
                const reviewers = resolved.reviewers.map((reviewer, index) => ({
                  reviewer,
                  state: "queued" as "queued" | "starting" | "running" | "completed" | "partial" | "error",
                  sessionID: undefined as string | undefined,
                  text: undefined as string | undefined,
                  result: undefined as unknown,
                  recovery: undefined as unknown,
                  repairClaim: savedClaims.includes(repairClaim(`${context.sessionID}:${context.toolCallID}`, index, workflow.id))
                    ? repairClaim(`${context.sessionID}:${context.toolCallID}`, index, workflow.id) : undefined as string | undefined,
                }))
                const progressLock = Semaphore.makeUnsafe(1)
                const report = () =>
                  progressLock.withPermit(
                    Effect.suspend(
                      () =>
                        context.progress?.({
                          structured: {
                            workflow: workflow.id,
                             reviewers: reviewers.map(({ result, recovery, ...reviewer }) => ({ ...reviewer, ...(recovery === undefined ? {} : { recovery: recoveryPreview(recovery) }) })),
                             partial_results: reviewers.flatMap((row) =>
                               (row.state === "completed" && row.result !== undefined) || row.state === "partial"
                                   ? [{ reviewer: row.reviewer, sessionID: row.sessionID, status: row.state === "partial" ? "partial" : "success", ...(row.result === undefined ? {} : { result: row.result }), ...(row.recovery === undefined ? {} : { recovery: recoveryReceipt(row.recovery as Parameters<typeof recoveryReceipt>[0]) }) }]
                                 : [],
                             ),
                          },
                          content: [],
                        }) ?? Effect.void,
                    ),
                  )
                yield* report()
                const results = yield* Effect.forEach(
                  resolved.reviewers,
                  (reviewer, index) => {
                    const childContext: Tool.Context = {
                      ...context,
                      toolCallID: `${context.toolCallID}-reviewer-${index + 1}`,
                      allowedModels: reviewerModels,
                      // Never inherit the parent publisher as a child call publisher.
                      progress: (snapshot) =>
                        Effect.gen(function* () {
                          const row = reviewers[index]
                          if (!row) return
                          if (typeof snapshot.structured.sessionID === "string")
                            row.sessionID = snapshot.structured.sessionID
                          if (snapshot.structured.state === "starting" || snapshot.structured.state === "running")
                            row.state = snapshot.structured.state
                          yield* report()
                        }),
                    }
                    fanoutBoundaries.set(childContext, { messageID: context.assistantMessageID, callID: context.toolCallID })
                    const reviewerSessionID = taskSessionID(childContext)
                    return Effect.forkChild(
                      Tool.settle(
                        task,
                        {
                          type: "tool-call",
                          id: childContext.toolCallID,
                          name,
                          input: {
                            description: `Reviewer ${index + 1}: ${reviewer.model}`,
                            prompt: input.prompt,
                            topics: input.topics,
                            workspace: "readonly",
                            context: input.context,
                            subagent_type: workflow.agentID,
                            model: reviewer.model,
                            ...(reviewer.variant === undefined ? {} : { variant: reviewer.variant }),
                            ...(input.tool_budget === undefined ? {} : { tool_budget: input.tool_budget }),
                            workflow: workflow.id,
                            result_schema: workflow.resultSchema,
                          },
                        },
                        childContext,
                      ).pipe(
                        Effect.flatMap((output) =>
                          Schema.decodeUnknownEffect(Output)(output.structured).pipe(
                            Effect.mapError((error) => new ToolFailure({ message: error.message })),
                          ),
                        ),
                      ),
                    ).pipe(
                      Effect.flatMap((fiber) => waitForReviewer(reviewerSessionID, fiber, sessions)),
                      Effect.match({
                        onFailure: (error) =>
                          taskError(
                            reviewerSessionID,
                            `Reviewer ${index + 1}: ${reviewer.model}`,
                            formatRunError(error),
                          ),
                        onSuccess: (output) => output,
                      }),
                      Effect.flatMap((output) => Effect.gen(function* () {
                         if (workflow.configKey !== "review") return { output, recovery: undefined, result: undefined, partial: false }
                        const history = yield* sessions.messages(reviewerSessionID, taskPromptID(childContext))
                          .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<SessionMessage.Message>)))
                         return { output, ...collectReviewResult({
                           schema: workflow.resultSchema, messages: history, promptID: taskPromptID(childContext),
                           completed: output.state === "completed", text: output.text, recoveryEnabled,
                         }) }
                      })),
                      Effect.tap(({ output, recovery, result: recoveredResult, partial }) =>
                        Effect.gen(function* () {
                          const row = reviewers[index]
                          if (!row) return
                           const result = partial || output.state !== "completed" ? undefined : recoveredResult ?? workflow.decode(output.text)
                           row.state = result !== undefined ? "completed" : recovery?.findings.length ? "partial" : "error"
                           row.recovery = recovery
                           // Keep a model-usable receipt separate from the shortened UI preview.
                           // Oversized results remain available in the child history, not as a falsely complete receipt.
                           if (result !== undefined && JSON.stringify(result).length <= 32_000) row.result = result
                          // Session links originate from the creation callback, not the deterministic pre-spawn ID.
                           const text = reviewerText(output.text, result ?? (recovery?.findings.length ? { findings: recovery.findings } : undefined))
                          const limit = Math.max(1, Math.floor(16000 / reviewers.length))
                           const preview = bytePreview(text, limit)
                          row.text =
                            text.length > limit
                              ? `${preview}\n[Preview shortened; open the agent session for the full result]`
                              : preview
                          yield* report()
                        }),
                      ),
                      Effect.map(({ output, recovery, result: recoveredResult, partial }) => {
                        const result = partial || output.state !== "completed" ? undefined : recoveredResult ?? workflow.decode(output.text)
                        return {
                          reviewer,
                          ...(reviewers[index]?.sessionID ? { sessionID: reviewers[index].sessionID } : {}),
                          status:
                             result !== undefined
                               ? ("success" as const)
                               : recovery?.findings.length ? ("partial" as const)
                              : output.text.startsWith(SPAWN_NO_OUTPUT_PREFIX)
                                ? ("spawn_no_output" as const)
                                : ("error" as const),
                           task: output,
                            ...(result === undefined || Buffer.byteLength(JSON.stringify(result)) > 32_000 ? {} : { result }),
                            ...(reviewers[index]?.repairClaim ? { repairClaim: reviewers[index].repairClaim } : {}),
                            ...(recovery === undefined ? {} : { recovery: recoveryReceipt(recovery) }),
                        }
                      }),
                    )
                  },
                  { concurrency: limits.maxThreads === UNLIMITED ? "unbounded" : limits.maxThreads },
                ).pipe(
                  Effect.onInterrupt(() =>
                    Effect.gen(function* () {
                      for (const row of reviewers) {
                        if (row.state === "completed" || row.state === "partial" || row.state === "error") continue
                        row.state = "error"
                        row.text = "Reviewer interrupted"
                      }
                      yield* report()
                    }),
                  ),
                )
                return {
                  workflow: workflow.id,
                  source: resolved.source,
                  configured_path: resolved.configuredPath,
                  changed_from_injected: resolved.changedFromInjected,
                  results,
                }
              }),
          }),
          task_result: Tool.make({
            description:
              "Return the current durable status and available result of one background task without waiting or sending more input. Use this after parent interruption or when a prior collection result is missing; do not resume through task just to inspect status.",
            input: TaskResultInput,
            output: TaskStatus,
            toModelOutput: ({ output }) => [{ type: "text", text: renderTaskStatus(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const taskID = yield* parseTaskID(input.task_id)
                const info = yield* ownedTask(jobs, taskID, context.sessionID)
                return deliverTaskStatus(info, delivered)
              }),
          }),
          task_wait: Tool.make({
            description:
              "Canonical batch collector for one or more background tasks. Waits once and returns statuses plus available terminal results in input order. Omit timeout_ms to wait without a local ceiling. A timeout only ends this wait; it does not indicate inactivity, fail, or cancel a task. Use updated_at and heartbeat_at before deciding whether running work is stale.",
            input: TaskWaitInput,
            output: TaskWaitOutput,
            toModelOutput: ({ output }) => [
              {
                type: "text",
                text: `${output.tasks.map(renderTaskStatus).join("\n\n")}\n\ntimed_out: ${output.timed_out}${
                  output.timed_out
                    ? "\nThe wait timeout elapsed while the task was still running. Do not treat this timeout as inactivity; compare updated_at or heartbeat_at and use task_result before cancelling."
                    : ""
                }`,
              },
            ],
            execute: (input, context) =>
              Effect.gen(function* () {
                if (input.task_ids.length === 0)
                  return yield* Effect.fail(new ToolFailure({ message: "task_ids must not be empty" }))
                const taskIDs = yield* Effect.forEach(input.task_ids, parseTaskID)
                yield* Effect.forEach(taskIDs, (taskID) => ownedTask(jobs, taskID, context.sessionID), {
                  discard: true,
                })
                const timeout = input.timeout_ms
                const results = yield* Effect.forEach(taskIDs, (taskID) => jobs.wait(taskID, timeout), {
                  concurrency: "unbounded",
                })
                return {
                  tasks: results.flatMap((result) => (result.info ? [deliverTaskStatus(result.info, delivered)] : [])),
                  timed_out: results.some((result) => result.timedOut),
                }
              }),
          }),
          task_cancel: Tool.make({
            description:
              "Cancel an existing background task without interrupting its parent Session. A prior task_wait timeout is not evidence of inactivity; compare updated_at or heartbeat_at first.",
            input: TaskResultInput,
            output: TaskStatus,
            toModelOutput: ({ output }) => [{ type: "text", text: renderTaskStatus(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const taskID = yield* parseTaskID(input.task_id)
                yield* ownedTask(jobs, taskID, context.sessionID)
                const info = yield* jobs.cancel(taskID)
                if (!info) return yield* Effect.fail(new ToolFailure({ message: `Task not found: ${taskID}` }))
                return taskStatus(info)
              }),
          }),
        })
        .pipe(Effect.orDie)
    }),
  )

/** Session adapter with an explicit job owner, also used by real-layer fixtures. */
export const sessionLayer = layerWith(
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const messages = (sessionID: SessionSchema.ID) => sessions.messages({ sessionID, order: "asc" })
    return {
      create: sessions.create,
      get: sessions.get,
      find: (sessionID) =>
        sessions.get(sessionID).pipe(
          Effect.match({
            onFailure: () => undefined,
            onSuccess: (session) => session,
          }),
        ),
      prompt: sessions.prompt,
      run: sessions.resume,
      interrupt: sessions.interrupt,
      messages,
      limits: () => Effect.succeed({ maxThreads: 4, maxDepth: 2 }),
      reviewers: (input) => Effect.succeed(ConfigMultiAgent.resolveReviewers(input)),
      reviewRecovery: () => Effect.succeed(true),
    }
  }),
)

export const layer = sessionLayer.pipe(Layer.provide(TaskJob.memory))

export const locationLayer = layerWith(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const store = yield* SessionStore.Service
    const content = yield* ContentStore.Service
    const execution = yield* SessionExecution.Service
    const config = yield* Config.Service
    const agents = yield* AgentV2.Service
    const permission = yield* PermissionV2.Service
    const registry = yield* ToolRegistry.Service
    const checkouts = yield* WorkspaceCheckout.Service.pipe(Effect.provide(WorkspaceCheckout.layer))
    const questions = Option.getOrUndefined(yield* Effect.serviceOption(QuestionV2.Service))
    const get = Effect.fn("TaskTool.location.get")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID })
      return session
    })
    const messages = (sessionID: SessionSchema.ID, promptID?: SessionMessage.ID) => get(sessionID).pipe(
      Effect.andThen(promptID ? SessionHistory.loadForTask(db, sessionID, promptID) : store.context(sessionID)),
    )
    const admission = {
      db, events, store, content, agents, permission, registry, checkouts,
      // NEW mirrors live beside the canonical checkout on its own volume. Existing
      // mirrors never consult this resolver; their saved descriptor wins. When no
      // default is usable, the host's question service offers one explicit folder.
      mirrorRoot: MirrorRoot.defaultRoot,
      ...(questions ? { mirrorRootChoice: mirrorRootChoice(questions) } : {}),
      delegationLayers: () => Effect.gen(function* () {
        const entries = yield* config.entries({ refresh: true })
        if (config.issues && (yield* config.issues()).length)
          return yield* new DelegationPreferences.Invalid({ reason: "state" })
        return DelegationPreferences.documentLayers(entries)
      }),
      workflowModels: (skillKey: string) => resolveConfiguredReviewers(config, { skillKey }).pipe(
        Effect.map((resolved) => resolved.ok ? ModelPolicy.refs(resolved.configuredReviewers) : []),
      ),
    }
    return {
      start: (input) => TaskAdmission.admit(admission, input),
      followup: (input) => TaskAdmission.followup(admission, input),
      create: (input) => createSession({ db, events, projects, store }, input),
      get,
      find: store.get,
      prompt: (input) => admitPrompt({ db, events, store, content }, input),
      // Step failures can still recover. Only the managed drain owns completion
      // and cancellation; observing a failed step must never interrupt its retry.
      run: (_sessionID, admitted) => runAdmitted(execution, admitted),
      interrupt: execution.interrupt,
      messages,
      limits: () =>
        config.entries().pipe(
          Effect.map((entries) => {
            const settings = Config.latest(entries, "multi_agent")
            return {
              maxThreads: settings?.unlimited ? UNLIMITED : (settings?.max_threads ?? 4),
              maxDepth: settings?.unlimited ? UNLIMITED : (settings?.max_depth ?? 2),
            }
          }),
        ),
      reviewers: (input) => resolveConfiguredReviewers(config, input),
      reviewRecovery: () => config.entries({ refresh: true }).pipe(Effect.map((entries) => {
        return reviewRecoveryEnabled(Config.latest(entries, "multi_agent"))
      })),
    }
  }),
)

/** The single explicit folder choice for one exact task start, asked through the
 * native blocking question UI (a `folder_picker` form field: a folder path, never an
 * upload). The question row is keyed to the parent's tool call, so an exact retry
 * reuses that receipt and a drifted start is refused by the question service.
 * Dismissal resolves to undefined: no start. */
export const mirrorRootChoice = (questions: QuestionV2.Interface): NonNullable<TaskAdmission.Dependencies["mirrorRootChoice"]> => (input) =>
  questions.ask({
    sessionID: input.sessionID,
    questions: [MirrorRoot.choiceQuestion(input)],
    tool: { messageID: input.boundary.assistantMessageID, callID: input.boundary.toolCallID },
  }).pipe(Effect.catchTag("QuestionV2.RejectedError", () => Effect.succeed(undefined)))

function taskPrompt(input: typeof Input.Type, workflow?: FanoutWorkflow.Definition) {
  const schema = input.result_schema ?? workflow?.resultSchema
  return new Prompt({
    text: input.prompt,
    ...(schema === undefined
      ? {}
      : {
          format: {
            type: "json_schema",
            schema,
            retryCount: 1,
          } as const,
        }),
  })
}

function taskMetadata(parent: SessionSchema.Info, input: typeof Input.Type) {
  // Tool budgets are strictly opt-in. There is no implicit reviewer budget: a
  // review child without an explicit tool_budget runs unlimited, and an
  // explicit budget is honored exactly instead of being capped. Loop and
  // runaway protection stays with explicit timeout/manual cancellation, not here.
  const budget = input.tool_budget
  if (parent.metadata?.access_control === undefined && budget === undefined) return
  return {
    ...(parent.metadata?.access_control === undefined ? {} : { access_control: parent.metadata.access_control }),
    ...(budget === undefined ? {} : { tool_budget: budget }),
  }
}

function parseTaskID(input: string) {
  if (Schema.is(SessionSchema.ID)(input)) return Effect.succeed(input)
  return Effect.fail(new ToolFailure({ message: `Invalid task_id: ${input}` }))
}

function taskSessionID(context: { sessionID: SessionSchema.ID; assistantMessageID: string; toolCallID: string }) {
  return SessionSchema.ID.make(`ses_task_${taskCorrelation(context)}`)
}

function taskPromptID(context: { sessionID: SessionSchema.ID; assistantMessageID: string; toolCallID: string }) {
  return SessionMessage.ID.make(`msg_task_${taskCorrelation(context)}`)
}

function taskCorrelation(context: { sessionID: SessionSchema.ID; assistantMessageID: string; toolCallID: string }) {
  return createHash("sha256")
    .update(`${context.sessionID}\0${context.assistantMessageID}\0${context.toolCallID}`)
    .digest("hex")
    .slice(0, 32)
}

function validateTaskSession(
  session: SessionSchema.Info,
  parentID: SessionSchema.ID,
  parent: SessionSchema.Info,
  agent: AgentV2.Info,
) {
  if (session.parentID !== parentID)
    return Effect.fail(new ToolFailure({ message: `Task ${session.id} does not belong to session ${parentID}` }))
  const mirror = session.agentPolicy?.mirrorWorkspace
  const privatePlacement = mirror?.taskID === session.id && mirror.directory === session.location.directory &&
    mirror.sourcePlacement.directory === parent.location.directory && session.agentPolicy?.source.sessionID === parentID &&
    mirror.basis.sourceSessionID === parentID && WorkspaceBasis.digest(mirror.basis) === mirror.basisDigest &&
    session.agentPolicy?.executionPlacement?.directory === mirror.directory &&
    session.agentPolicy.executionPlacement.checkout !== mirror.sourcePlacement.checkout
  if (!privatePlacement && (session.location.directory !== parent.location.directory ||
    session.location.workspaceID !== parent.location.workspaceID))
    return Effect.fail(new ToolFailure({ message: `Task ${session.id} is not in this session location` }))
  if (session.agent !== agent.id)
    return Effect.fail(
      new ToolFailure({
        message: `Task ${session.id} belongs to agent ${session.agent ?? "unknown"}, not ${agent.id}`,
      }),
    )
  if (!session.agentPolicy)
    return Effect.fail(
      new ToolFailure({
        message: `Task ${session.id} predates session-scoped agent permissions. Start a new task instead of resuming it.`,
      }),
    )
  return Effect.succeed(session)
}

function taskPlacement(
  session: SessionSchema.Info,
  sessions: TaskSessionOps,
  seen: ReadonlySet<SessionSchema.ID> = new Set(),
): Effect.Effect<{ rootSessionID: SessionSchema.ID; depth: number }, ToolFailure> {
  if (!session.parentID) return Effect.succeed({ rootSessionID: session.id, depth: 1 })
  if (seen.has(session.id))
    return Effect.fail(new ToolFailure({ message: `Invalid task parent chain at session ${session.id}` }))
  return sessions.get(session.parentID).pipe(
    Effect.mapError(() => new ToolFailure({ message: `Unable to resolve task parent ${session.parentID}` })),
    Effect.flatMap((parent) => taskPlacement(parent, sessions, new Set(seen).add(session.id))),
    Effect.map((placement) => ({ ...placement, depth: placement.depth + 1 })),
  )
}

function readTaskText(
  sessions: TaskSessionOps,
  sessionID: SessionSchema.ID,
  admitted: SessionInput.Admitted,
  requireStructured: boolean,
  decodeResult: ((text: string) => unknown) | undefined,
) {
  return Effect.suspend(() =>
    sessions.messages(sessionID, admitted.id).pipe(
      Effect.mapError(() => new ToolFailure({ message: `Unable to read task session: ${sessionID}` })),
      Effect.flatMap((messages) => {
        const promptIndex = messages.findIndex((message) => message.id === admitted.id)
        if (promptIndex < 0)
          return Effect.fail(
            new ToolFailure({
              message: requireStructured
                ? `${SPAWN_NO_OUTPUT_PREFIX} the admitted prompt was not projected into child history`
                : "Task never_settled: the admitted prompt was not projected into child history. Do not retry this task unchanged.",
            }),
          )
        const candidates = messages.slice(promptIndex + 1)
        const nextUserIndex = candidates.findIndex((message) => message.type === "user")
        const window = nextUserIndex === -1 ? candidates : candidates.slice(0, nextUserIndex)
        const assistants = window.filter((message): message is SessionMessage.Assistant => message.type === "assistant")
        const assistant = assistants.at(-1)
        if (assistant?.error) return Effect.fail(new ToolFailure({ message: formatAssistantError(assistant.error) }))
        if (requireStructured) {
          if (!assistant)
            return Effect.fail(
              new ToolFailure({
                message: `${SPAWN_NO_OUTPUT_PREFIX} the child became terminal without an assistant response`,
              }),
            )
          if (assistant?.structured !== undefined && decodeResult?.(JSON.stringify(assistant.structured)) !== undefined)
            return Effect.succeed(JSON.stringify(assistant.structured))
          const text = assistant?.content
            .filter((part) => part.type === "text")
            .map((part) => part.text.trim())
            .filter(Boolean)
            .join("\n")
          const result = text ? decodeResult?.(text) : undefined
          if (result !== undefined) return Effect.succeed(JSON.stringify(result))
          return Effect.fail(
            new ToolFailure({
              message:
                "Task incomplete_result: the child did not return the required structured result. Preambles, markdown fences, and prose are not accepted.",
            }),
          )
        }
        const text = (assistant?.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text.trim())
          .filter(Boolean)
          .join("\n")
        if (!text?.trim()) {
          const phantom = classifyPhantom(window)
          return Effect.fail(
            new ToolFailure({
              message: `Task ${phantom}: no usable assistant response produced${
                phantom === "never_settled" ? " (the child never reached a provider turn)" : ""
              }. Do not retry this task unchanged.`,
            }),
          )
        }
        return Effect.succeed(text)
      }),
    ),
  )
}

function ownedTask(jobs: TaskJob.Interface, taskID: SessionSchema.ID, parentSessionID: SessionSchema.ID) {
  return jobs.get(taskID).pipe(
    Effect.flatMap((info) => {
      if (!info) return Effect.fail(new ToolFailure({ message: `Task not found: ${taskID}` }))
      if (info.parentSessionID !== parentSessionID)
        return Effect.fail(new ToolFailure({ message: `Task ${taskID} does not belong to session ${parentSessionID}` }))
      return Effect.succeed(info)
    }),
  )
}

// Reviewers have no fixed runtime ceiling: while the child fiber is still
// pending, re-check it on a fixed cadence and keep waiting. Only the child's
// own provider-stream guard, a genuine failure, cancellation, or a verified
// identical-action loop (see reviewer-loop-policy) may end it. Suspicion is at
// most a warning unless a host-attested override granted the suspicion stop.
function waitForReviewer(
  childID: SessionSchema.ID,
  fiber: Fiber.Fiber<Output, ToolFailure>,
  sessions: TaskSessionOps,
): Effect.Effect<Output, ToolFailure> {
  return Effect.gen(function* () {
    const pending = yield* Fiber.join(fiber).pipe(Effect.timeoutOption(REVIEWER_STATUS_POLL_MS))
    if (Option.isNone(pending)) {
      const messages = yield* Effect.orElseSucceed(sessions.messages(childID), () => [])
      const repeats = observeReviewerRepeats(messages)
      if (repeats >= 2) {
        // No attested host grant exists for the suspicion stop yet; when one is
        // added it must bind session, parent call and child run before this
        // lookup may replace the fail-safe "verified-loop" mode.
        const decision = ReviewerLoopPolicy.decide("verified-loop", {
          repeats,
          // Projected history cannot prove full externalized output, the child's
          // source stamp, or a delivered correction hint yet; those gates stay
          // closed, so only the warn path is reachable from this observation.
          fullOutputEqual: false,
          sourceStampEqual: false,
          correctionHintDelivered: false,
        })
        if (decision.action === "abort-child") {
          yield* Effect.logWarning("stopping looping reviewer child", { reviewerSessionID: childID, reason: decision.reason })
          yield* sessions.interrupt(childID).pipe(Effect.ignore)
        } else if (decision.action === "warn") {
          yield* Effect.logWarning("reviewer shows repeated identical actions; continuing to observe", {
            reviewerSessionID: childID,
            reason: decision.reason,
          })
        }
      }
      return yield* waitForReviewer(childID, fiber, sessions)
    }
    return pending.value
  })
}

// Count consecutive identical completed tool actions at the tail of the child's
// projected history. Signature and full-output hash must both match; a hash of
// incomplete content can still only warn.
function observeReviewerRepeats(messages: ReadonlyArray<SessionMessage.Message>): number {
  const assistant = messages.filter((message): message is SessionMessage.Assistant => message.type === "assistant").at(-1)
  const calls = (assistant?.content ?? []).filter(
    (part): part is SessionMessage.AssistantTool => part.type === "tool" && part.state.status === "completed",
  )
  if (calls.length === 0) return 0
  const hash = (call: SessionMessage.AssistantTool) =>
    createHash("sha256")
      .update(JSON.stringify(call.state.status === "completed" ? call.state.content : []))
      .digest("hex")
  const signature = (call: SessionMessage.AssistantTool) =>
    `${call.name}:${JSON.stringify(call.state.status === "completed" ? call.state.input : "")}`
  let repeats = 1
  for (let index = calls.length - 2; index >= 0; index--) {
    if (signature(calls[index]) !== signature(calls[index + 1]) || hash(calls[index]) !== hash(calls[index + 1])) break
    repeats++
  }
  return repeats
}

function deliverTaskStatus(info: TaskJob.Info, delivered: Set<SessionSchema.ID>) {
  if (info.status === "running") return taskStatus(info)
  const delivery = delivered.has(info.taskID) ? "already_delivered" : "new"
  delivered.add(info.taskID)
  return taskStatus(info, delivery)
}

function taskStatus(info: TaskJob.Info, delivery?: "new" | "already_delivered"): TaskStatus {
  return {
    task_id: info.taskID,
    parent_session_id: info.parentSessionID,
    state: info.status,
    title: info.title,
    background: true,
    started_at: info.timeCreated,
    updated_at: info.timeUpdated,
    ...(info.heartbeatAt === undefined ? {} : { heartbeat_at: info.heartbeatAt }),
    ...(info.timeCompleted === undefined ? {} : { completed_at: info.timeCompleted }),
    ...(info.output === undefined ? {} : { result: info.output }),
    ...(info.error === undefined ? {} : { error: info.error }),
    ...(delivery === undefined ? {} : { delivery }),
    // Terminal failure is not evidence that follow-up admission is safe.
    next_action: info.status === "running" ? "wait" : "none",
  }
}

function renderTaskStatus(status: {
  readonly task_id: string
  readonly parent_session_id: string
  readonly state: "running" | "completed" | "error" | "cancelled"
  readonly title: string
  readonly background: true
  readonly started_at: number
  readonly updated_at: number
  readonly heartbeat_at?: number
  readonly completed_at?: number
  readonly result?: string
  readonly error?: string
  readonly delivery?: "new" | "already_delivered"
  readonly next_action: "wait" | "resume" | "none"
}) {
  return [
    `<task id="${status.task_id}" state="${status.state}" background="true">`,
    `<summary>${status.title}</summary>`,
    `<next_action>${status.next_action}</next_action>`,
    ...(status.delivery ? [`<delivery>${status.delivery}</delivery>`] : []),
    `<progress started_at="${status.started_at}" updated_at="${status.updated_at}"${
      status.heartbeat_at === undefined ? "" : ` heartbeat_at="${status.heartbeat_at}"`
    } />`,
    ...(status.result ? ["<task_result>", status.result, "</task_result>"] : []),
    ...(status.error ? ["<task_error>", status.error, "</task_error>"] : []),
    "</task>",
  ].join("\n")
}

function taskError(sessionID: SessionSchema.ID, description: string, text: string): Output {
  return {
    sessionID,
    task_id: sessionID,
    state: "error",
    summary: `Task failed: ${description}`,
    text: text || "Task failed without an error message",
    next_action: "none",
  }
}

function repairClaim(callID: string, index: number, workflow: string) {
  return createHash("sha256").update(`${callID}\0${index}\0${workflow}`).digest("hex")
}

function bytePreview(value: string, limit: number) {
  const bytes = Buffer.from(value)
  if (bytes.length <= limit) return value
  return `${bytes.subarray(0, Math.max(0, limit - 120)).toString("utf8").replace(/[\uD800-\uDBFF]$/, "")}\n[Preview shortened; open the reviewer session for original evidence]`
}

function recoveryReceipt(value: { source: "original" | "repaired"; findings: unknown[]; original: string; repaired?: string; issues: string[]; evidence?: ReviewEvidenceReference[]; usage?: unknown; repairStatus?: "success" | "failed" | "unavailable" }) {
  let bytes = 0
  const retainedFindingIndexes: number[] = []
  const findings = value.findings.filter((finding, index) => {
    const size = Buffer.byteLength(JSON.stringify(finding))
    if (size > 16_000 - bytes) return false
    bytes += size
    retainedFindingIndexes.push(index)
    return true
  })
  return {
    ...value,
    findings,
    ...(value.evidence === undefined ? {} : { retainedFindingIndexes }),
    ...(findings.length < value.findings.length ? { omittedFindings: value.findings.length - findings.length } : {}),
    original: bytePreview(value.original, 4_000),
    ...(value.repaired === undefined ? {} : { repaired: bytePreview(value.repaired, 4_000) }),
    issues: value.issues.slice(0, 20).map((issue) => bytePreview(issue, 200)),
  }
}

function recoveryPreview(value: unknown) {
  if (!value || typeof value !== "object" || !("original" in value)) return
  const recovery = value as { source?: string; original?: string; repaired?: string; findings?: unknown[]; issues?: string[]; repairStatus?: string }
  const findings = (recovery.findings ?? []).slice(0, 20)
    .filter((finding) => Buffer.byteLength(JSON.stringify(finding)) < 1_000)
  return {
    source: recovery.source,
    findings,
    original: bytePreview(recovery.original ?? "", 2_000),
    ...(recovery.repaired === undefined ? {} : { repaired: bytePreview(recovery.repaired, 2_000) }),
    issues: (recovery.issues ?? []).slice(0, 20).map((issue) => bytePreview(issue, 200)),
    repairStatus: recovery.repairStatus,
  }
}

function unregisteredWorkflow(reference: string) {
  return `Workflow is not registered: ${reference}. Pass a registered workflow ID or command, not the tool name "${fanoutName}".`
}

const SPAWN_NO_OUTPUT_PREFIX = "Task spawn_no_output:"

// Distinguish zero-output children (Pattern 3) so the parent can decide not to retry.
// never_settled: the current admitted prompt never reached an assistant/provider turn.
// fast_error: produced an assistant message but it carried an error with no useful text.
function classifyPhantom(window: ReadonlyArray<SessionMessage.Message>): "never_settled" | "fast_error" {
  const hasAssistant = window.some((message) => message.type === "assistant")
  return hasAssistant ? "fast_error" : "never_settled"
}

function formatAssistantError(error: SessionMessage.Assistant["error"]) {
  if (!error) return "Task failed without an error message"
  return error.message
}

export function admissionFailure(error: unknown, prefix: string) {
  if (error instanceof SessionFork.CaptureConflict && error.reason === "pending")
    return new ToolFailure({
      message: "Task dispatch was not started because the parent session has new or held input (task_pending_input). " +
        "Process that input through the normal session flow first. Only then create a new task for the current request; " +
        "do not retry this rejected assignment, switch to context:fresh as a fallback, or change the input ledger manually.",
      metadata: { code: "task_pending_input", retryable: false, next_action: "process_pending_input" },
    })
  if (error instanceof TaskAdmission.Conflict && (error.stage === "mirror-root" || error.reason === "dismissed"))
    // Retrying the same call cannot help: its question receipt is bound to this start.
    return new ToolFailure({ message: `${prefix}: ${error.message}`,
      metadata: { code: error.reason === "dismissed" ? "task_mirror_root_dismissed" : "task_mirror_root_refused", retryable: false } })
  return new ToolFailure({ message: `${prefix}: ${formatRunError(error)}` })
}

function formatRunError(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}
