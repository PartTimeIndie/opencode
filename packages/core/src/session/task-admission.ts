export * as TaskAdmission from "./task-admission"

import { DateTime, Effect, Schema } from "effect"
import { and, desc, eq, gt, isNull } from "drizzle-orm"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import fs from "node:fs/promises"
import path from "node:path"
import { KeyedMutex } from "../effect/keyed-mutex"
import { Location } from "../location"
import type { QuestionV2 } from "../question"
import { AbsolutePath } from "../schema"
import { AgentMirror } from "./workspace/agent-mirror"
import { WorkspaceBasis } from "./workspace/basis"
import { MirrorRoot } from "./workspace/mirror-root"
import type { AgentV2 } from "../agent"
import type { ContentStore } from "../content-store"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import type { ToolRegistry } from "../tool/registry"
import { SessionV1 } from "../v1/session"
import type { CreateInput, PromptInput } from "../session"
import { SessionForkImport } from "./fork-import"
import { SessionAgentPolicyEvent } from "./agent-policy-event"
import type { ModelV2 } from "../model"
import { SessionFork } from "./fork"
import type { TaskContext } from "./task-context"
import { SessionInput } from "./input"
import { WorkspaceCheckout } from "./workspace/checkout"
import { SessionExecutionOwner } from "./execution/owner"
import { Prompt } from "./prompt"
import { SessionMessage } from "./message"
import { SessionMessageID } from "./message-id"
import type { SessionStore } from "./store"
import { TaskDispatchPolicy } from "./task-dispatch-policy"
import { SessionActivityTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import { SessionAgentPolicy } from "./agent-policy"
import { SessionSchema } from "./schema"

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("TaskAdmission.Conflict", {
  reason: Schema.Literals(["input", "child", "placement", "retry", "consent", "dismissed", "retry-not-due"]),
  stage: Schema.optional(Schema.Literals(["mirror", "mirror-root"])),
  retryAt: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect),
}) {
  override get message() {
    if (this.reason === "retry-not-due" && this.retryAt !== undefined)
      return `Native task admission refused (retry-not-due): provider retry is not due until ${new Date(this.retryAt).toISOString()}`
    const cause = this.cause instanceof Error ? this.cause.message.slice(0, 2000) : undefined
    return `Native task admission refused (${this.reason}${this.stage ? `/${this.stage}` : ""})${cause ? `: ${cause}` : ""}`
  }
}

export type Dependencies = {
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly store: SessionStore.Interface
  readonly content: ContentStore.Interface
  readonly agents: AgentV2.Interface
  readonly permission: PermissionV2.Interface
  readonly registry: ToolRegistry.Interface
  readonly checkouts: WorkspaceCheckout.Interface
  readonly workflowModels?: TaskDispatchPolicy.Dependencies["workflowModels"]
  readonly delegationLayers: TaskDispatchPolicy.Dependencies["delegationLayers"]
  /** Storage for NEW mirrors only: an explicit host root, or a resolver deriving the
   * default per canonical checkout. Existing children never consult it; their saved
   * descriptor stays authoritative. Never a fallback to Main. */
  readonly mirrorRoot?: string | ((checkout: string) => string | undefined)
  /** Offers exactly one explicit folder choice when no default root is usable. Returns
   * the raw answers, or undefined when the user dismissed the question: no start. */
  readonly mirrorRootChoice?: (input: MirrorRoot.Choice & {
    readonly sessionID: SessionSchema.ID
    readonly boundary: Input["boundary"]
  }) => Effect.Effect<ReadonlyArray<QuestionV2.Answer> | undefined, QuestionV2.ConflictError>
}
export type Input = {
  readonly create: CreateInput
  readonly prompt: PromptInput
  readonly parentAgent: AgentV2.ID
  readonly boundary: { readonly assistantMessageID: SessionMessage.ID; readonly toolCallID: string }
  readonly workflowTools?: readonly string[]
  readonly action?: "task" | "multi_agent_fanout"
  readonly topics?: readonly string[]
  readonly workspace?: "mirror" | "main" | "readonly"
  readonly context?: TaskContext.Mode
  readonly untrackedPaths?: readonly string[]
  readonly modelSelection?: { readonly requested?: string; readonly variant?: string; readonly workflow?: string }
}

/** Production task creation, history import and first prompt share one event
 * transaction. Wake/run remain the existing SessionExecution caller's job. */
const admissions = KeyedMutex.makeUnsafe<string>()

export function admit(dependencies: Dependencies, request: Input) {
  const input = structuredClone(request)
  return admissions.withLock(input.create.id ?? "invalid")(admitLocked(dependencies, input))
}

const admitLocked = Effect.fn("TaskAdmission.admit")(function* (dependencies: Dependencies, request: Input) {
  // Freeze host identifiers and prompt before any awaited preparation.
  const input = structuredClone(request)
  const workspace = input.workspace ?? "mirror"
  const context = input.context ?? "fork"
  const readOnly = workspace === "readonly"
  if ((input.untrackedPaths?.length ?? 0) > 256 || (workspace !== "mirror" && input.untrackedPaths?.length))
    return yield* new Conflict({ reason: "input" })
  const { db, events, store } = dependencies
  const childID = input.create.id
  const parentID = input.create.parentID
  const promptID = input.prompt.id
  if (!childID || !parentID || !input.create.agent || !promptID || input.prompt.sessionID !== childID)
    return yield* new Conflict({ reason: "input" })
  const parent = yield* store.get(parentID)
  if (!parent || parent.time.archived || parent.revert ||
    parent.location.directory !== input.create.location.directory ||
    parent.location.workspaceID !== input.create.location.workspaceID) return yield* new Conflict({ reason: "placement" })
  const owner = yield* SessionExecutionOwner.assertOwner(db, parentID)
  const checkout = yield* dependencies.checkouts.resolve(parent.location.directory)
  const placement = yield* WorkspaceCheckout.pinPlacement(parent.location.directory, checkout)
  const sourcePlacement = yield* WorkspaceCheckout.executionPlacement(placement)
  const prompt = new Prompt({ ...input.prompt.prompt,
    ...(input.prompt.agent === undefined ? {} : { agent: input.prompt.agent }),
    ...(input.prompt.model === undefined ? {} : { model: input.prompt.model }),
  })
  const policyDependencies = { agents: dependencies.agents, permission: dependencies.permission, registry: dependencies.registry,
    workflowModels: dependencies.workflowModels, delegationLayers: dependencies.delegationLayers, store }
  const policy = yield* TaskDispatchPolicy.capture(policyDependencies, {
    parentID, parentAgent: input.parentAgent, childID, childAgent: input.create.agent, topics: input.topics, workflowTools: input.workflowTools, action: input.action,
    modelSelection: { ...input.modelSelection, selected: input.create.model },
  })
  const source = yield* SessionFork.capture(db, {
    sessionID: parentID, throughSeq: yield* SessionInput.latestSeq(db, parentID), dispatch: input.boundary,
    context,
  })
  const sourceFence = yield* SessionForkImport.dispatchFence(db, {
    sourceSessionID: parentID, throughSeq: source.throughSeq, dispatch: input.boundary,
  })
  const requestDigest = createHash("sha256").update(JSON.stringify({
    version: 2, owner, policy: TaskDispatchPolicy.digest(policy), sourceFence, source: { ...source, throughSeq: undefined },
    parentID, childID, boundary: input.boundary, promptID: input.prompt.id,
    prompt: Schema.encodeSync(Prompt)(prompt), agent: input.create.agent,
    model: input.create.model, title: input.create.title, metadata: input.create.metadata,
    checkout, sourcePlacement, workspace, context, untrackedPaths: input.untrackedPaths ?? [], workflowTools: input.workflowTools, action: input.action ?? "task",
  })).digest("hex")
  const prepared = yield* SessionForkImport.prepare(db, dependencies.content, {
    sourceSessionID: parentID, childSessionID: childID,
    throughSeq: yield* SessionInput.latestSeq(db, parentID), dispatch: input.boundary,
    context,
  })
  const history = yield* SessionForkImport.bindDispatch(db, prepared, requestDigest)
  const binding = history.dispatchDigest
  // A NEW mirror needs a host-owned root on the checkout's own volume. When no
  // default is usable, exactly one explicit folder choice may supply it; a
  // dismissed or invalid choice refuses this start. Never Main, never the old
  // Global-data root on another drive.
  const prepareRoot = (checkoutPath: string, candidate: string | undefined) =>
    Effect.tryPromise({
      try: async () => {
        if (candidate === undefined)
          throw new MirrorRoot.Refused("absent", `no default mirror folder is available for ${checkoutPath}: the checkout sits directly at a volume root or the host supplied no storage root`)
        return MirrorRoot.prepare({ checkout: checkoutPath, root: candidate })
      },
      catch: (cause) => new Conflict({ reason: "placement", stage: "mirror-root", cause }),
    })
  const resolveMirrorRoot = Effect.gen(function* () {
    // The host resolver and the folder question see the physical checkout path.
    const canonical = yield* Effect.tryPromise({
      try: () => fs.realpath(checkout),
      catch: (cause) => new Conflict({ reason: "placement", stage: "mirror-root", cause }),
    })
    const requested = typeof dependencies.mirrorRoot === "function" ? dependencies.mirrorRoot(canonical) : dependencies.mirrorRoot
    const prepared = yield* prepareRoot(canonical, requested).pipe(
      Effect.map((root) => ({ root })),
      Effect.catch((refused) => Effect.succeed({ refused })),
    )
    if ("root" in prepared) return prepared.root
    const choice = dependencies.mirrorRootChoice
    if (!choice) return yield* prepared.refused
    const start = { childID, checkout: canonical, dispatchDigest: binding, refused: prepared.refused.message }
    const answers = yield* choice({ ...start, sessionID: parentID, boundary: input.boundary }).pipe(
      Effect.mapError((cause) => new Conflict({ reason: "placement", stage: "mirror-root", cause })),
    )
    if (answers === undefined)
      return yield* new Conflict({ reason: "dismissed", cause: new Error("The user dismissed the mirror folder choice; no task was started") })
    const chosen = yield* Effect.try({
      try: () => MirrorRoot.chosenPath(answers, start),
      catch: (cause) => new Conflict({ reason: "placement", stage: "mirror-root", cause }),
    })
    // The chosen folder is re-validated with the same rules right before use.
    return yield* prepareRoot(canonical, chosen)
  })
  const existing = yield* store.get(childID)
  const mirrored = workspace === "mirror"
  const mirrorWorkspace = mirrored ? yield* Effect.gen(function* () {
    if (existing) {
      const saved = existing.agentPolicy?.mirrorWorkspace
      if (!saved || saved.taskID !== childID || saved.inputID !== promptID || saved.dispatchDigest !== binding ||
        !isDeepStrictEqual(saved.sourcePlacement, sourcePlacement) || WorkspaceBasis.digest(saved.basis) !== saved.basisDigest)
        return yield* new Conflict({ reason: "retry" })
      return saved
    }
    const mirrorRoot = yield* resolveMirrorRoot
    // Wait for private-copy preparation to settle on cancellation. Never leave
    // an unobserved clone writing after the parent activity has settled.
    const mirror = yield* Effect.tryPromise({
      try: () => AgentMirror.create({ directory: checkout, mirrorRoot,
        taskID: childID, sourceSessionID: parentID, throughSeq: source.throughSeq, untracked: input.untrackedPaths ?? [] }),
      catch: (cause) => new Conflict({ reason: "placement", stage: "mirror", cause }),
    }).pipe(Effect.uninterruptible)
    if (mirror.basis.excludedUntracked.length) return yield* new Conflict({ reason: "input" })
    const basis = yield* WorkspaceBasis.capture(dependencies.content, { sessionID: parentID, mirror })
    const relative = yield* Effect.tryPromise({
      try: async () => path.relative(await fs.realpath(checkout), await fs.realpath(parent.location.directory)),
      catch: () => new Conflict({ reason: "placement" }),
    })
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
      return yield* new Conflict({ reason: "placement" })
    return { version: 1 as const, taskID: childID, inputID: promptID, dispatchDigest: binding,
      sourcePlacement, basis: basis.manifest, basisDigest: basis.digest,
      directory: path.join(mirror.directory, relative) }
  }) : undefined
  const childLocation = mirrorWorkspace
    ? existing?.location ?? Location.Ref.make({ directory: AbsolutePath.make(mirrorWorkspace.directory) })
    : input.create.location
  const childCheckout = mirrored ? yield* dependencies.checkouts.resolve(childLocation.directory) : checkout
  const childPlacement = mirrored ? yield* WorkspaceCheckout.pinPlacement(childLocation.directory, childCheckout) : placement
  const executionPlacement = yield* WorkspaceCheckout.executionPlacement(childPlacement)
  if (mirrored && childCheckout === checkout) return yield* new Conflict({ reason: "placement" })
  // Physical traversal must remain outside the immediate write transaction.
  if ((yield* dependencies.checkouts.resolve(parent.location.directory)) !== checkout)
    return yield* new Conflict({ reason: "placement" })
  const validate = Effect.gen(function* () {
    const liveOwner = yield* SessionExecutionOwner.assertOwner(db, parentID)
    const liveParent = yield* store.get(parentID)
    if (!isDeepStrictEqual(liveOwner, owner) || !liveParent || liveParent.revert || liveParent.time.archived ||
      !isDeepStrictEqual(liveParent.location, parent.location)) return yield* new Conflict({ reason: "placement" })
    const childPolicy = yield* TaskDispatchPolicy.revalidate(policyDependencies, policy)
    const placed = { ...childPolicy, taskContext: context, executionPlacement, ...(mirrorWorkspace ? { mirrorWorkspace } : {}) }
    return readOnly ? SessionAgentPolicy.restrictReadOnly(placed, promptID) : placed
  })
  const finalOwner = Effect.gen(function* () {
    const live = yield* SessionExecutionOwner.assertOwner(db, parentID)
    if (!isDeepStrictEqual(live, owner)) return yield* new Conflict({ reason: "placement" })
    yield* WorkspaceCheckout.revalidatePlacement(placement)
    yield* WorkspaceCheckout.revalidatePlacement(childPlacement)
  })
  const validateSource = Effect.gen(function* () {
    const current = yield* SessionForkImport.revalidate(db, history)
    const liveFence = yield* SessionForkImport.dispatchFence(db, {
      sourceSessionID: parentID, throughSeq: current.throughSeq, dispatch: input.boundary,
    })
    if (liveFence !== sourceFence || !isDeepStrictEqual({ ...current, throughSeq: source.throughSeq }, source))
      return yield* new Conflict({ reason: "retry" })
  })
  // Only a technically restricted reader may use Main without a writing
  // exception. The Permission owner, not a workspace label, obtains the click.
  const savedConsent = existing?.agentPolicy?.mainWriteConsent
  if (existing && ((existing.agentPolicy?.readOnly === true) !== readOnly || (!readOnly && !mirrored &&
    (savedConsent?.dispatchDigest !== binding || savedConsent.placementIdentity !== executionPlacement.identity || savedConsent.inputID !== promptID))))
    return yield* new Conflict({ reason: "retry" })
  const mainWriteConsent = readOnly || mirrored ? undefined : savedConsent ?? (yield* Effect.gen(function* () {
    yield* validate
    yield* validateSource
    yield* finalOwner
    const authorize = dependencies.permission.assertSingleUse
    if (!authorize) return yield* new Conflict({ reason: "consent" })
    const permissionID = yield* authorize(PermissionV2.singleUse({
      id: PermissionV2.ID.create(), sessionID: parentID, agent: input.parentAgent,
      action: "task_main_write", resources: [`task:${childID}:${binding}`],
      source: { type: "tool", messageID: input.boundary.assistantMessageID, callID: input.boundary.toolCallID },
      metadata: { purpose: "Allow only this task to use the physical Main checkout instead of an isolated mirror. File, Shell, deployment and external-action permissions still apply.",
        childSessionID: childID, assignment: input.prompt.prompt.text, agent: input.create.agent,
        directory: parent.location.directory, checkout, dispatchDigest: binding, placementIdentity: executionPlacement.identity },
    }))
    yield* validate
    yield* validateSource
    yield* finalOwner
    return { version: 1 as const, permissionID, inputID: promptID, dispatchDigest: binding, placementIdentity: executionPlacement.identity }
  }))
  return yield* EventV2.atomic(db, Effect.gen(function* () {
    const childPolicy = { ...yield* validate, ...(mainWriteConsent === undefined ? {} : { mainWriteConsent }) }
    const recorded = yield* store.get(childID)
    if (recorded) {
      const receipt = yield* db.select({ digest: SessionTable.fork_dispatch_digest, through: SessionTable.fork_history_seq })
        .from(SessionTable).where(eq(SessionTable.id, childID)).get().pipe(Effect.orDie)
      const admitted = yield* SessionInput.find(db, promptID)
      if (recorded.parentID !== parentID || recorded.agent !== input.create.agent ||
        !isDeepStrictEqual(recorded.agentPolicy, childPolicy) ||
        receipt?.digest !== binding || receipt.through === null || recorded.location.directory !== childLocation.directory ||
        recorded.location.workspaceID !== childLocation.workspaceID ||
        !admitted || !SessionInput.equivalent(admitted, { sessionID: childID, prompt, delivery: "steer" }))
        return yield* new Conflict({ reason: "retry" })
      yield* validateSource
      yield* finalOwner
      return recorded
    }
    const now = Date.now()
    yield* events.publish(SessionV1.Event.Created, {
      sessionID: childID,
      info: SessionV1.SessionInfo.make({
        id: childID, parentID, projectID: parent.projectID, directory: childLocation.directory,
        workspaceID: childLocation.workspaceID,
        slug: `task-${childID}`, title: input.create.title ?? "Task", version: "task-v2",
        agent: input.create.agent, model: input.create.model,
        metadata: input.create.metadata, agentPolicy: childPolicy,
        time: { created: now, updated: now },
      }),
    }, { location: childLocation })
    yield* SessionForkImport.materialize(db, events, history)
    yield* SessionInput.admit(db, events, { id: promptID, sessionID: childID, prompt, delivery: "steer" })
    yield* validate
    yield* validateSource
    const child = yield* store.get(childID)
    if (!child) return yield* new Conflict({ reason: "child" })
    yield* finalOwner
    return child
  }))
})

export type FollowupInput = {
  readonly context?: TaskContext.Mode
  readonly childID: SessionSchema.ID
  readonly parentID: SessionSchema.ID
  readonly parentAgent: AgentV2.ID
  readonly boundary: { readonly assistantMessageID: SessionMessage.ID; readonly toolCallID: string }
  readonly prompt: PromptInput
  readonly agent: AgentV2.ID
  readonly model?: ModelV2.Ref
  readonly topics?: readonly string[]
  readonly workflowTools?: readonly string[]
  readonly action?: "task" | "multi_agent_fanout"
  readonly modelSelection?: { readonly requested?: string; readonly variant?: string; readonly workflow?: string }
}

/** Admits one follow-up scope for a terminal native task child: rebinds the
 * saved input binding to the new prompt, keeps the child's history and private
 * workspace, and requires one fresh single-use Main consent for main-writing
 * children. Never re-imports history or copies a new mirror. */
export function followup(dependencies: Dependencies, request: FollowupInput) {
  const input = structuredClone(request)
  return admissions.withLock(input.childID)(followupLocked(dependencies, input))
}

const followupLocked = Effect.fn("TaskAdmission.followup")(function* (dependencies: Dependencies, request: FollowupInput) {
  const input = structuredClone(request)
  const { db, events, store } = dependencies
  const promptID = input.prompt.id
  if (!promptID || input.prompt.sessionID !== input.childID)
    return yield* new Conflict({ reason: "input" })
  const prompt = new Prompt({ ...input.prompt.prompt,
    ...(input.prompt.agent === undefined ? {} : { agent: input.prompt.agent }),
    ...(input.prompt.model === undefined ? {} : { model: input.prompt.model }),
  })
  const parent = yield* store.get(input.parentID)
  if (!parent || parent.time.archived || parent.revert) return yield* new Conflict({ reason: "placement" })
  const child = yield* store.get(input.childID)
  if (!child || child.parentID !== input.parentID || child.agent !== input.agent || child.time.archived ||
    child.revert || child.agentPolicy?.source.type !== "task" ||
    child.agentPolicy.source.sessionID !== input.parentID || !child.agentPolicy.executionPlacement)
    return yield* new Conflict({ reason: "child" })
  const saved = child.agentPolicy
  if (input.context !== undefined && input.context !== (saved.taskContext ?? "fork"))
    return yield* new Conflict({ reason: "input" })
  const mirror = saved.mirrorWorkspace
  const consented = saved.mainWriteConsent
  const readOnly = SessionAgentPolicy.isReadOnly(saved)
  if (!readOnly && !mirror && !consented) return yield* new Conflict({ reason: "child" })
  if (mirror && (mirror.taskID !== input.childID || WorkspaceBasis.digest(mirror.basis) !== mirror.basisDigest))
    return yield* new Conflict({ reason: "child" })
  const previousInputID = readOnly ? saved.readOnlyInputID : mirror?.inputID ?? consented?.inputID
  if (previousInputID === undefined) return yield* new Conflict({ reason: "child" })
  const parentPending = yield* SessionFork.pendingInputs(db, input.parentID, true)
  const already = yield* SessionInput.find(db, promptID)
  // A new scope requires a fully terminal child: every admitted input — the
  // previous bound assignment included — is promoted, held work included, and
  // no running or recovering activity owns it. An exact retry of the already
  // admitted follow-up may observe its own input still awaiting its runner.
  const pendingInputs = Effect.gen(function* () {
    return yield* db.select({ id: SessionInputTable.id }).from(SessionInputTable)
      .where(and(eq(SessionInputTable.session_id, input.childID), isNull(SessionInputTable.promoted_seq)))
      .all().pipe(Effect.orDie)
  })
  const terminal = Effect.gen(function* () {
    const rows = yield* pendingInputs
    if (rows.length > 0) return false
    const activity = yield* db.select({ status: SessionActivityTable.status })
      .from(SessionActivityTable).where(eq(SessionActivityTable.session_id, input.childID))
      .orderBy(desc(SessionActivityTable.opened_seq)).limit(1).get().pipe(Effect.orDie)
    return activity === undefined || (activity.status !== "running" && activity.status !== "recovering")
  })
  if (already !== undefined && previousInputID === promptID) {
    if (!SessionInput.equivalent(already, { sessionID: input.childID, prompt, delivery: "steer" }))
      return yield* new Conflict({ reason: "retry" })
    if ((yield* pendingInputs).some((row) => row.id !== promptID)) return yield* new Conflict({ reason: "child" })
    return child
  }
  if (already !== undefined) return yield* new Conflict({ reason: "retry" })
  if (!(yield* terminal)) return yield* new Conflict({ reason: "child" })
  const assertRetryDue = Effect.gen(function* () {
    const previous = yield* SessionInput.find(db, SessionMessageID.ID.make(previousInputID))
    if (!previous || previous.sessionID !== input.childID || previous.promotedSeq === undefined)
      return yield* new Conflict({ reason: "child" })
    const row = yield* db.select().from(SessionMessageTable).where(and(
      eq(SessionMessageTable.session_id, input.childID), eq(SessionMessageTable.type, "assistant"),
      gt(SessionMessageTable.seq, previous.promotedSeq),
    )).orderBy(desc(SessionMessageTable.seq)).limit(1).get().pipe(Effect.orDie)
    if (!row) return
    const assistant = yield* Schema.decodeUnknownEffect(SessionMessage.Assistant)({ ...row.data, id: row.id, type: row.type })
      .pipe(Effect.mapError(() => new Conflict({ reason: "child" })))
    const retryAt = assistant.failure?.resetAt
    if (assistant.failure?.cause?.detail?.startsWith("task-chain-exhausted;") && retryAt !== undefined && retryAt > Date.now())
      return yield* new Conflict({ reason: "retry-not-due", retryAt })
  })
  yield* assertRetryDue
  const owner = yield* SessionExecutionOwner.assertOwner(db, input.parentID)
  const checkout = yield* dependencies.checkouts.resolve(parent.location.directory)
  const placement = yield* WorkspaceCheckout.pinPlacement(parent.location.directory, checkout)
  const childCheckout = yield* dependencies.checkouts.resolve(child.location.directory)
  const childPlacement = yield* WorkspaceCheckout.pinPlacement(child.location.directory, childCheckout)
  const executionPlacement = yield* WorkspaceCheckout.executionPlacement(childPlacement)
  if (!isDeepStrictEqual(executionPlacement, saved.executionPlacement))
    return yield* new Conflict({ reason: "placement" })
  const policyDependencies = { agents: dependencies.agents, permission: dependencies.permission, registry: dependencies.registry,
    workflowModels: dependencies.workflowModels, delegationLayers: dependencies.delegationLayers, store }
  const policy = yield* TaskDispatchPolicy.capture(policyDependencies, {
    parentID: input.parentID, parentAgent: input.parentAgent, childID: input.childID, childAgent: input.agent,
    topics: input.topics, workflowTools: input.workflowTools, action: input.action,
    modelSelection: {
      ...input.modelSelection,
      inheritChild: Boolean(child.model && input.modelSelection?.requested === undefined && input.modelSelection?.variant === undefined),
      selected: input.model ?? child.model,
    },
  })
  const sourceFence = yield* SessionForkImport.dispatchFence(db, {
    sourceSessionID: input.parentID, throughSeq: yield* SessionInput.latestSeq(db, input.parentID), dispatch: input.boundary,
  })
  const binding = createHash("sha256").update(JSON.stringify({
    version: 3, followup: true, previousInputID, owner, policy: TaskDispatchPolicy.digest(policy), sourceFence, parentPending,
    parentID: input.parentID, childID: input.childID, boundary: input.boundary, promptID,
    prompt: Schema.encodeSync(Prompt)(prompt), agent: input.agent, model: input.model,
    action: input.action ?? "task",
  })).digest("hex")
  const validate = Effect.gen(function* () {
    const liveOwner = yield* SessionExecutionOwner.assertOwner(db, input.parentID)
    if (!isDeepStrictEqual(liveOwner, owner)) return yield* new Conflict({ reason: "placement" })
    const liveParent = yield* store.get(input.parentID)
    if (!liveParent || liveParent.revert || liveParent.time.archived ||
      !isDeepStrictEqual(liveParent.location, parent.location)) return yield* new Conflict({ reason: "placement" })
    yield* WorkspaceCheckout.revalidatePlacement(placement)
    yield* WorkspaceCheckout.revalidatePlacement(childPlacement)
    const base = yield* TaskDispatchPolicy.revalidate(policyDependencies, policy)
    const pending = yield* SessionFork.pendingInputs(db, input.parentID, true)
    if (!isDeepStrictEqual(pending, parentPending)) return yield* new Conflict({ reason: "retry" })
    return base
  })
  // A main-writing follow-up needs its own single-use host consent; earlier
  // approvals never cover a new scope. Readers and mirrors need none.
  const mainWriteConsent = readOnly || mirror !== undefined ? undefined : yield* Effect.gen(function* () {
    yield* validate
    const authorize = dependencies.permission.assertSingleUse
    if (!authorize) return yield* new Conflict({ reason: "consent" })
    const permissionID = yield* authorize(PermissionV2.singleUse({
      id: PermissionV2.ID.create(), sessionID: input.parentID, agent: input.parentAgent,
      action: "task_main_write", resources: [`task:${input.childID}:followup:${promptID}`],
      source: { type: "tool", messageID: input.boundary.assistantMessageID, callID: input.boundary.toolCallID },
      metadata: { purpose: "Allow only this follow-up of the task to keep using the physical Main checkout instead of an isolated mirror. File, Shell, deployment and external-action permissions still apply.",
        childSessionID: input.childID, assignment: input.prompt.prompt.text, agent: input.agent,
        directory: parent.location.directory, checkout, dispatchDigest: binding, placementIdentity: executionPlacement.identity },
    }))
    yield* validate
    return { version: 1 as const, permissionID, inputID: promptID, dispatchDigest: binding, placementIdentity: executionPlacement.identity }
  })
  return yield* EventV2.atomic(db, Effect.gen(function* () {
    const base = yield* validate
    const recorded = yield* store.get(input.childID)
    if (!recorded || recorded.parentID !== input.parentID || recorded.agent !== input.agent) return yield* new Conflict({ reason: "child" })
    const raced = yield* SessionInput.find(db, promptID)
    const racedBound = recorded.agentPolicy
      ? SessionAgentPolicy.isReadOnly(recorded.agentPolicy)
        ? recorded.agentPolicy.readOnlyInputID : recorded.agentPolicy.mirrorWorkspace?.inputID ?? recorded.agentPolicy.mainWriteConsent?.inputID
      : undefined
    if (raced !== undefined) {
      if (racedBound !== promptID ||
        !SessionInput.equivalent(raced, { sessionID: input.childID, prompt, delivery: "steer" }))
        return yield* new Conflict({ reason: "retry" })
      return recorded
    }
    if (racedBound !== previousInputID) return yield* new Conflict({ reason: "retry" })
    yield* assertRetryDue
    const placed = { ...base, taskContext: saved.taskContext ?? "fork", executionPlacement,
      ...(mirror === undefined ? {} : { mirrorWorkspace: { ...mirror, inputID: promptID, dispatchDigest: binding } }) }
    const nextPolicy = readOnly ? SessionAgentPolicy.restrictReadOnly(placed, promptID)
      : { ...placed, ...(mainWriteConsent === undefined ? {} : { mainWriteConsent }) }
    yield* events.publish(SessionAgentPolicyEvent.AgentPolicyRebound, {
      sessionID: input.childID, previousInputID: SessionMessageID.ID.make(previousInputID),
      agentPolicy: nextPolicy, timestamp: yield* DateTime.now,
    })
    yield* SessionInput.admit(db, events, { id: promptID, sessionID: input.childID, prompt, delivery: "steer" })
    yield* validate
    const updated = yield* store.get(input.childID)
    if (!updated) return yield* new Conflict({ reason: "child" })
    return updated
  }))
})
