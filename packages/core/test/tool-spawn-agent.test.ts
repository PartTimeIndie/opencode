import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { CapabilityLease } from "@opencode-ai/core/capability/lease"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SpawnAgentTool } from "@opencode-ai/core/tool/spawn-agent"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { testEffect } from "./lib/effect"
import { settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const parentID = SessionSchema.ID.make("ses_spawn_parent")
const childID = SessionSchema.ID.make("ses_spawn_child")
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const messageModel = ModelV2.Ref.make({
  id: ModelV2.ID.make("gpt-5.6-sol"),
  providerID: ProviderV2.ID.make("openai"),
  variant: ModelV2.VariantID.make("high"),
})
const sessionModel = ModelV2.Ref.make({
  id: ModelV2.ID.make("glm-5.3"),
  providerID: ProviderV2.ID.make("zhipuai-coding-plan"),
})
let parent = sessionInfo(parentID, {
  metadata: { access_control: { mode: "approve_for_me" } },
})
const assistant = new SessionMessage.Assistant({
  id: toolIdentity.assistantMessageID,
  type: "assistant",
  agent: toolIdentity.agent,
  model: messageModel,
  content: [],
  time: { created: DateTime.makeUnsafe(0) },
})
const created: SessionV2.CreateInput[] = []
const prompts: Parameters<SessionV2.Interface["prompt"]>[0][] = []
const resumed: SessionSchema.ID[] = []
const permissionAssertions: PermissionV2.AssertInput[] = []
let approval: Deferred.Deferred<void, PermissionV2.DeclinedError> | undefined
let asked: Deferred.Deferred<void> | undefined
let capabilitySnapshot: Record<string, number> = { spawn_agent: 1 }
let agentInfo: AgentV2.Info | undefined

const agents = Layer.succeed(
  AgentV2.Service,
  AgentV2.Service.of({
    transform: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    get: (id) => Effect.succeed(agentInfo ?? AgentV2.Info.empty(id)),
    default: () => Effect.die("unused"),
    resolve: () => Effect.die("unused"),
    select: () => Effect.die("unused"),
    all: () => Effect.die("unused"),
  }),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.gen(function* () {
      permissionAssertions.push(input)
      if (asked) yield* Deferred.succeed(asked, undefined)
      if (approval) yield* Deferred.await(approval)
    }),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const capabilities = Layer.succeed(
  CapabilityLease.Service,
  CapabilityLease.Service.of({
    activate: () => Effect.die("unused"),
    snapshot: () => Effect.succeed(capabilitySnapshot),
    valid: () => Effect.succeed(true),
    revoke: () => Effect.die("unused"),
  }),
)
const sessions = Layer.succeed(
  SessionV2.Service,
  SessionV2.Service.of({
    create: (input) =>
      Effect.sync(() => {
        created.push(input)
        return sessionInfo(childID, {
          title: input.title,
          agent: input.agent,
          model: input.model,
          metadata: input.metadata,
        })
      }),
    get: (id) =>
      id === parentID ? Effect.succeed(parent) : Effect.fail(new SessionV2.NotFoundError({ sessionID: id })),
    message: (input) => Effect.succeed(input.messageID === assistant.id ? assistant : undefined),
    prompt: (input) =>
      Effect.sync(() => {
        prompts.push(input)
        return new SessionInput.Admitted({
          admittedSeq: prompts.length,
          id: SessionMessage.ID.make(`msg_spawn_prompt_${prompts.length}`),
          sessionID: input.sessionID,
          prompt: input.prompt,
          delivery: input.delivery ?? "steer",
          timeCreated: DateTime.makeUnsafe(0),
        })
      }),
    resume: (id) => Effect.sync(() => resumed.push(id)),
    list: () => Effect.die("unused"),
    messages: () => Effect.die("unused"),
    messageContext: () => Effect.die("unused"),
    context: () => Effect.die("unused"),
    events: () => Stream.die("unused"),
    switchAgent: () => Effect.die("unused"),
    heldInputs: () => Effect.die("unused"),
    releaseInput: () => Effect.die("unused"),
    switchModel: () => Effect.die("unused"),
    switchAgentAndPrompt: () => Effect.die("unused"),
    setTitle: () => Effect.die("unused"),
    patchMetadata: () => Effect.die("unused"),
    setShare: () => Effect.die("unused"),
    setSummary: () => Effect.die("unused"),
    synthetic: () => Effect.die("unused"),
    revert: () => Effect.die("unused"),
    rollback: () => Effect.die("unused"),
    unrevert: () => Effect.die("unused"),
    cleanupRevert: () => Effect.die("unused"),
    shell: () => Effect.die("unused"),
    skill: () => Effect.die("unused"),
    compact: () => Effect.die("unused"),
    wait: () => Effect.die("unused"),
    interrupt: () => Effect.die("unused"),
  }),
)
const background = BackgroundJob.defaultLayer
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission), Layer.provide(capabilities))
const spawn = SpawnAgentTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(permission),
  Layer.provide(agents),
  Layer.provide(sessions),
  Layer.provide(background),
)
const it = testEffect(Layer.mergeAll(permission, agents, sessions, background, registry, capabilities, spawn))

const reset = () => {
  created.length = 0
  prompts.length = 0
  resumed.length = 0
  permissionAssertions.length = 0
  approval = undefined
  asked = undefined
  capabilitySnapshot = { spawn_agent: 1 }
  agentInfo = undefined
  parent = sessionInfo(parentID, {
    metadata: { access_control: { mode: "approve_for_me" } },
  })
}

describe("SpawnAgentTool", () => {
  it.effect("keeps Ask visible, waits for each approval and never creates a session after rejection", () =>
    Effect.gen(function* () {
      reset()
      const tools = yield* ToolRegistry.Service
      const materialized = yield* tools.materialize(
        [{ action: "spawn_agent", resource: "*", effect: "ask" }],
        { mode: "explicit", entries: { spawn_agent: { visible: true, permission: "ask" } } },
        { sessionID: parentID, agent: toolIdentity.agent },
      )
      expect(materialized.definitions.map((tool) => tool.name)).toEqual(["spawn_agent"])
      for (const allow of [true, false]) {
        approval = yield* Deferred.make<void, PermissionV2.DeclinedError>()
        asked = yield* Deferred.make<void>()
        const call = yield* materialized.settle({
          ...toolIdentity,
          sessionID: parentID,
          call: { type: "tool-call", id: `call_click_${allow}`, name: "spawn_agent", input: { prompt: "test approval" } },
        }).pipe(Effect.forkScoped)
        yield* Deferred.await(asked)
        expect(created).toHaveLength(allow ? 0 : 1)
        expect(prompts).toHaveLength(allow ? 0 : 1)
        if (allow) yield* Deferred.succeed(approval, undefined)
        if (!allow) yield* Deferred.fail(approval, new PermissionV2.DeclinedError())
        const result = yield* Fiber.join(call)
        if (allow) {
          expect(result.output?.structured).toMatchObject({ sessionID: childID, state: "running" })
          yield* (yield* BackgroundJob.Service).wait({ id: childID, timeout: 1_000 })
        }
        if (!allow) expect(result.result).toEqual({ type: "error", value: "Permission denied: spawn_agent" })
      }
      expect(created).toHaveLength(1)
      expect(prompts).toHaveLength(1)
      expect(resumed).toEqual([childID])
      expect(permissionAssertions).toHaveLength(2)
      for (const assertion of permissionAssertions) {
        expect(assertion.metadata?.[PermissionV2.SINGLE_USE_METADATA_KEY]).toBe(true)
        expect(assertion.save).toBeUndefined()
      }
    }),
  )

  it.effect("creates and starts a normal background session with inherited defaults", () =>
    Effect.gen(function* () {
      reset()
      const tools = yield* ToolRegistry.Service
      const jobs = yield* BackgroundJob.Service

      const result = yield* settleTool(tools, {
        ...toolIdentity,
        sessionID: parentID,
        call: {
          type: "tool-call",
          id: "call_spawn",
          name: SpawnAgentTool.name,
          input: { prompt: "implement the selected card", title: "Selected card" },
        },
      })
      expect(result.output?.structured).toMatchObject({ sessionID: childID, state: "running" })

      const job = yield* jobs.wait({ id: childID, timeout: 1_000 })
      expect(job.timedOut).toBe(false)
      expect(job.info?.status).toBe("completed")
      expect(permissionAssertions[0]).toMatchObject({ action: "spawn_agent", resources: ["*"] })
      // Session creation is its own authorization: the assertion is single-use
      // and must never be savable as a remembered rule.
      expect(permissionAssertions[0].save).toBeUndefined()
      expect(permissionAssertions[0].metadata?.["$opencode.permission.single_use"]).toBe(true)
      expect(created[0]).toMatchObject({
        title: "Selected card",
        agent: toolIdentity.agent,
        model: messageModel,
        location,
        metadata: {
          access_control: { mode: "approve_for_me" },
          opencode_spawn_agent: {
            sourceSessionID: parentID,
            sourceMessageID: toolIdentity.assistantMessageID,
          },
        },
      })
      expect(created[0]?.parentID).toBeUndefined()
      expect(prompts[0]).toMatchObject({ sessionID: childID, agent: toolIdentity.agent, model: messageModel, resume: false })
      expect(prompts[0]?.prompt.text).toBe("implement the selected card")
      expect(resumed).toEqual([childID])
    }),
  )

  it.effect("defaults the spawned session to the parent session's current model", () =>
    Effect.gen(function* () {
      reset()
      parent = sessionInfo(parentID, {
        model: sessionModel,
        metadata: { access_control: { mode: "approve_for_me" } },
      })
      const tools = yield* ToolRegistry.Service
      const jobs = yield* BackgroundJob.Service

      yield* settleTool(tools, {
        ...toolIdentity,
        sessionID: parentID,
        call: {
          type: "tool-call",
          id: "call_spawn_session_model",
          name: SpawnAgentTool.name,
          input: { prompt: "use the session model" },
        },
      })
      yield* jobs.wait({ id: childID, timeout: 1_000 })
      expect(created[0]?.model).toEqual(sessionModel)
      expect(prompts[0]?.model).toEqual(sessionModel)
    }),
  )

  it.effect("applies an explicit model override with variant", () =>
    Effect.gen(function* () {
      reset()
      parent = sessionInfo(parentID, {
        model: sessionModel,
        metadata: { access_control: { mode: "approve_for_me" } },
      })
      const tools = yield* ToolRegistry.Service
      const jobs = yield* BackgroundJob.Service

      yield* settleTool(tools, {
        ...toolIdentity,
        sessionID: parentID,
        call: {
          type: "tool-call",
          id: "call_spawn_override",
          name: SpawnAgentTool.name,
          input: {
            prompt: "override the model",
            model: "zhipuai-coding-plan/glm-5.3",
            variant: "high",
          },
        },
      })
      yield* jobs.wait({ id: childID, timeout: 1_000 })
      expect(created[0]?.model).toEqual({
        id: ModelV2.ID.make("glm-5.3"),
        providerID: ProviderV2.ID.make("zhipuai-coding-plan"),
        variant: ModelV2.VariantID.make("high"),
      })
      expect(prompts[0]?.model).toEqual(created[0]?.model)
    }),
  )

  it.effect("rejects a model override outside the configured session models and chains", () =>
    Effect.gen(function* () {
      reset()
      parent = sessionInfo(parentID, {
        model: sessionModel,
        metadata: { access_control: { mode: "approve_for_me" } },
      })
      const tools = yield* ToolRegistry.Service

      const result = yield* settleTool(tools, {
        ...toolIdentity,
        sessionID: parentID,
        call: {
          type: "tool-call",
          id: "call_spawn_unconfigured",
          name: SpawnAgentTool.name,
          input: { prompt: "override the model", model: "openai/gpt-5.5" },
        },
      })

      expect(result.result).toEqual({
        type: "error",
        value: expect.stringContaining("openai/gpt-5.5 is not configured"),
      })
      expect((result.result as { value: string }).value).toContain("zhipuai-coding-plan/glm-5.3")
      expect(created).toEqual([])
      expect(prompts).toEqual([])
    }),
  )

  it.effect("activates a configured fallback chain step for a spawned session", () =>
    Effect.gen(function* () {
      reset()
      const sol = {
        id: ModelV2.ID.make("gpt-5.6-sol"),
        providerID: ProviderV2.ID.make("openai"),
      }
      parent = sessionInfo(parentID, {
        model: {
          ...sessionModel,
          chain: {
            id: "repo-chain",
            name: "Repo chain",
            active: 0,
            steps: [sessionModel, sol],
          },
        },
        metadata: { access_control: { mode: "approve_for_me" } },
      })
      const tools = yield* ToolRegistry.Service
      const jobs = yield* BackgroundJob.Service

      yield* settleTool(tools, {
        ...toolIdentity,
        sessionID: parentID,
        call: {
          type: "tool-call",
          id: "call_spawn_chain_step",
          name: SpawnAgentTool.name,
          input: { prompt: "run on the fallback model", model: "openai/gpt-5.6-sol" },
        },
      })
      yield* jobs.wait({ id: childID, timeout: 1_000 })

      expect(created[0]?.model).toMatchObject(sol)
      expect(created[0]?.model?.chain).toMatchObject({ active: 1 })
      expect(created[0]?.model?.chain?.steps.map((step) => String(step.id))).toEqual(["glm-5.3", "gpt-5.6-sol"])
      expect(prompts[0]?.model).toEqual(created[0]?.model)
    }),
  )

  it.effect("extends the model policy with the configured agent model chain", () =>
    Effect.gen(function* () {
      reset()
      const sol = { id: ModelV2.ID.make("gpt-5.6-sol"), providerID: ProviderV2.ID.make("openai") }
      const luna = { id: ModelV2.ID.make("gpt-5.6-luna"), providerID: ProviderV2.ID.make("openai") }
      agentInfo = new AgentV2.Info({
        id: toolIdentity.agent,
        model: { ...sol, chain: { id: "agent-chain", name: "Agent chain", active: 0, steps: [sol, luna] } },
        request: { headers: {}, body: {} },
        mode: "all",
        hidden: false,
        permissions: [],
      })
      parent = sessionInfo(parentID, {
        model: sessionModel,
        metadata: { access_control: { mode: "approve_for_me" } },
      })
      const tools = yield* ToolRegistry.Service
      const jobs = yield* BackgroundJob.Service

      yield* settleTool(tools, {
        ...toolIdentity,
        sessionID: parentID,
        call: {
          type: "tool-call",
          id: "call_spawn_agent_policy",
          name: SpawnAgentTool.name,
          input: { prompt: "run on the agent chain", model: "openai/gpt-5.6-luna" },
        },
      })
      yield* jobs.wait({ id: childID, timeout: 1_000 })

      expect(created[0]?.model).toMatchObject(luna)
      expect(created[0]?.model?.chain).toMatchObject({ active: 1 })
      expect(created[0]?.model?.chain?.steps.map((step) => String(step.id))).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"])
      expect(prompts[0]?.model).toEqual(created[0]?.model)
    }),
  )

  it.effect("defaults to the spawning session model grafted onto the agent chain", () =>
    Effect.gen(function* () {
      reset()
      const sol = { id: ModelV2.ID.make("gpt-5.6-sol"), providerID: ProviderV2.ID.make("openai") }
      const luna = { id: ModelV2.ID.make("gpt-5.6-luna"), providerID: ProviderV2.ID.make("openai") }
      agentInfo = new AgentV2.Info({
        id: toolIdentity.agent,
        model: { ...sol, chain: { id: "agent-chain", name: "Agent chain", active: 0, steps: [sol, luna] } },
        request: { headers: {}, body: {} },
        mode: "all",
        hidden: false,
        permissions: [],
      })
      parent = sessionInfo(parentID, {
        model: sessionModel,
        metadata: { access_control: { mode: "approve_for_me" } },
      })
      const tools = yield* ToolRegistry.Service
      const jobs = yield* BackgroundJob.Service

      yield* settleTool(tools, {
        ...toolIdentity,
        sessionID: parentID,
        call: {
          type: "tool-call",
          id: "call_spawn_agent_policy_default",
          name: SpawnAgentTool.name,
          input: { prompt: "keep the session model" },
        },
      })
      yield* jobs.wait({ id: childID, timeout: 1_000 })

      expect(created[0]?.model).toMatchObject(sessionModel)
      expect(created[0]?.model?.chain?.steps.map((step) => String(step.id))).toEqual(["glm-5.3", "gpt-5.6-luna"])
      expect(prompts[0]?.model).toEqual(created[0]?.model)
    }),
  )

  it.effect("keeps spawn_agent hidden without an active capability lease", () =>
    Effect.gen(function* () {
      reset()
      capabilitySnapshot = {}
      const tools = yield* ToolRegistry.Service
      const definitions = yield* toolDefinitions(tools, undefined, undefined, {
        sessionID: parentID,
        agent: toolIdentity.agent,
      })
      expect(definitions.some((tool) => tool.name === SpawnAgentTool.name)).toBe(false)

      const result = yield* settleTool(tools, {
        ...toolIdentity,
        sessionID: parentID,
        call: {
          type: "tool-call",
          id: "call_spawn_hidden",
          name: SpawnAgentTool.name,
          input: { prompt: "should not spawn" },
        },
      })
      expect(result.result).toMatchObject({ type: "error", value: "Unknown tool: spawn_agent" })
      expect(created).toEqual([])
    }),
  )
})

function sessionInfo(id: SessionSchema.ID, input: Partial<SessionSchema.Info> = {}) {
  return new SessionSchema.Info({
    id,
    projectID: ProjectV2.ID.make("project"),
    agent: input.agent,
    model: input.model,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    title: input.title ?? "Session",
    metadata: input.metadata,
    location,
  })
}
