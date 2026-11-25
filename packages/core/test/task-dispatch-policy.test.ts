import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { TaskDispatchPolicy } from "@opencode-ai/core/session/task-dispatch-policy"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.mergeAll(AgentV2.layer, ToolRegistry.defaultLayer))
const parentID = SessionSchema.ID.make("ses_policy_parent")
const build = AgentV2.ID.make("build")
const worker = AgentV2.ID.make("worker")

/** The TaskDispatchPolicy.Changed failure of an effect that must refuse. */
const refusal = (effect: Effect.Effect<unknown, unknown>) => Effect.gen(function* () {
  const exit = yield* Effect.exit(effect)
  if (Exit.isSuccess(exit)) return yield* Effect.die(`Expected a refusal, got ${JSON.stringify(exit.value)}`)
  const error = Cause.squash(exit.cause)
  if (!(error instanceof TaskDispatchPolicy.Changed)) return yield* Effect.die(`Expected TaskDispatchPolicy.Changed, got ${String(error)}`)
  return error
})

describe("native task dispatch policy preparation", () => {
  it.effect("pins inherited policy, agent configuration, registered tools, and workflow scope", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const registry = yield* ToolRegistry.Service
      yield* agents.update((editor) => {
        editor.update(build, (agent) => { agent.mode = "primary" })
        editor.update(worker, (agent) => { agent.mode = "subagent" })
      })
      const tool = Tool.make({ description: "fixture", input: Schema.Struct({}), output: Schema.Struct({ ok: Schema.Boolean }), execute: () => Effect.succeed({ ok: true }) })
      yield* registry.register({ read: tool, write: tool })
      const parent = Schema.decodeUnknownSync(SessionSchema.Info)({
        id: parentID, projectID: ProjectV2.ID.global, agent: build, title: "parent",
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 }, location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
      })
      let mode: "ask" | "full_access" = "ask"
      let denyDispatch = false
      const dependencies: TaskDispatchPolicy.Dependencies = {
        agents,
        registry,
        delegationLayers: () => Effect.succeed([]),
        store: { get: () => Effect.succeed(parent) },
        permission: {
          materializationRules: () => Effect.succeed([]),
          policySnapshot: () => Effect.succeed({ configured: [{ action: denyDispatch ? "task" : "write", resource: "*", effect: "deny" }], inherited: [], accessControl: { mode }, remembered: [{ action: "read", resource: "secret", effect: "allow" }], safetyReviewAvailable: false, reviewed: [], rejected: [] }),
        },
      }
      const workflowTools = ["read"]
      const prepared = yield* TaskDispatchPolicy.capture(dependencies, { parentID, parentAgent: build, childAgent: worker, workflowTools })
      workflowTools.push("write")
      const policy = yield* TaskDispatchPolicy.revalidate(dependencies, prepared)
      expect(policy.tools.entries).toHaveProperty("read")
      expect(policy.tools.entries).not.toHaveProperty("write")
      expect(policy.permissionLayers).toContainEqual([{ action: "write", resource: "*", effect: "deny" }])
      expect(JSON.stringify(policy.permissionLayers)).not.toContain("secret")
      expect(Exit.isSuccess(yield* Effect.exit(TaskDispatchPolicy.revalidate(dependencies, prepared)))).toBe(true)
      const digest = TaskDispatchPolicy.digest(prepared)
      mode = "full_access"
      const afterApprovalModeChange = yield* TaskDispatchPolicy.revalidate(dependencies, prepared)
      expect(afterApprovalModeChange).toEqual(policy)
      const recaptured = yield* TaskDispatchPolicy.capture(dependencies, { parentID, parentAgent: build, childAgent: worker, workflowTools: ["read"] })
      expect(TaskDispatchPolicy.digest(recaptured)).toBe(digest)
      mode = "ask"
      denyDispatch = true
      expect(Exit.isFailure(yield* Effect.exit(TaskDispatchPolicy.revalidate(dependencies, prepared)))).toBe(true)
      expect(yield* refusal(TaskDispatchPolicy.revalidate(dependencies, prepared))).toMatchObject({
        _tag: "TaskDispatchPolicy.Changed", reason: "permission-denied",
        detail: { action: "task", layer: "agent", rule: { action: "task", resource: "*", effect: "deny" } },
      })
      expect((yield* refusal(TaskDispatchPolicy.revalidate(dependencies, prepared))).message).toBe(
        "Task dispatch refused: the parent session's permission policy denies task (rule task/*: deny from the parent agent's rules)")
      expect(Exit.isFailure(yield* Effect.exit(TaskDispatchPolicy.capture(dependencies, { parentID, parentAgent: build, childAgent: worker })))).toBe(true)
      denyDispatch = false
      yield* agents.update((editor) => editor.update(worker, (agent) => { agent.system = "changed" }))
      expect(Exit.isFailure(yield* Effect.exit(TaskDispatchPolicy.revalidate(dependencies, prepared)))).toBe(true)
      expect(yield* refusal(TaskDispatchPolicy.revalidate(dependencies, prepared))).toMatchObject({
        reason: "snapshot-changed", detail: { keys: ["childAgent"], paths: ["childAgent.system"] },
      })
      yield* agents.update((editor) => editor.update(worker, (agent) => { delete agent.system }))
      expect(Exit.isSuccess(yield* Effect.exit(TaskDispatchPolicy.revalidate(dependencies, prepared)))).toBe(true)
      yield* registry.register({ read: Tool.make({
        description: "changed fixture", input: Schema.Struct({ extra: Schema.String }),
        output: Schema.Struct({ ok: Schema.Boolean }), execute: () => Effect.succeed({ ok: true }),
      }) })
      expect(Exit.isFailure(yield* Effect.exit(TaskDispatchPolicy.revalidate(dependencies, prepared)))).toBe(true)
      expect(yield* refusal(TaskDispatchPolicy.revalidate(dependencies, prepared))).toMatchObject({
        reason: "snapshot-changed", detail: { keys: ["parentTools", "childTools"] },
      })
      expect(Exit.isFailure(yield* Effect.exit(TaskDispatchPolicy.revalidate(dependencies, {})))).toBe(true)
      expect(yield* refusal(TaskDispatchPolicy.revalidate(dependencies, {}))).toMatchObject({ reason: "snapshot-unknown" })
    }),
  )
})
