import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AgentV2 } from "@opencode-ai/core/agent"
import { CapabilityLease } from "@opencode-ai/core/capability/lease"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { SessionV2 } from "@opencode-ai/core/session"
import { SkillV2 } from "@opencode-ai/core/skill"
import { BrowserTool } from "@opencode-ai/core/tool/browser"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { capabilitySnapshotChanged } from "@opencode-ai/core/session/runner/llm"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_skill_capability")
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({ skill_capabilities: { "computer-use": ["browser_read"] } }),
        }),
      ]),
  }),
)
const leases = CapabilityLease.layer.pipe(Layer.provide(config))
const permission = Layer.mock(PermissionV2.Service, {
  assert: () => Effect.void,
  materializationRules: () => Effect.succeed([]),
})
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission), Layer.provide(leases))
const bridge = BrowserTool.bridgeLayer({
  action: async () => ({
    url: "https://example.test/",
    title: "Example",
    text: "Example",
    accessibility: "",
    elements: [],
    evidence: { console: [], network: [] },
  }),
})
const browser = BrowserTool.layer.pipe(Layer.provide(registry), Layer.provide(permission), Layer.provide(bridge))
const boot = Layer.succeed(
  PluginBoot.Service,
  PluginBoot.Service.of({ wait: () => Effect.void, refreshMcpCommands: () => Effect.void }),
)
const skills = Layer.succeed(
  SkillV2.Service,
  SkillV2.Service.of({
    transform: () => Effect.die("unused"),
    sources: () => Effect.die("unused"),
    list: () =>
      Effect.succeed([
        new SkillV2.Info({
          name: "computer-use",
          requestedCapabilities: ["browser_read", "browser_write"],
          location: AbsolutePath.make("/builtin/computer-use.md"),
          content: "Use Browser tools only within the active lease.",
        }),
      ]),
  }),
)
const skill = SkillTool.layer.pipe(
  Layer.provide(Database.layerFromPath(":memory:")),
  Layer.provide(registry),
  Layer.provide(permission),
  Layer.provide(leases),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(boot),
  Layer.provide(skills),
)
const layer = Layer.mergeAll(config, leases, permission, registry, bridge, browser, boot, skills, skill)
const it = testEffect(layer)

describe("Skill capability activation", () => {
  test("detects only a real capability snapshot change for continuation rebuilds", () => {
    expect(capabilitySnapshotChanged({}, {})).toBe(false)
    expect(capabilitySnapshotChanged({ browser_read: 1 }, { browser_read: 1 })).toBe(false)
    expect(capabilitySnapshotChanged({ browser_read: 1 }, { browser_read: 2 })).toBe(false)
    expect(capabilitySnapshotChanged({}, { browser_read: 1, browser_write: 2 })).toBe(true)
    expect(capabilitySnapshotChanged({ browser_read: 1 }, { browser_read: 1, browser_write: 2 })).toBe(true)
  })

  test("explains when the host has not authorized a skill capability", () => {
    const error = new CapabilityLease.DeniedError({
      skill: "computer-use",
      capability: "browser_read",
      message: "Skill 'computer-use' is not authorized to activate its requested capabilities",
    })

    expect(SkillTool.loadFailureMessage("computer-use", error)).toBe(
      "Unable to load skill computer-use: Skill 'computer-use' is not authorized to activate its requested capabilities",
    )
  })

  it.effect("keeps Browser tools hidden until an explicit skill call and activates only the host-granted subset", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const context = { sessionID, agent: toolIdentity.agent }
      const rules: PermissionV2.Ruleset = [
        { action: "browser_read", resource: "*", effect: "allow" },
        { action: "browser_write", resource: "*", effect: "deny" },
      ]
      const before = (yield* registry.materialize(rules, undefined, context)).definitions.map((tool) => tool.name)
      expect(before).not.toContain("browser_snapshot")
      expect(before).not.toContain("browser_click")

      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-computer-use", name: "skill", input: { name: "computer-use" } },
      })
      expect(result.type).toBe("text")
      if (result.type === "text") expect(result.value).toContain("<capability>browser_read</capability>")

      const after = (yield* registry.materialize(rules, undefined, context)).definitions.map((tool) => tool.name)
      expect(after).toContain("browser_snapshot")
      expect(after).toContain("browser_wait")
      expect(after).not.toContain("browser_click")
      expect(after).not.toContain("browser_type")
      expect(after).not.toContain("browser_navigate")

      const other = (
        yield* registry.materialize(rules, undefined, {
          sessionID: SessionV2.ID.make("ses_skill_capability_other"),
          agent: AgentV2.ID.make("build"),
        })
      ).definitions.map((tool) => tool.name)
      expect(other).not.toContain("browser_snapshot")
    }),
  )
})
