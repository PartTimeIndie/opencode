import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PermissionV2 } from "@opencode-ai/core/permission"
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
  test("decodes retired source identity without delegating historical provider schemas", () => {
    const historical = Schema.decodeUnknownSync(SessionAgentPolicy.Info)({
      tools: { mode: "explicit", entries: { read: { visible: true, permission: "allow" } } },
      permissionLayers: [],
      source: { type: "orchestrator", sessionID: "ses_historical", agent: parent.id },
      cacheTools: [],
    })
    expect(historical.source.type).toBe("orchestrator")
    expect(historical.cacheTools).toEqual([])
    const native = SessionAgentPolicy.derive({
      parent: historical,
      parentSessionID: "ses_parent",
      parentAgent: parent,
      parentDelegableTools: ["read"],
      childTools: ["read"],
      type: "task",
    })
    expect(native.source.type).toBe("task")
    expect(native.cacheTools).toBeUndefined()
  })

  test("readonly requires both a tool ceiling and a separate deny layer, bound to its input", () => {
    const original = SessionAgentPolicy.derive({
      parent: undefined, parentSessionID: "ses_parent", parentAgent: parent,
      parentDelegableTools: ["read", "grep", "glob", "bash", "write", "plugin_write"],
      childTools: ["read", "grep", "glob", "bash", "write", "plugin_write"], type: "task",
    })
    const policy = SessionAgentPolicy.restrictReadOnly(original, "msg_readonly")
    expect(SessionAgentPolicy.isReadOnly(policy)).toBe(true)
    expect(policy.readOnlyInputID).toBe("msg_readonly")
    expect(Object.keys(policy.tools.entries)).toEqual(["read", "grep", "glob"])
    expect(Object.keys(original.tools.entries)).toContain("bash")
    const ceiling = policy.permissionLayers.at(-1) ?? []
    for (const action of ["bash", "write", "edit", "apply_patch", "plugin_write", "task", "unknown"]) {
      expect(PermissionV2.evaluate(action, "anything", ceiling).effect).toBe("deny")
    }
    expect(PermissionV2.evaluate("read", "anything", ceiling).effect).toBe("allow")
    expect(policy.permissionLayers[0]).toEqual(parent.permissions)
    expect(SessionAgentPolicy.isReadOnly({ ...original, readOnly: true })).toBe(false)
    expect(SessionAgentPolicy.isReadOnly({ ...policy, readOnlyInputID: undefined })).toBe(false)
    expect(SessionAgentPolicy.isReadOnly({ ...policy, tools: original.tools })).toBe(false)
    expect(SessionAgentPolicy.isReadOnly({ ...policy, permissionLayers: original.permissionLayers })).toBe(false)
  })

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

  test("does not inherit a parent's physical execution placement", () => {
    const inherited = SessionAgentPolicy.derive({
      parent: undefined, parentSessionID: "ses_root", parentAgent: parent,
      parentDelegableTools: ["read"], childTools: ["read"], type: "task",
    })
    const bound = Schema.decodeUnknownSync(SessionAgentPolicy.Info)({ ...inherited,
      executionPlacement: { version: 1, directory: "/parent", checkout: "/parent", identity: "parent-only" },
      mainWriteConsent: { version: 1, permissionID: "per_parent", inputID: "msg_parent", dispatchDigest: "a".repeat(64), placementIdentity: "parent-only" },
    })
    expect(SessionAgentPolicy.derive({
      parent: bound, parentSessionID: "ses_child", parentAgent: parent,
      parentDelegableTools: ["read"], childTools: ["read"], type: "task",
    }).executionPlacement).toBeUndefined()
    expect(bound.executionPlacement?.identity).toBe("parent-only")
    expect(SessionAgentPolicy.derive({
      parent: bound, parentSessionID: "ses_child", parentAgent: parent,
      parentDelegableTools: ["read"], childTools: ["read"], type: "task",
    }).mainWriteConsent).toBeUndefined()
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
