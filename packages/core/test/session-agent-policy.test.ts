import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionAgentPolicy } from "@opencode-ai/core/session/agent-policy"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { testEffect } from "./lib/effect"

const parent = new AgentV2.Info({
  id: AgentV2.ID.make("parent"),
  request: { headers: {}, body: {} },
  mode: "all",
  hidden: false,
  permissions: [{ action: "edit", resource: "*", effect: "ask" }],
})

describe("SessionAgentPolicy", () => {
  test("keeps only tools available to both parent and child", () => {
    const policy = SessionAgentPolicy.derive({
      parent: undefined,
      parentSessionID: "ses_parent",
      parentAgent: parent,
      parentDelegableTools: ["read", "task"],
      childTools: ["read", "write", "task"],
      type: "task",
    })

    expect(policy.tools).toEqual({
      mode: "explicit",
      entries: {
        read: { visible: true, permission: "allow" },
        task: { visible: true, permission: "allow" },
      },
    })
    expect(policy.permissionLayers).toEqual([parent.permissions])
    expect(policy.permissionLayers[0]).not.toBe(parent.permissions)
    expect(policy.permissionLayers[0]?.[0]).not.toBe(parent.permissions[0])
    expect(policy.source).toEqual({ type: "task", sessionID: "ses_parent", agent: parent.id })
  })

  test("preserves every inherited permission ceiling for nested subagents", () => {
    const inherited = SessionAgentPolicy.derive({
      parent: undefined,
      parentSessionID: "ses_root",
      parentAgent: parent,
      parentDelegableTools: ["read"],
      childTools: ["read"],
      type: "task",
    })
    const child = new AgentV2.Info({
      id: AgentV2.ID.make("child"),
      request: { headers: {}, body: {} },
      mode: "subagent",
      hidden: false,
      permissions: [{ action: "read", resource: "*", effect: "allow" }],
    })

    expect(
      SessionAgentPolicy.derive({
        parent: inherited,
        parentSessionID: "ses_child",
        parentAgent: child,
        parentDelegableTools: ["read"],
        childTools: ["read", "write"],
        type: "spawn_agent",
      }).permissionLayers,
    ).toEqual([parent.permissions, child.permissions])
  })

  testEffect(ToolRegistry.defaultLayer).effect("materializes only the inherited tool intersection", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tool = Tool.make({
        description: "test",
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        execute: () => Effect.succeed({}),
        toModelOutput: () => [],
      })
      yield* registry.register({ read: tool, write: tool })
      const policy = SessionAgentPolicy.derive({
        parent: undefined,
        parentSessionID: "ses_parent",
        parentAgent: parent,
        parentDelegableTools: ["read"],
        childTools: ["read", "write"],
        type: "task",
      })

      expect((yield* registry.materialize([], policy.tools)).definitions.map((definition) => definition.name)).toEqual([
        "read",
      ])
    }),
  )

  testEffect(ToolRegistry.defaultLayer).effect("materializes hidden tools only for delegation when opted in", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tool = Tool.make({
        description: "test",
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        execute: () => Effect.succeed({}),
        toModelOutput: () => [],
      })
      yield* registry.register({ read: tool, write: tool, task: tool })
      const policy = {
        mode: "explicit" as const,
        entries: {
          "*": { visible: false, delegable: true, permission: "allow" as const },
          task: { visible: true, delegable: true, permission: "allow" as const },
        },
      }

      expect((yield* registry.materialize([], policy)).definitions.map((definition) => definition.name)).toEqual([
        "task",
      ])
      expect(
        (yield* registry.materialize([], SessionAgentPolicy.delegable(policy))).definitions.map(
          (definition) => definition.name,
        ),
      ).toEqual(["read", "write", "task"])
    }),
  )
})
