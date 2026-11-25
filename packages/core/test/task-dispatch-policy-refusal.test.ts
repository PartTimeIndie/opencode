import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionSchema } from "@opencode-ai/core/permission/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { DelegationPreferences } from "@opencode-ai/core/session/delegation-preferences"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { TaskDispatchPolicy } from "@opencode-ai/core/session/task-dispatch-policy"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.mergeAll(AgentV2.layer, ToolRegistry.defaultLayer))
const parentID = SessionSchema.ID.make("ses_policy_refusal_parent")
const childID = SessionSchema.ID.make("ses_policy_refusal_child")
const build = AgentV2.ID.make("build")
const worker = AgentV2.ID.make("worker")
const ghost = AgentV2.ID.make("ghost")
const first = { id: ModelV2.ID.make("first"), providerID: ProviderV2.ID.make("fixture") }
const second = { id: ModelV2.ID.make("second"), providerID: ProviderV2.ID.make("fixture") }
const input = { parentID, parentAgent: build, childAgent: worker, childID, workflowTools: ["read"] }
const REFUSED = "Task dispatch refused: "

type Permission = {
  configured: PermissionSchema.Ruleset[number][]
  inherited: PermissionSchema.Ruleset[]
  accessControl: { mode: "ask" | "full_access" }
  remembered: PermissionSchema.Ruleset[number][]
  safetyReviewAvailable: boolean
  reviewed: string[]
  rejected: string[]
}
type State = {
  parent: SessionSchema.Info
  permission: Permission
  layers: DelegationPreferences.Layer[]
}

const parentInfo = (overrides: Record<string, unknown> = {}) => Schema.decodeUnknownSync(SessionSchema.Info)({
  id: parentID, projectID: ProjectV2.ID.global, agent: build, title: "parent",
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 }, location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
  ...overrides,
})
const stored = (value: { session: DelegationPreferences.State["session"]; tasks: DelegationPreferences.State["tasks"] }): SessionSchema.Info["metadata"] =>
  ({ [DelegationPreferences.METADATA_KEY]: { version: 1, revision: 2, ...value } })
const agentPolicy = {
  tools: { mode: "explicit" as const, entries: {} },
  permissionLayers: [[{ action: "write", resource: "*", effect: "allow" as const }]],
  source: { type: "task" as const, sessionID: "ses_policy_refusal_grandparent", agent: build },
}

/** Fresh host state for one test. Tests mutate exactly one of these areas
 * between capture and revalidate, the way a concurrent host or UI write does. */
const fixture = Effect.gen(function* () {
  const agents = yield* AgentV2.Service
  const registry = yield* ToolRegistry.Service
  yield* agents.update((editor) => {
    editor.update(build, (agent) => { agent.mode = "primary" })
    editor.update(worker, (agent) => { agent.mode = "subagent" })
  })
  yield* registry.register({ read: Tool.make({
    description: "fixture", input: Schema.Struct({}), output: Schema.Struct({ ok: Schema.Boolean }), execute: () => Effect.succeed({ ok: true }),
  }) })
  const state: State = {
    parent: parentInfo(),
    permission: { configured: [], inherited: [], accessControl: { mode: "ask" }, remembered: [], safetyReviewAvailable: false, reviewed: [], rejected: [] },
    layers: [],
  }
  const dependencies = (missing: { readonly policySnapshot?: true; readonly delegationLayers?: true } = {}): TaskDispatchPolicy.Dependencies => ({
    agents, registry,
    store: { get: () => Effect.succeed(structuredClone(state.parent)) },
    permission: {
      materializationRules: () => Effect.succeed([]),
      ...(missing.policySnapshot ? {} : { policySnapshot: () => Effect.succeed(structuredClone(state.permission)) }),
    },
    delegationLayers: missing.delegationLayers ? undefined! : () => Effect.succeed(structuredClone(state.layers)),
  })
  return { agents, state, dependencies }
})

/** The single typed failure of an effect, required to be TaskDispatchPolicy.Changed. */
const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) return yield* Effect.die(`Expected a refusal, got ${JSON.stringify(exit.value)}`)
    const error = Cause.squash(exit.cause)
    if (!(error instanceof TaskDispatchPolicy.Changed)) return yield* Effect.die(`Expected TaskDispatchPolicy.Changed, got ${String(error)}`)
    return error
  })

describe("native task dispatch refusal reasons", () => {
  it.effect("reports a missing permission policy snapshot", () =>
    Effect.gen(function* () {
      const { dependencies } = yield* fixture
      const error = yield* refusal(TaskDispatchPolicy.capture(dependencies({ policySnapshot: true }), input))
      expect(error._tag).toBe("TaskDispatchPolicy.Changed")
      expect(error.reason).toBe("permission-unavailable")
      expect(error.detail).toBeUndefined()
      expect(error.message).toBe(REFUSED + "the permission service exposes no policy snapshot, so the parent session's task permission cannot be verified")
    }),
  )
  it.effect("reports a missing parent session record", () =>
    Effect.gen(function* () {
      const { state, dependencies } = yield* fixture
      const policy = dependencies()
      state.parent = undefined as never
      const error = yield* refusal(TaskDispatchPolicy.capture(policy, input))
      expect(error.reason).toBe("parent-missing")
      expect(error.message).toBe(REFUSED + "the parent session no longer exists")
    }),
  )
  it.effect("reports a parent session that now runs another agent", () =>
    Effect.gen(function* () {
      const { state, dependencies } = yield* fixture
      const policy = dependencies()
      state.parent = parentInfo({ agent: worker })
      const error = yield* refusal(TaskDispatchPolicy.capture(policy, input))
      expect(error.reason).toBe("parent-agent-changed")
      expect(error.detail).toEqual({ agent: worker, expected: build })
      expect(error.message).toBe(`${REFUSED}the parent session now runs agent ${worker}, not ${build}`)
    }),
  )
  it.effect("reports a missing parent agent record", () =>
    Effect.gen(function* () {
      const { state, dependencies } = yield* fixture
      const policy = dependencies()
      state.parent = parentInfo({ agent: undefined })
      const error = yield* refusal(TaskDispatchPolicy.capture(policy, { ...input, parentAgent: ghost }))
      expect(error.reason).toBe("parent-agent-missing")
      expect(error.detail).toEqual({ agent: ghost })
      expect(error.message).toBe(`${REFUSED}the parent agent ${ghost} is not available`)
    }),
  )
  it.effect("reports a missing child agent record", () =>
    Effect.gen(function* () {
      const { dependencies } = yield* fixture
      const error = yield* refusal(TaskDispatchPolicy.capture(dependencies(), { ...input, childAgent: ghost }))
      expect(error.reason).toBe("child-agent-missing")
      expect(error.detail).toEqual({ agent: ghost })
      expect(error.message).toBe(`${REFUSED}the subagent ${ghost} is not available`)
    }),
  )
  it.effect("reports a workflow selection without a configured model source", () =>
    Effect.gen(function* () {
      const { dependencies } = yield* fixture
      const error = yield* refusal(TaskDispatchPolicy.capture(dependencies(), { ...input, modelSelection: { workflow: "review", selected: first } }))
      expect(error.reason).toBe("workflow-models-unavailable")
      expect(error.detail).toEqual({ workflow: "review" })
      expect(error.message).toBe(`${REFUSED}workflow review has no configured model source, so its model selection cannot be verified`)
    }),
  )
  it.effect("reports a requested model that is not configured for the child", () =>
    Effect.gen(function* () {
      const { agents, dependencies } = yield* fixture
      yield* agents.update((editor) => editor.update(worker, (agent) => { agent.model = first }))
      const error = yield* refusal(TaskDispatchPolicy.capture(dependencies(), { ...input, modelSelection: { requested: "fixture/unknown", selected: first } }))
      expect(error.reason).toBe("model-selection-invalid")
      expect(error.detail).toEqual({ requested: "fixture/unknown", allowed: [first] })
      expect(error.message).toBe(`${REFUSED}Model fixture/unknown is not configured for this agent or session. Allowed models: fixture/first. ` +
        "Configure the model on the agent or add it to the Settings model chain to make it available.")
    }),
  )
  it.effect("reports a model selection that no longer matches the frozen selection", () =>
    Effect.gen(function* () {
      const { agents, dependencies } = yield* fixture
      yield* agents.update((editor) => editor.update(worker, (agent) => { agent.model = second }))
      const error = yield* refusal(TaskDispatchPolicy.capture(dependencies(), { ...input, modelSelection: { selected: first } }))
      expect(error.reason).toBe("model-selection-changed")
      expect(error.detail).toEqual({ selected: first, current: second })
      expect(error.message).toBe(`${REFUSED}the model selection changed while the task was being prepared (selected fixture/first, now resolves to fixture/second)`)
    }),
  )
  it.effect("reports invalid stored delegation preferences", () =>
    Effect.gen(function* () {
      const { state, dependencies } = yield* fixture
      const policy = dependencies()
      state.parent = parentInfo({ metadata: { [DelegationPreferences.METADATA_KEY]: { version: 1, revision: "soon" } } })
      const error = yield* refusal(TaskDispatchPolicy.capture(policy, input))
      expect(error.reason).toBe("delegation-preferences-invalid")
      expect(error.message).toBe(REFUSED + "the parent session's stored delegation preferences are invalid, so its delegation rules cannot be verified")
    }),
  )
  it.effect("reports missing delegation rule sources", () =>
    Effect.gen(function* () {
      const { dependencies } = yield* fixture
      const error = yield* refusal(TaskDispatchPolicy.capture(dependencies({ delegationLayers: true }), input))
      expect(error.reason).toBe("delegation-layers-unavailable")
      expect(error.message).toBe(REFUSED + "delegation rule sources are unavailable, so the delegation rules cannot be verified")
    }),
  )
  for (const { layer, rule, apply } of [
    { layer: "agent", rule: { action: "task", resource: "*", effect: "deny" } as const, apply: (permission: Permission) => permission.configured.push({ action: "task", resource: "*", effect: "deny" }) },
    { layer: "inherited", rule: { action: "*", resource: worker, effect: "deny" } as const, apply: (permission: Permission) => permission.inherited.push([{ action: "*", resource: worker, effect: "deny" }]) },
  ] as const)
    it.effect(`reports the denying ${layer} rule for the task action`, () =>
      Effect.gen(function* () {
        const { state, dependencies } = yield* fixture
        const policy = dependencies()
        apply(state.permission)
        const error = yield* refusal(TaskDispatchPolicy.capture(policy, input))
        expect(error.reason).toBe("permission-denied")
        expect(error.detail).toEqual({ action: "task", layer, rule })
        expect(error.message).toBe(`${REFUSED}the parent session's permission policy denies task (rule ${rule.action}/${rule.resource}: deny from ` +
          (layer === "agent" ? "the parent agent's rules)" : "the parent session's inherited permission layers)"))
      }),
    )
  it.effect("keeps DelegationDenied as its own typed refusal with its sources", () =>
    Effect.gen(function* () {
      const { state, dependencies } = yield* fixture
      state.layers.push({ scope: "project", source: "project/opencode.json", value: { rules: [{ topic: "reviews", allowed: [{ agent: "worker" }] }] } })
      const error = yield* Effect.flip(TaskDispatchPolicy.capture(dependencies(), input))
      expect(error).toBeInstanceOf(TaskDispatchPolicy.DelegationDenied)
      expect(error._tag).toBe("TaskDispatchPolicy.DelegationDenied")
      expect(error).toMatchObject({ reason: "topics", sources: ["project/opencode.json"] })
      expect(error.message).toBe("Task topics are required by binding delegation rules: project/opencode.json")
    }),
  )
  it.effect("reports an unknown snapshot token", () =>
    Effect.gen(function* () {
      const { dependencies } = yield* fixture
      const error = yield* refusal(TaskDispatchPolicy.revalidate(dependencies(), {}))
      expect(error.reason).toBe("snapshot-unknown")
      expect(error.message).toBe(REFUSED + "the prepared policy snapshot is unknown, so the task cannot be revalidated")
    }),
  )
  it.effect("reports a revalidation against other policy dependencies", () =>
    Effect.gen(function* () {
      const { dependencies } = yield* fixture
      const policy = dependencies()
      const prepared = yield* TaskDispatchPolicy.capture(policy, input)
      const error = yield* refusal(TaskDispatchPolicy.revalidate({ ...policy }, prepared))
      expect(error.reason).toBe("dependencies-changed")
      expect(error.message).toBe(REFUSED + "the task was revalidated against different policy dependencies than it was captured with")
    }),
  )
})

describe("native task dispatch snapshot drift", () => {
  for (const change of [
    { name: "the parent's inherited permission layers", baseline: (state: State) => { state.parent = parentInfo({ agentPolicy: structuredClone(agentPolicy) }) },
      apply: (state: State) => { state.parent = parentInfo({ agentPolicy: { ...agentPolicy, permissionLayers: [[{ action: "write", resource: "*", effect: "deny" }]] } }) },
      keys: ["parentPolicy"], paths: ["parentPolicy.permissionLayers[0][0].effect"] },
    { name: "the parent's location", baseline: undefined,
      apply: (state: State) => { state.parent = parentInfo({ location: Location.Ref.make({ directory: AbsolutePath.make("/elsewhere") }) }) },
      keys: ["parentSelection"], paths: ["parentSelection.location.directory"] },
    { name: "the parent's archive state", baseline: undefined,
      apply: (state: State) => { state.parent = parentInfo({ time: { created: 1, updated: 1, archived: 1 } }) },
      keys: ["parentSelection"], paths: ["parentSelection.archived"] },
    { name: "the parent's configured permission rules", baseline: undefined,
      apply: (state: State) => { state.permission.configured.push({ action: "edit", resource: "*", effect: "allow" }) },
      keys: ["permission"], paths: ["permission.configured[0]"] },
    { name: "the configured delegation rules", baseline: (state: State) => { state.layers = [{ scope: "project", value: { ordinaryQuestions: true } }] },
      apply: (state: State) => { state.layers = [{ scope: "project", value: { ordinaryQuestions: false } }] },
      keys: ["delegation"], paths: ["delegation.configured[0].value.ordinaryQuestions", "delegation.resolved.ordinaryQuestions"] },
    { name: "the session's delegation rules", baseline: (state: State) => { state.parent = parentInfo({ metadata: stored({ session: { ordinaryQuestions: true }, tasks: {} }) }) },
      apply: (state: State) => { state.parent = parentInfo({ metadata: stored({ session: { ordinaryQuestions: false }, tasks: {} }) }) },
      keys: ["delegation"], paths: ["delegation.stored.session.ordinaryQuestions", "delegation.resolved.ordinaryQuestions"] },
    { name: "this task's delegation rules", baseline: (state: State) => { state.parent = parentInfo({ metadata: stored({ session: {}, tasks: { [childID]: { ordinaryQuestions: true } } }) }) },
      apply: (state: State) => { state.parent = parentInfo({ metadata: stored({ session: {}, tasks: { [childID]: { ordinaryQuestions: false } } }) }) },
      keys: ["delegation"], paths: ["delegation.stored.task.ordinaryQuestions", "delegation.resolved.ordinaryQuestions"] },
  ])
    it.effect(`refuses a change to ${change.name} and names the drifted paths`, () =>
      Effect.gen(function* () {
        const { state, dependencies } = yield* fixture
        change.baseline?.(state)
        const policy = dependencies()
        const prepared = yield* TaskDispatchPolicy.capture(policy, input)
        // Revalidate before the change so the refusal is attributable to that one write.
        expect(Exit.isSuccess(yield* Effect.exit(TaskDispatchPolicy.revalidate(policy, prepared)))).toBe(true)
        change.apply(state)
        const error = yield* refusal(TaskDispatchPolicy.revalidate(policy, prepared))
        expect(error.reason).toBe("snapshot-changed")
        expect(error.detail).toEqual({ keys: change.keys, paths: change.paths })
        expect(error.message).toBe(`${REFUSED}the parent session's policy changed while the task was being prepared (${change.paths.join(", ")})`)
      }),
    )
  it.effect("refuses a child agent configuration change and names the drifted path", () =>
    Effect.gen(function* () {
      const { agents, dependencies } = yield* fixture
      const policy = dependencies()
      const prepared = yield* TaskDispatchPolicy.capture(policy, input)
      yield* agents.update((editor) => editor.update(worker, (agent) => { agent.system = "changed" }))
      const error = yield* refusal(TaskDispatchPolicy.revalidate(policy, prepared))
      expect(error.reason).toBe("snapshot-changed")
      expect(error.detail).toEqual({ keys: ["childAgent"], paths: ["childAgent.system"] })
    }),
  )
  it.effect("names only authority paths when volatile permission state changes alongside a rule", () =>
    Effect.gen(function* () {
      const { state, dependencies } = yield* fixture
      const policy = dependencies()
      const prepared = yield* TaskDispatchPolicy.capture(policy, input)
      state.permission.remembered.push({ action: "edit", resource: "src/**", effect: "allow" })
      state.permission.reviewed.push(`${parentID}\0edit`)
      state.permission.configured.push({ action: "task", resource: "*", effect: "allow" })
      const error = yield* refusal(TaskDispatchPolicy.revalidate(policy, prepared))
      expect(error.reason).toBe("snapshot-changed")
      expect(error.detail).toEqual({ keys: ["permission"], paths: ["permission.configured[0]"] })
    }),
  )
  it.effect("refuses a deny rule that appeared after capture with the denying rule, not a drift report", () =>
    Effect.gen(function* () {
      const { state, dependencies } = yield* fixture
      const policy = dependencies()
      const prepared = yield* TaskDispatchPolicy.capture(policy, input)
      state.permission.inherited.push([{ action: "task", resource: worker, effect: "deny" }])
      const error = yield* refusal(TaskDispatchPolicy.revalidate(policy, prepared))
      expect(error.reason).toBe("permission-denied")
      expect(error.detail).toEqual({ action: "task", layer: "inherited", rule: { action: "task", resource: worker, effect: "deny" } })
    }),
  )
  it.effect("refuses a parent model switch that changes what the child would inherit", () =>
    Effect.gen(function* () {
      const { state, dependencies } = yield* fixture
      const policy = dependencies()
      state.parent = parentInfo({ model: first })
      const prepared = yield* TaskDispatchPolicy.capture(policy, { ...input, modelSelection: { selected: first } })
      state.parent = parentInfo({ model: second })
      const error = yield* refusal(TaskDispatchPolicy.revalidate(policy, prepared))
      expect(error.reason).toBe("model-selection-changed")
      expect(error.detail).toEqual({ selected: first, current: second })
      expect(error.message).toBe(`${REFUSED}the model selection changed while the task was being prepared (selected fixture/first, now resolves to fixture/second)`)
    }),
  )
})

describe("native task dispatch volatile host state", () => {
  for (const [field, write] of [
    ["remembered", (permission: Permission) => { permission.remembered.push({ action: "edit", resource: "src/**", effect: "allow" }) }],
    ["reviewed", (permission: Permission) => { permission.reviewed.push(`${parentID}\0edit`) }],
    ["rejected", (permission: Permission) => { permission.rejected.push(`${parentID}\0edit`) }],
    ["safetyReviewAvailable", (permission: Permission) => { permission.safetyReviewAvailable = true }],
    ["accessControl", (permission: Permission) => { permission.accessControl = { mode: "full_access" } }],
  ] as const)
    it.effect(`admits a task whose parent's ${field} changed during preparation`, () =>
      Effect.gen(function* () {
        const { state, dependencies } = yield* fixture
        const policy = dependencies()
        const prepared = yield* TaskDispatchPolicy.capture(policy, input)
        const baseline = yield* TaskDispatchPolicy.revalidate(policy, prepared)
        const digest = TaskDispatchPolicy.digest(prepared)
        write(state.permission)
        expect(yield* TaskDispatchPolicy.revalidate(policy, prepared)).toEqual(baseline)
        // A saved grant is the parent's own runtime state; the child never inherits it.
        expect(JSON.stringify(baseline.permissionLayers)).not.toContain("src/**")
        expect(TaskDispatchPolicy.digest(yield* TaskDispatchPolicy.capture(policy, input))).toBe(digest)
      }),
    )
  it.effect("admits a task whose parent's composer model changed when the child's selection is unaffected", () =>
    Effect.gen(function* () {
      const { agents, state, dependencies } = yield* fixture
      yield* agents.update((editor) => editor.update(worker, (agent) => { agent.model = first }))
      const policy = dependencies()
      state.parent = parentInfo({ model: first })
      const prepared = yield* TaskDispatchPolicy.capture(policy, { ...input, modelSelection: { selected: first } })
      const baseline = yield* TaskDispatchPolicy.revalidate(policy, prepared)
      const digest = TaskDispatchPolicy.digest(prepared)
      state.parent = parentInfo({ model: second })
      expect(yield* TaskDispatchPolicy.revalidate(policy, prepared)).toEqual(baseline)
      expect(TaskDispatchPolicy.digest(yield* TaskDispatchPolicy.capture(policy, { ...input, modelSelection: { selected: first } }))).toBe(digest)
    }),
  )
  it.effect("admits a task whose sibling task's delegation preferences changed", () =>
    Effect.gen(function* () {
      const { state, dependencies } = yield* fixture
      const policy = dependencies()
      state.parent = parentInfo({ metadata: stored({ session: {}, tasks: { ses_policy_refusal_sibling: { ordinaryQuestions: true } } }) })
      const prepared = yield* TaskDispatchPolicy.capture(policy, input)
      const baseline = yield* TaskDispatchPolicy.revalidate(policy, prepared)
      const digest = TaskDispatchPolicy.digest(prepared)
      state.parent = parentInfo({ metadata: { [DelegationPreferences.METADATA_KEY]: {
        version: 1, revision: 3, session: {}, tasks: { ses_policy_refusal_sibling: { rules: [{ topic: "reviews", allowed: [{ agent: "build" }] }] } },
      } } })
      expect(yield* TaskDispatchPolicy.revalidate(policy, prepared)).toEqual(baseline)
      expect(TaskDispatchPolicy.digest(yield* TaskDispatchPolicy.capture(policy, input))).toBe(digest)
    }),
  )
})
