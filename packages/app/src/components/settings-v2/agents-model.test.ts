import { describe, expect, test } from "bun:test"
import type { Config, PermissionConfig } from "@opencode-ai/sdk/v2/client"
import type { ConfigurableAgent } from "./agents-model"
import {
  configuredAgents,
  completionPolicy,
  instructionPolicy,
  effectiveToolPermissionAction,
  filterToolCatalog,
  isCatalogToolVisible,
  isToolAvailable,
  materializeToolEntries,
  newAgentID,
  normalizeAgentID,
  saveAgent,
  setAgentToolEntry,
  setAgentToolProjectPermission,
  projectPermission,
  setToolAvailability,
  setToolPermission,
  toolPermissionAction,
  systemPolicy,
  toolEntry,
  toolPolicy,
  normalizeToolCatalog,
  permissionMap,
  agentSkills,
  setAgentSkillEntry,
} from "./agents-model"

describe("agent skill policy model", () => {
  test("stores sparse field overrides and drops emptied entries", () => {
    const agent: ConfigurableAgent = { tools: { mode: "inherit", entries: {} } }
    const first = setAgentSkillEntry(agent, "effect", { invocation: "ask" })
    expect(agentSkills(first)).toEqual({ effect: { invocation: "ask" } })
    const second = setAgentSkillEntry(first, "effect", { visible: false })
    expect(agentSkills(second)).toEqual({ effect: { visible: false, invocation: "ask" } })
    // Inherit removes exactly that field.
    const third = setAgentSkillEntry(second, "effect", { visible: undefined })
    expect(agentSkills(third)).toEqual({ effect: { invocation: "ask" } })
    const cleared = setAgentSkillEntry(third, "effect", { invocation: undefined })
    expect(agentSkills(cleared)).toEqual({})
    expect(cleared.skills).toBeUndefined()
  })

  test("keeps other skills and unrelated fields untouched", () => {
    const agent: ConfigurableAgent = {
      description: "kept",
      tools: { mode: "explicit", entries: { bash: { visible: true, permission: "allow" } } },
      skills: { effect: { invocation: "deny" }, other: { visible: true } },
    }
    const changed = setAgentSkillEntry(agent, "effect", { invocation: "allow" })
    expect(agentSkills(changed)).toEqual({ effect: { invocation: "allow" }, other: { visible: true } })
    expect(changed.description).toBe("kept")
    expect(changed.tools).toEqual({ mode: "explicit", entries: { bash: { visible: true, permission: "allow" } } })
    // saveAgent carries sparse overrides through the stored agent shape.
    const saved = saveAgent("reviewer", changed)
    const stored = (saved.agent as Record<string, Record<string, unknown>>).reviewer
    expect(stored.skills).toEqual({ effect: { invocation: "allow" }, other: { visible: true } })
  })
})

describe("agent settings model", () => {
  test("keeps scoped tool metadata through permission changes and explicit materialization", () => {
    const agent = { tools: { mode: "explicit" as const, entries: { image_generate: { visible: true, permission: "ask" as const, scope: { mode: "projects" as const, projects: ["C:/Projects/PU"] }, projectPermissions: { "c:\\projects\\pu\\": "deny" as const } } } } }
    const changed = setAgentToolEntry(agent, "image_generate", { visible: true, permission: "allow" })
    expect(toolEntry(materializeToolEntries(changed, ["image_generate"]), "image_generate")).toMatchObject({ scope: { mode: "projects", projects: ["C:/Projects/PU"] }, projectPermissions: { "c:\\projects\\pu\\": "deny" } })
    const allowed = setAgentToolProjectPermission(changed, "image_generate", "C:/Projects/PU", "allow")
    expect(projectPermission(toolEntry(allowed, "image_generate"), "c:\\projects\\pu")).toBe("allow")
    expect(toolEntry(setAgentToolProjectPermission(allowed, "image_generate", "c:\\projects\\pu", "inherit"), "image_generate").projectPermissions).toBeUndefined()
  })
  test("normalizes user-facing names into stable config ids", () => {
    expect(normalizeAgentID("  PU Knowledge Agent  ")).toBe("pu-knowledge-agent")
    expect(normalizeAgentID("Agent_2")).toBe("agent_2")
  })

  test("reads and updates simple tool permissions without losing other rules", () => {
    const bash = { "git status": "allow", "*": "deny" } as const
    const permission = { "*": "deny", read: "allow", bash } as PermissionConfig
    expect(toolPermissionAction(permission, "read")).toBe("allow")
    expect(toolPermissionAction(permission, "edit")).toBe("inherit")
    expect(toolPermissionAction(permission, "bash")).toBe("custom")
    expect(setToolPermission(permission, "read", "inherit")).toEqual({ "*": "deny", bash })
    expect(setToolPermission(permission, "grep", "allow")).toEqual({ "*": "deny", read: "allow", bash, grep: "allow" })
  })

  test("separates tool availability from approval behavior", () => {
    const permission = { "*": "deny" as const, read: "allow" as const }
    expect(isToolAvailable(permission, "read")).toBe(true)
    expect(isToolAvailable(permission, "bash")).toBe(false)
    expect(effectiveToolPermissionAction(permission, "read")).toBe("allow")
    expect(effectiveToolPermissionAction(permission, "bash")).toBe("deny")

    const enabled = setToolAvailability(permission, "bash", true)
    expect(enabled).toEqual({ "*": "deny", read: "allow", bash: "ask" })
    expect(setToolAvailability(enabled, "read", false)).toEqual({ "*": "deny", read: "deny", bash: "ask" })
  })

  test("creates a targeted agent patch without resending existing definitions", () => {
    const config = { agent: { build: { model: "openai/test" } } } as Config
    expect(saveAgent("local", { model: "crng-local/gpt-oss" })).toEqual({
      agent: {
        local: { model: "crng-local/gpt-oss" },
      },
    })
    expect(configuredAgents(config).map((item) => item.id)).toEqual(["build"])
    expect(newAgentID({ agent: { "new-agent": {}, "new-agent-2": {} } } as Config)).toBe("new-agent-3")
  })

  test("retains a chain target when resolving a built-in agent", () => {
    const config = { agent: { plan: { model: "chain:planning" } } } as Config
    const [agent] = configuredAgents(config, [{ name: "plan", mode: "primary", model: { providerID: "openai", modelID: "astra" } }])
    expect(agent.config.model).toBe("chain:planning")
    expect(saveAgent("plan", { model: agent.config.model })).toMatchObject({ agent: { plan: { model: "chain:planning" } } })
  })

  test("keeps a direct runtime model when its chain is explicitly null", () => {
    const [agent] = configuredAgents({} as Config, [
      { name: "build", mode: "primary", model: { providerID: "openai", modelID: "gpt-5.6-sol", chain: null } },
    ])
    expect(agent?.config.model).toBe("openai/gpt-5.6-sol")
  })

  test("merges resolved built-ins with configured overrides", () => {
    const config = { agent: { plan: { description: "Configured plan" } } } as Config
    const agents = configuredAgents(config, [
      { name: "build", mode: "primary", description: "Built-in build" },
      { name: "plan", mode: "primary", description: "Built-in plan" },
    ])
    expect(agents.map((item) => item.id)).toEqual(["build", "plan"])
    expect(agents.find((item) => item.id === "build")?.builtIn).toBe(true)
    expect(agents.find((item) => item.id === "plan")?.config.description).toBe("Configured plan")
  })

  test("normalizes legacy and structured agent policies", () => {
    expect(systemPolicy({ system: "legacy prompt" })).toEqual({ mode: "replace", prompt: "legacy prompt" })
    expect(instructionPolicy({})).toEqual({ mode: "inherit" })
    expect(completionPolicy({ completion: { mode: "custom", prompt: "Evaluate" } })).toEqual({
      mode: "custom",
      prompt: "Evaluate",
    })
    expect(toolPolicy({ tools: { read: true, bash: false } })).toEqual({
      mode: "inherit",
      entries: { read: { visible: true }, bash: { visible: false } },
    })
  })

  test("defaults to inheritance even with permissions and keeps single-tool overrides sparse", () => {
    expect(toolPolicy({})).toEqual({ mode: "inherit" })
    expect(toolPolicy({ permission: { edit: "deny" } })).toEqual({ mode: "inherit" })
    const changed = setAgentToolEntry({ permission: { edit: "deny" } }, "bash", { permission: "ask" })
    expect(toolPolicy(changed)).toEqual({ mode: "inherit", entries: { bash: { permission: "ask" } } })
    expect(toolEntry(changed, "edit")).toEqual({ visible: false, permission: "deny" })
    expect(toolEntry(changed, "future_tool").visible).toBe(true)
    const scoped = setAgentToolProjectPermission(changed, "bash", "C:/project", "deny")
    expect(toolPolicy(scoped).mode).toBe("inherit")
    expect(toolPolicy(scoped).entries).not.toHaveProperty("future_tool")
  })

  test("inherits a wildcard restriction while retaining named tool exceptions", () => {
    const agent: ConfigurableAgent = { tools: { mode: "inherit", entries: {
      "*": { visible: false, permission: "deny" }, read: { visible: true, permission: "allow" },
    } } }
    expect(toolEntry(agent, "bash")).toEqual({ visible: false, permission: "deny" })
    expect(toolEntry(agent, "read")).toEqual({ visible: true, permission: "allow" })
    expect(toolPolicy(setAgentToolEntry(agent, "read", { permission: "ask" })).mode).toBe("inherit")
  })

  test("preserves file-backed system and completion prompt sources", () => {
    const agent = {
      system: {
        mode: "replace",
        files: ["prompts/live-bot.md", "C:/Shared/guardrails.prompt"],
      },
      completion: {
        mode: "custom",
        prompt: "Inline evaluator.",
        files: ["prompts/completion.txt"],
      },
    } as ConfigurableAgent

    expect(systemPolicy(agent)).toEqual({
      mode: "replace",
      files: ["prompts/live-bot.md", "C:/Shared/guardrails.prompt"],
    })
    expect(completionPolicy(agent)).toEqual({
      mode: "custom",
      prompt: "Inline evaluator.",
      files: ["prompts/completion.txt"],
    })
  })

  test("stores visibility and permission together without mutating unrelated agent fields", () => {
    const agent = setAgentToolEntry(
      { temperature: 0.2, tools: { mode: "explicit", entries: { read: { visible: true, permission: "ask" } } } },
      "bash",
      { visible: false, permission: "deny" },
    )
    expect(agent.temperature).toBe(0.2)
    expect(toolEntry(agent, "read")).toEqual({ visible: true, permission: "ask" })
    expect(toolEntry(agent, "bash")).toEqual({ visible: false, permission: "deny" })
    expect(toolEntry(agent, "edit")).toEqual({ visible: false, permission: "deny" })
  })

  test("materializes inherited tool state so toggling one tool keeps the others stable", () => {
    const agent = {
      tools: { mode: "inherit" },
      permission: { "*": "allow", edit: "deny" },
    } as ConfigurableAgent
    const materialized = materializeToolEntries(agent, ["read", "edit", "bash"])
    expect(toolPolicy(materialized).mode).toBe("explicit")
    // inherited allow stays visible, denied edit stays hidden
    expect(toolEntry(materialized, "read")).toEqual({ visible: true, permission: "allow" })
    expect(toolEntry(materialized, "bash")).toEqual({ visible: true, permission: "allow" })
    expect(toolEntry(materialized, "edit")).toEqual({ visible: false, permission: "deny" })
    // materializing does not drop unrelated agent fields
    expect(materialized.permission).toEqual({ "*": "allow", edit: "deny" })
  })

  test("keeps explicit PU bot tool changes isolated from hidden catalog tools", () => {
    const bot = {
      tools: {
        mode: "explicit",
        entries: {
          pu_read_query: { visible: true, permission: "allow" },
          crng_game_query: { visible: true, permission: "allow" },
          crng_project_query: { visible: true, permission: "allow" },
          crng_trello_query: { visible: true, permission: "allow" },
          crng_recording_query: { visible: true, permission: "allow" },
        },
      },
    } as ConfigurableAgent
    const materialized = materializeToolEntries(bot, [
      "read",
      "bash",
      "pu_read_query",
      "crng_game_query",
      "crng_project_query",
      "crng_trello_query",
      "crng_recording_query",
    ])
    const changed = setAgentToolEntry(materialized, "crng_trello_query", {
      visible: false,
      permission: "deny",
    })

    expect(toolEntry(changed, "crng_recording_query")).toEqual({ visible: true, permission: "allow" })
    expect(toolEntry(changed, "crng_trello_query")).toEqual({ visible: false, permission: "deny" })
    expect(toolEntry(changed, "read")).toEqual({ visible: false, permission: "deny" })
    expect(toolEntry(changed, "bash")).toEqual({ visible: false, permission: "deny" })
  })

  test("uses the migrated structured policy when a persisted legacy tools object is empty", () => {
    const agent = {
      tools: {},
      options: {
        __agentTools: {
          mode: "explicit",
          entries: {
            read: { visible: true, permission: "allow" },
            websearch: { visible: false, permission: "deny" },
          },
        },
      },
      permission: { "*": "deny", read: "allow" },
    } as ConfigurableAgent

    expect(toolPolicy(agent)).toEqual({
      mode: "explicit",
      entries: {
        read: { visible: true, permission: "allow" },
        websearch: { visible: false, permission: "deny" },
      },
    })
    const first = setAgentToolEntry(agent, "glob", { visible: true, permission: "allow" })
    const second = setAgentToolEntry(first, "webfetch", { visible: false, permission: "deny" })
    expect(toolEntry(second, "read")).toEqual({ visible: true, permission: "allow" })
    expect(toolEntry(second, "glob")).toEqual({ visible: true, permission: "allow" })
    expect(toolEntry(second, "websearch")).toEqual({ visible: false, permission: "deny" })
    expect(toolEntry(second, "webfetch")).toEqual({ visible: false, permission: "deny" })
  })

  test("preserves unresolved entries when materializing the current catalog", () => {
    const materialized = materializeToolEntries(
      {
        tools: {
          mode: "inherit",
          entries: { project_only: { visible: false, permission: "deny" } },
        },
      },
      ["read"],
    )
    expect(toolPolicy(materialized).entries?.project_only).toEqual({ visible: false, permission: "deny" })
  })

  test("normalizes resolved tool catalog metadata and project scope", () => {
    expect(
      normalizeToolCatalog([
        { id: "pu.search", description: "Search PU", scope: "location", project: "PU" },
        "read",
      ]),
    ).toEqual([
      { id: "pu.search", description: "Search PU", scope: "location", project: "PU", visible: true },
      { id: "read", scope: "application", visible: true },
    ])
  })

  test("keeps hidden catalog tools searchable so they can be configured", () => {
    const catalog = normalizeToolCatalog([
      { id: "read", description: "Read files", visible: true },
      { id: "computer_use_open", description: "Open Computer Use", visible: false },
    ])

    expect(filterToolCatalog(catalog, "").map((item) => item.id)).toEqual(["computer_use_open", "read"])
    expect(filterToolCatalog(catalog, "computer").map((item) => item.id)).toEqual(["computer_use_open"])
    expect(isCatalogToolVisible({}, catalog[0]!)).toBe(false)
    expect(
      isCatalogToolVisible(
        { tools: { mode: "explicit", entries: { computer_use_open: { visible: true, permission: "ask" } } } },
        catalog[0]!,
      ),
    ).toBe(true)
    const inherited = setAgentToolEntry({}, "computer_use_open", { visible: true, permission: "ask" })
    expect(toolPolicy(inherited).mode).toBe("inherit")
    expect(isCatalogToolVisible(inherited, catalog[0]!)).toBe(true)

    expect(toolEntry(materializeToolEntries({}, catalog), "computer_use_open")).toEqual({
      visible: false,
      permission: "deny",
    })
  })

  test("keeps the unified agent switch disabled until explicitly configured", () => {
    expect(toolEntry({}, "switch_agent")).toEqual({ visible: false, permission: "deny" })
    expect(
      toolEntry(
        { tools: { mode: "explicit", entries: { switch_agent: { visible: true, permission: "allow" } } } },
        "switch_agent",
      ),
    ).toEqual({ visible: true, permission: "allow" })
  })

  test("normalizes legacy agent switch tool and permission entries", () => {
    const agent = {
      tools: {
        mode: "explicit",
        entries: {
          switch_to_plan: { visible: true, permission: "allow" },
          switch_to_build: { visible: false, permission: "deny" },
        },
      },
      permission: {
        switch_to_plan: "allow",
        switch_to_build: "deny",
      },
    } as ConfigurableAgent

    expect(toolPolicy(agent)).toEqual({
      mode: "explicit",
      entries: { switch_agent: { visible: true, permission: "allow" } },
    })
    expect(permissionMap(agent.permission)).toEqual({
      switch_agent: { "*": "deny", plan: "allow", build: "deny" },
    })
    expect(saveAgent("legacy", agent).agent?.legacy).toMatchObject({
      tools: {
        mode: "explicit",
        entries: { switch_agent: { visible: true, permission: "allow" } },
      },
      permission: { switch_agent: { "*": "deny", plan: "allow", build: "deny" } },
    })
  })

  test("migrates legacy switch permissions without inventing an explicit tool policy", () => {
    expect(saveAgent("legacy", { permission: { switch_to_plan: "allow" } }).agent?.legacy).toEqual({
      permission: { switch_agent: { "*": "deny", plan: "allow" } },
      options: undefined,
      tools: undefined,
    })
  })
})
