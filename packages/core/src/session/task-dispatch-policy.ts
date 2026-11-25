export * as TaskDispatchPolicy from "./task-dispatch-policy"

import { Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { createHash } from "node:crypto"
import { AgentV2 } from "../agent"
import { ModelV2 } from "../model"
import { ModelPolicy } from "../tool/model-policy"
import { PermissionV2 } from "../permission"
import { PermissionSchema } from "../permission/schema"
import type { ToolRegistry } from "../tool/registry"
import { SessionAgentPolicy } from "./agent-policy"
import type { SessionSchema } from "./schema"
import type { SessionStore } from "./store"
import { DelegationPreferences } from "./delegation-preferences"
import { sameChainSelection } from "./runner/model-chain"

const REFUSED = "Task dispatch refused: "

/** Capturing policy is evidence only. It does not create, admit, or run a task. */
export class Changed extends Schema.TaggedErrorClass<Changed>()("TaskDispatchPolicy.Changed", {
  /** Stable machine-readable cause; `message` is its readable form. */
  reason: Schema.Literals([
    "permission-unavailable",
    "parent-missing",
    "parent-agent-changed",
    "parent-agent-missing",
    "child-agent-missing",
    "workflow-models-unavailable",
    "model-selection-invalid",
    "model-selection-changed",
    "delegation-preferences-invalid",
    "delegation-layers-unavailable",
    "permission-denied",
    "snapshot-unknown",
    "dependencies-changed",
    "snapshot-changed",
  ]),
  detail: Schema.optional(Schema.Struct({
    /** snapshot-changed: the drifted snapshot areas and the leaf paths inside them. */
    keys: Schema.optional(Schema.Array(Schema.String)),
    paths: Schema.optional(Schema.Array(Schema.String)),
    /** permission-denied: the evaluated action, the denying rule and the rules it came from. */
    action: Schema.optional(Schema.String),
    layer: Schema.optional(Schema.Literals(["agent", "inherited"])),
    rule: Schema.optional(PermissionSchema.Rule),
    /** model-selection-invalid: the requested model and the configured models instead. */
    requested: Schema.optional(Schema.String),
    allowed: Schema.optional(Schema.Array(ModelV2.Ref)),
    /** model-selection-changed: the frozen selection and what the current policy resolves to. */
    selected: Schema.optional(Schema.NullOr(ModelV2.Ref)),
    current: Schema.optional(Schema.NullOr(ModelV2.Ref)),
    /** parent-agent-changed, parent-agent-missing, child-agent-missing. */
    agent: Schema.optional(AgentV2.ID),
    expected: Schema.optional(AgentV2.ID),
    /** workflow-models-unavailable. */
    workflow: Schema.optional(Schema.String),
  })),
}) {
  override get message() {
    const detail = this.detail
    const model = (ref: ModelV2.Ref | null | undefined) => ref === null || ref === undefined ? "no model"
      : `${ModelPolicy.formatModel(ref)}${ref.chain ? ` with fallback chain ${ref.chain.id}` : ""}`
    switch (this.reason) {
      case "permission-unavailable":
        return `${REFUSED}the permission service exposes no policy snapshot, so the parent session's task permission cannot be verified`
      case "parent-missing":
        return `${REFUSED}the parent session no longer exists`
      case "parent-agent-changed":
        return `${REFUSED}the parent session now runs agent ${detail?.agent}, not ${detail?.expected}`
      case "parent-agent-missing":
        return `${REFUSED}the parent agent ${detail?.agent} is not available`
      case "child-agent-missing":
        return `${REFUSED}the subagent ${detail?.agent} is not available`
      case "workflow-models-unavailable":
        return `${REFUSED}workflow ${detail?.workflow} has no configured model source, so its model selection cannot be verified`
      case "model-selection-invalid":
        return REFUSED + ModelPolicy.rejectionMessage({ requested: detail?.requested ?? "", allowed: detail?.allowed ?? [] })
      case "model-selection-changed":
        return `${REFUSED}the model selection changed while the task was being prepared (selected ${model(detail?.selected)}, now resolves to ${model(detail?.current)})`
      case "delegation-preferences-invalid":
        return `${REFUSED}the parent session's stored delegation preferences are invalid, so its delegation rules cannot be verified`
      case "delegation-layers-unavailable":
        return `${REFUSED}delegation rule sources are unavailable, so the delegation rules cannot be verified`
      case "permission-denied": {
        const rule = detail?.rule
        const source = detail?.layer === "inherited" ? "the parent session's inherited permission layers" : "the parent agent's rules"
        return `${REFUSED}the parent session's permission policy denies ${detail?.action}${rule ? ` (rule ${rule.action}/${rule.resource}: ${rule.effect} from ${source})` : ""}`
      }
      case "snapshot-unknown":
        return `${REFUSED}the prepared policy snapshot is unknown, so the task cannot be revalidated`
      case "dependencies-changed":
        return `${REFUSED}the task was revalidated against different policy dependencies than it was captured with`
      case "snapshot-changed": {
        const paths = detail?.paths ?? []
        const shown = paths.slice(0, 5).join(", ") + (paths.length > 5 ? `, and ${paths.length - 5} more` : "")
        return `${REFUSED}the parent session's policy changed while the task was being prepared (${shown || detail?.keys?.join(", ")})`
      }
    }
  }
}
export class DelegationDenied extends Schema.TaggedErrorClass<DelegationDenied>()("TaskDispatchPolicy.DelegationDenied", {
  sources: Schema.Array(Schema.String),
  reason: Schema.Literals(["topics", "selection"]),
}) {
  override get message() { return `${this.reason === "topics" ? "Task topics are required by" : "Task selection conflicts with"} binding delegation rules: ${this.sources.join(", ")}` }
}

export type Dependencies = {
  readonly agents: Pick<AgentV2.Interface, "get">
  readonly permission: Pick<PermissionV2.Interface, "policySnapshot" | "materializationRules">
  readonly registry: Pick<ToolRegistry.Interface, "materialize">
  readonly store: Pick<SessionStore.Interface, "get">
  readonly workflowModels?: (key: string) => Effect.Effect<readonly ModelV2.Ref[]>
  readonly delegationLayers: () => Effect.Effect<readonly DelegationPreferences.Layer[], DelegationPreferences.Invalid>
}

export type Input = {
  readonly parentID: SessionSchema.ID
  readonly parentAgent: AgentV2.ID
  readonly childAgent: AgentV2.ID
  readonly childID?: SessionSchema.ID
  readonly topics?: readonly string[]
  readonly action?: "task" | "multi_agent_fanout"
  /** A registered workflow's bounded tool list, not model-provided permission. */
  readonly workflowTools?: readonly string[]
  readonly modelSelection?: {
    readonly requested?: string
    readonly variant?: string
    readonly selected?: ModelV2.Ref
    readonly workflow?: string
    readonly inheritChild?: boolean
  }
}

const snapshots = new WeakMap<object, { readonly dependencies: Dependencies; readonly input: Input; readonly value: Snapshot }>()
type Snapshot = Effect.Success<ReturnType<typeof observe>>

const observe = Effect.fn("TaskDispatchPolicy.observe")(function* (dependencies: Dependencies, input: Input) {
  if (!dependencies.permission.policySnapshot) return yield* new Changed({ reason: "permission-unavailable" })
  const parent = yield* dependencies.store.get(input.parentID)
  const parentAgent = yield* dependencies.agents.get(input.parentAgent)
  const childAgent = yield* dependencies.agents.get(input.childAgent)
  if (!parent) return yield* new Changed({ reason: "parent-missing" })
  if (parent.agent !== undefined && parent.agent !== input.parentAgent)
    return yield* new Changed({ reason: "parent-agent-changed", detail: { agent: parent.agent, expected: input.parentAgent } })
  if (!parentAgent) return yield* new Changed({ reason: "parent-agent-missing", detail: { agent: input.parentAgent } })
  if (!childAgent) return yield* new Changed({ reason: "child-agent-missing", detail: { agent: input.childAgent } })
  const extraModels = input.modelSelection?.workflow
    ? dependencies.workflowModels
      ? yield* dependencies.workflowModels(input.modelSelection.workflow)
      : yield* new Changed({ reason: "workflow-models-unavailable", detail: { workflow: input.modelSelection.workflow } })
    : []
  if (input.modelSelection) {
    const inherited = input.modelSelection.inheritChild && input.childID
      ? (yield* dependencies.store.get(input.childID))?.model : undefined
    const requested = inherited ? `${inherited.providerID}/${inherited.id}` : input.modelSelection.requested
    const selected = ModelPolicy.selectModel({ model: requested, variant: inherited?.variant ?? input.modelSelection.variant,
      agent: childAgent.model, parent: parent.model, extra: extraModels, direct: input.action === "multi_agent_fanout" })
    if (!selected.ok) return yield* new Changed({ reason: "model-selection-invalid", detail: { requested: selected.requested, allowed: [...selected.allowed] } })
    if (!sameChainSelection(selected.model, input.modelSelection.selected) ||
      (input.modelSelection.inheritChild && !sameChainSelection(inherited, input.modelSelection.selected)))
      return yield* new Changed({ reason: "model-selection-changed", detail: { selected: input.modelSelection.selected ?? null, current: selected.model ?? null } })
  }
  const storedPreferences = parent.metadata?.[DelegationPreferences.METADATA_KEY]
  const preferences = storedPreferences === undefined ? undefined
    : yield* Schema.decodeUnknownEffect(DelegationPreferences.State)(storedPreferences)
      .pipe(Effect.mapError(() => new Changed({ reason: "delegation-preferences-invalid" })))
  if (!dependencies.delegationLayers) return yield* new Changed({ reason: "delegation-layers-unavailable" })
  const configuredPreferences = yield* dependencies.delegationLayers()
  const taskPreferences = input.childID === undefined ? undefined : preferences?.tasks[input.childID]
  const layers = [...(taskPreferences ? [{ scope: "task" as const, value: taskPreferences }] : []),
    ...(preferences ? [{ scope: "session" as const, value: preferences.session }] : []), ...configuredPreferences]
  const topicalRules = layers.filter((layer) => layer.value.rules?.some((rule) => rule.topic !== undefined))
  if (!input.topics?.length && topicalRules.length)
    return yield* new DelegationDenied({ reason: "topics", sources: topicalRules.map((layer) => "source" in layer ? layer.source ?? layer.scope : layer.scope) })
  const delegation = DelegationPreferences.resolveLayers({
    layers,
    topics: input.topics ?? [],
    candidates: [{ agent: input.childAgent, model: input.modelSelection?.selected
      ? `${input.modelSelection.selected.providerID}/${input.modelSelection.selected.id}` : "",
      variant: input.modelSelection?.selected?.variant ?? "default", chain: input.modelSelection?.selected?.chain?.id }],
  })
  if (delegation.impossible) return yield* new DelegationDenied({ reason: "selection", sources: delegation.rules.map((entry) => entry.source ?? entry.scope) })
  const permission = yield* dependencies.permission.policySnapshot({ sessionID: input.parentID, agent: input.parentAgent })
  const action = input.action ?? "task"
  // Configured rules are the parent agent's own; inherited layers are the parent
  // session's agentPolicy layers when it is itself a delegated child.
  const denial = [{ layer: "agent" as const, rules: permission.configured }, ...permission.inherited.map((rules) => ({ layer: "inherited" as const, rules }))]
    .map((entry) => ({ layer: entry.layer, rule: PermissionV2.evaluate(action, input.childAgent, entry.rules) }))
    .find((entry) => entry.rule.effect === "deny")
  if (denial) return yield* new Changed({ reason: "permission-denied", detail: { action, layer: denial.layer, rule: denial.rule } })
  const rules = yield* dependencies.permission.materializationRules({ sessionID: input.parentID, agent: input.parentAgent })
  const parentTools = yield* dependencies.registry.materialize(rules, SessionAgentPolicy.delegable(parent.agentPolicy?.tools ?? parentAgent.tools))
  const childTools = yield* dependencies.registry.materialize(childAgent.permissions, childAgent.tools)
  return structuredClone({
    parentAgent,
    childAgent,
    permission,
    parentPolicy: parent.agentPolicy,
    parentSelection: { agent: parent.agent, model: parent.model, location: parent.location, revert: parent.revert, archived: parent.time.archived },
    parentTools: parentTools.definitions,
    childTools: childTools.definitions,
    extraModels,
    delegation: { configured: configuredPreferences, stored: preferences, resolved: delegation },
  })
})

export const capture = Effect.fn("TaskDispatchPolicy.capture")(function* (dependencies: Dependencies, input: Input) {
  const frozen = structuredClone(input)
  const value = yield* observe(dependencies, frozen)
  const token = Object.freeze({})
  snapshots.set(token, { dependencies, input: frozen, value })
  return token
})

/** Stable evidence for replayable retry binding, not an execution capability.
 * Only the authority-binding areas of the snapshot are hashed, for the same
 * reason they are the only drift signal: a retry must reproduce the delegated
 * authority, not the parent's concurrent host/UI state. */
export function digest(token: object) {
  const saved = snapshots.get(token)
  if (!saved) throw new Error("Unknown task policy snapshot")
  return createHash("sha256").update(JSON.stringify({ input: saved.input, value: binding(saved.value, saved.input.childID) })).digest("hex")
}

/** The snapshot areas that bind the child's delegated authority. Everything
 * left out is the parent's concurrent host/UI state: the composer's approval
 * mode, saved "always allow" grants and safety-review memory (the child's own
 * permission checks read those live, never through this snapshot), the
 * composer's model choice (the frozen selection is re-resolved against it on
 * every observation instead), and other tasks' delegation preferences. That
 * state stays in the token as evidence but is neither hashed nor a drift signal. */
function binding(snapshot: Snapshot, childID: SessionSchema.ID | undefined): Record<string, unknown> {
  const { permission, parentSelection, delegation, ...rest } = structuredClone(snapshot)
  return {
    ...rest,
    permission: { configured: permission.configured, inherited: permission.inherited },
    parentSelection: { agent: parentSelection.agent, location: parentSelection.location, revert: parentSelection.revert, archived: parentSelection.archived },
    delegation: { ...delegation, stored: delegation.stored === undefined ? undefined : {
      session: delegation.stored.session,
      ...(childID === undefined ? {} : { task: delegation.stored.tasks[childID] }),
    } },
  }
}

/** Drifted snapshot areas and the leaf paths inside them, or undefined when
 * nothing that binds the child changed. */
function drift(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = Object.keys(before).filter((key) => !isDeepStrictEqual(after[key], before[key]))
  if (!keys.length) return
  return { keys, paths: keys.flatMap((key) => changedPaths(before[key], after[key], key)).slice(0, 32) }
}

/** Leaf paths whose values differ, e.g. `permission.configured[0].effect`. */
function changedPaths(before: unknown, after: unknown, path: string): string[] {
  if (isDeepStrictEqual(before, after)) return []
  if (!isRecord(before) || !isRecord(after) || Array.isArray(before) !== Array.isArray(after)) return [path]
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
    changedPaths(before[key], after[key], Array.isArray(before) ? `${path}[${key}]` : `${path}.${key}`))
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

export const revalidate = Effect.fn("TaskDispatchPolicy.revalidate")(function* (dependencies: Dependencies, token: object) {
  const saved = snapshots.get(token)
  if (!saved) return yield* new Changed({ reason: "snapshot-unknown" })
  if (saved.dependencies !== dependencies) return yield* new Changed({ reason: "dependencies-changed" })
  const current = yield* observe(dependencies, saved.input)
  const changed = drift(binding(saved.value, saved.input.childID), binding(current, saved.input.childID))
  if (changed) return yield* new Changed({ reason: "snapshot-changed", detail: changed })
  const policy = SessionAgentPolicy.derive({
    parent: current.parentPolicy,
    parentSessionID: saved.input.parentID,
    parentAgent: current.parentAgent,
    parentDelegableTools: current.parentTools.map((tool) => tool.name),
    childTools: current.childTools.map((tool) => tool.name).filter((name) => !saved.input.workflowTools || saved.input.workflowTools.includes(name)),
    type: "task",
  })
  // Preserve the source's configured ceiling; remembered and one-use grants
  // are evidence for revalidation, never copied as child authority.
  return { ...policy, permissionLayers: [...policy.permissionLayers, current.permission.configured] }
})
