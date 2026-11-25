import { describe, expect } from "bun:test"
import { Cause, DateTime, Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution/owner"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { nextModel, sameChainSelection } from "@opencode-ai/core/session/runner/model-chain"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionActivityTable, SessionContextEpochTable, SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { TaskAdmission } from "@opencode-ai/core/session/task-admission"
import { TaskDispatchPolicy } from "@opencode-ai/core/session/task-dispatch-policy"
import { WorkspaceCheckout } from "@opencode-ai/core/session/workspace/checkout"
import { ModelPolicy } from "@opencode-ai/core/tool/model-policy"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)
const parentID = SessionSchema.ID.make("ses_followup_policy_parent")
const childID = SessionSchema.ID.make("ses_followup_policy_child")
const assistantMessageID = SessionMessage.ID.make("msg_followup_policy_assistant")
const promptID = SessionMessage.ID.make("msg_followup_policy_prompt")
const build = AgentV2.ID.make("build")
const worker = AgentV2.ID.make("worker")
const first = { id: ModelV2.ID.make("first"), providerID: ProviderV2.ID.make("fixture") }
const fallback = { id: ModelV2.ID.make("fallback"), providerID: ProviderV2.ID.make("fixture") }
const other = { id: ModelV2.ID.make("other"), providerID: ProviderV2.ID.make("fixture") }
const chained = { ...first, chain: { id: "fixture-chain", name: "Fixture chain", steps: [first, fallback] } }
const rechained = { ...first, chain: { id: "reconfigured-chain", name: "Reconfigured chain", steps: [first, other] } }

/** The production TaskAdmission fixture, with the parent's persisted model as
 * a parameter so a follow-up can be observed after the parent's selection,
 * the child's chain or the configuration changed under it. */
const fixture = <R>(parentModel: ModelV2.Ref,
  body: (dependencies: TaskAdmission.Dependencies, input: TaskAdmission.Input) => Effect.Effect<void, unknown, R>) =>
  Effect.acquireUseRelease(Effect.promise(() => tmpdir()), (tmp) => {
    const database = Database.layerFromPath(":memory:")
    const events = EventV2.layer.pipe(Layer.provide(database))
    const projector = SessionProjector.layer.pipe(Layer.provide(database), Layer.provide(events))
    const store = SessionStore.layer.pipe(Layer.provide(database))
    const content = ContentStore.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer), Layer.provide(Global.layerWith({ data: tmp.path })))
    return Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      const content = yield* ContentStore.Service
      const agents = yield* AgentV2.Service
      const registry = yield* ToolRegistry.Service
      const checkouts = yield* WorkspaceCheckout.Service
      const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
      yield* agents.update((editor) => {
        editor.update(build, (agent) => { agent.mode = "primary" })
        editor.update(worker, (agent) => { agent.mode = "subagent" })
      })
      yield* db.insert(ProjectTable).values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] }).run()
       yield* db.insert(SessionTable).values({ id: parentID, project_id: ProjectV2.ID.global, directory: location.directory, slug: "parent", title: "parent", version: "test", agent: build,
         model: { ...parentModel, chain: parentModel.chain ? { ...parentModel.chain, steps: [...parentModel.chain.steps] } : parentModel.chain } }).run()
      yield* db.insert(SessionContextEpochTable).values({ session_id: parentID, baseline: "parent context", baseline_seq: -1, snapshot: {}, agent: build }).run()
      yield* db.insert(SessionActivityTable).values({ id: "act_fixture", session_id: parentID, status: "running", kind: "prompt", owner_id: "owner_fixture", lease_until: Date.now() + 60_000 }).run()
      yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_parent_user"), sessionID: parentID, prompt: new Prompt({ text: "Parent evidence" }), delivery: "steer" })
      yield* SessionInput.promoteSteers(db, events, parentID, Number.MAX_SAFE_INTEGER)
      const timestamp = DateTime.makeUnsafe(10)
      yield* events.publish(SessionEvent.Step.Started, { sessionID: parentID, assistantMessageID, timestamp, agent: build, model: parentModel })
      yield* events.publish(SessionEvent.Tool.Input.Started, { sessionID: parentID, assistantMessageID, timestamp, callID: "dispatch", name: "task" })
      yield* events.publish(SessionEvent.Tool.Input.Ended, { sessionID: parentID, assistantMessageID, timestamp, callID: "dispatch", text: "{}" })
      yield* events.publish(SessionEvent.Tool.Called, { sessionID: parentID, assistantMessageID, timestamp, callID: "dispatch", tool: "task", input: {}, provider: { executed: false } })
      const permission: PermissionV2.Interface = {
        assert: () => Effect.void, assertSingleUse: (request) => Effect.succeed(request.id ?? PermissionV2.ID.create()),
        ask: () => Effect.die("unused"), reply: () => Effect.die("unused"),
        get: () => Effect.succeed(undefined), forSession: () => Effect.succeed([]), list: () => Effect.succeed([]),
        materializationRules: () => Effect.succeed([]),
        policySnapshot: () => Effect.succeed({ configured: [], inherited: [], remembered: [], accessControl: { mode: "ask" }, safetyReviewAvailable: false, reviewed: [], rejected: [] }),
      }
      yield* SessionExecutionOwner.withOwner({ sessionID: parentID, activityID: "act_fixture", ownerID: "owner_fixture" }, body(
        { db, events, store, content, agents, registry, checkouts, permission, delegationLayers: () => Effect.succeed([]) },
        { create: { id: childID, parentID, agent: worker, model: parentModel, location },
          prompt: { id: promptID, sessionID: childID, prompt: new Prompt({ text: "Child assignment" }), agent: worker, model: parentModel, resume: false },
          workspace: "main", parentAgent: build, boundary: { assistantMessageID, toolCallID: "dispatch" } },
      ))
    }).pipe(Effect.provide(Layer.mergeAll(database, events, projector, store, content, AgentV2.layer, ToolRegistry.defaultLayer, WorkspaceCheckout.layer)))
  }, (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()))

/** A terminal child: its assignment is promoted and no activity owns it. */
const settle = (dependencies: TaskAdmission.Dependencies) =>
  SessionInput.promoteSteers(dependencies.db, dependencies.events, childID, Number.MAX_SAFE_INTEGER)

/** The tool-call boundary a follow-up is dispatched from. */
const dispatchBoundary = Effect.fn("FollowupPolicyTest.dispatchBoundary")(function* (dependencies: TaskAdmission.Dependencies, callID: string, parentModel: ModelV2.Ref) {
  const assistant = SessionMessage.ID.make(`msg_followup_policy_${callID}_assistant`)
  const timestamp = DateTime.makeUnsafe(20)
  yield* dependencies.events.publish(SessionEvent.Step.Started, { sessionID: parentID, assistantMessageID: assistant, timestamp, agent: build, model: parentModel })
  yield* dependencies.events.publish(SessionEvent.Tool.Called, { sessionID: parentID, assistantMessageID: assistant, timestamp, callID, tool: "task", input: {}, provider: { executed: false } })
  return { assistantMessageID: assistant, toolCallID: callID }
})

const followup = Effect.fn("FollowupPolicyTest.followup")(function* (dependencies: TaskAdmission.Dependencies, callID: string, parentModel: ModelV2.Ref, model: ModelV2.Ref | undefined) {
  return { childID, parentID, parentAgent: build, agent: worker, action: "task" as const, model,
    boundary: yield* dispatchBoundary(dependencies, callID, parentModel),
    prompt: { id: SessionMessage.ID.make(`msg_followup_policy_${callID}_prompt`), sessionID: childID,
      prompt: new Prompt({ text: "Continue with your own history" }), agent: worker, ...(model === undefined ? {} : { model }), resume: false } }
})

/** The task tool's own follow-up shape: without a human override it re-selects
 * from the saved child model with `inherit`, and passes no requested model. */
const toolFollowup = Effect.fn("FollowupPolicyTest.toolFollowup")(function* (dependencies: TaskAdmission.Dependencies, callID: string, parentModel: ModelV2.Ref) {
  const saved = (yield* dependencies.store.get(childID))?.model
  const reselected = ModelPolicy.selectModel({ parent: parentModel, inherit: saved })
  if (!reselected.ok) return yield* Effect.die(`The tool could not re-select the saved model ${JSON.stringify(saved)}`)
  return { ...yield* followup(dependencies, callID, parentModel, reselected.model), modelSelection: { requested: undefined, variant: undefined } }
})

/** The typed policy refusal of a follow-up, or undefined when it was admitted. */
const refusal = Effect.fn("FollowupPolicyTest.refusal")(function* (effect: Effect.Effect<unknown, unknown>) {
  const exit = yield* Effect.exit(effect)
  if (Exit.isSuccess(exit)) return undefined
  const error = Cause.squash(exit.cause)
  if (!(error instanceof TaskDispatchPolicy.Changed)) return yield* Effect.die(`Expected TaskDispatchPolicy.Changed, got ${String(error)}`)
  return error
})

describe("native task follow-up dispatch policy", () => {
  it.live("admits a follow-up of a terminal child that passes no model", () => fixture(first, (dependencies, input) => Effect.gen(function* () {
    yield* TaskAdmission.admit(dependencies, input)
    yield* settle(dependencies)
    const request = yield* followup(dependencies, "inherit", first, undefined)
    const child = yield* TaskAdmission.followup(dependencies, request)
    expect(child.id).toBe(childID)
    expect(child.agentPolicy?.mainWriteConsent?.inputID).toBe(request.prompt.id)
    expect((yield* SessionInput.find(dependencies.db, request.prompt.id))?.prompt.model).toBeUndefined()
  })))

  it.live("keeps a child model that advanced along its chain after a provider failure", () => fixture(chained, (dependencies, input) => Effect.gen(function* () {
    yield* TaskAdmission.admit(dependencies, input)
    yield* settle(dependencies)
    // The runner persists a chain step exactly this way after a provider failure.
    const admitted = (yield* dependencies.store.get(childID))?.model
    const advanced = admitted?.chain ? nextModel(admitted) : undefined
    if (!advanced) return yield* Effect.die(`Missing chain to advance: ${JSON.stringify(admitted)}`)
    yield* dependencies.events.publish(SessionEvent.ModelSwitched, { sessionID: childID, messageID: SessionMessage.ID.create(), timestamp: DateTime.makeUnsafe(15), model: advanced })
    expect(sameChainSelection((yield* dependencies.store.get(childID))?.model, advanced)).toBe(true)
    const byTool = yield* toolFollowup(dependencies, "chain-tool", chained)
    expect(sameChainSelection((yield* TaskAdmission.followup(dependencies, byTool)).model, advanced)).toBe(true)
    yield* settle(dependencies)
    const direct = yield* followup(dependencies, "chain-direct", chained, undefined)
    expect(sameChainSelection((yield* TaskAdmission.followup(dependencies, direct)).model, advanced)).toBe(true)
    expect(yield* dependencies.db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, childID)).all()).toHaveLength(3)
  })))

  it.live("keeps a child model that was selected explicitly when the task was created", () => fixture(chained, (dependencies, input) => Effect.gen(function* () {
    const selected = ModelPolicy.selectModel({ model: `${fallback.providerID}/${fallback.id}`, parent: chained })
    if (!selected.ok) return yield* Effect.die("The fixture override did not resolve")
    yield* TaskAdmission.admit(dependencies, { ...input, create: { ...input.create, model: selected.model }, prompt: { ...input.prompt, model: selected.model },
      modelSelection: { requested: `${fallback.providerID}/${fallback.id}` } })
    yield* settle(dependencies)
    const byTool = yield* toolFollowup(dependencies, "override-tool", chained)
    expect(sameChainSelection((yield* TaskAdmission.followup(dependencies, byTool)).model, selected.model)).toBe(true)
    yield* settle(dependencies)
    const direct = yield* followup(dependencies, "override-direct", chained, undefined)
    expect(sameChainSelection((yield* TaskAdmission.followup(dependencies, direct)).model, selected.model)).toBe(true)
  })))

  it.live("refuses a follow-up whose saved model the current configuration no longer offers", () => fixture(first, (dependencies, input) => Effect.gen(function* () {
    yield* TaskAdmission.admit(dependencies, input)
    yield* settle(dependencies)
    yield* dependencies.db.update(SessionTable).set({ model: other }).where(eq(SessionTable.id, parentID)).run()
    const byTool = yield* refusal(TaskAdmission.followup(dependencies, yield* toolFollowup(dependencies, "stale-tool", other)))
    expect(byTool).toMatchObject({ reason: "model-selection-invalid", detail: { requested: `${first.providerID}/${first.id}` } })
    expect(byTool?.detail?.allowed).toEqual([{ ...other, variant: ModelV2.VariantID.make("default"), chain: undefined }])
    expect(byTool?.message).toBe("Task dispatch refused: Model fixture/first is not configured for this agent or session. " +
      "Allowed models: fixture/other (default). Configure the model on the agent or add it to the Settings model chain to make it available.")
    const direct = yield* refusal(TaskAdmission.followup(dependencies, yield* followup(dependencies, "stale-direct", other, undefined)))
    expect(direct).toMatchObject({ reason: "model-selection-invalid", detail: { requested: `${first.providerID}/${first.id}` } })
    expect(yield* dependencies.db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, childID)).all()).toHaveLength(1)
  })))

  it.live("does not admit a task follow-up before its bound provider retry time", () => fixture(first, (dependencies, input) => Effect.gen(function* () {
    yield* TaskAdmission.admit(dependencies, input)
    yield* settle(dependencies)
    const assistant = SessionMessage.ID.create()
    const timestamp = DateTime.makeUnsafe(Date.now())
    const resetAt = Date.now() + 600_000
    yield* dependencies.events.publish(SessionEvent.Step.Started, { sessionID: childID,
      assistantMessageID: assistant, timestamp, agent: worker, model: first })
    yield* dependencies.events.publish(SessionEvent.Step.Failed, { sessionID: childID,
      assistantMessageID: assistant, timestamp, error: { type: "unknown", message: "Provider wait" },
      failure: { code: "provider.rate-limit", message: "Provider wait", resetAt,
        retryability: "none", remediation: "retry", cause: { detail: "task-chain-exhausted;passes=1;attempts=fixture/first:provider.rate-limit" } } })
    const request = yield* followup(dependencies, "provider-wait", first, undefined)
    const exit = yield* Effect.exit(TaskAdmission.followup(dependencies, request))
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({ reason: "retry-not-due", retryAt: resetAt })
    expect(yield* SessionInput.find(dependencies.db, request.prompt.id)).toBeUndefined()
    expect((yield* dependencies.store.get(childID))?.agentPolicy?.mainWriteConsent?.inputID).toBe(input.prompt.id)
  })))
})
