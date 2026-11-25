import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { SkillPolicy } from "@opencode-ai/core/skill/policy"

const resolved = (input: Parameters<typeof SkillPolicy.resolveForSkill>[0]) => SkillPolicy.resolveForSkill(input)

describe("skill invocation policy resolution", () => {
  test("defaults to visible and allow without any configuration", () => {
    const policy = resolved({ skill: { name: "effect" } })
    expect(policy.visible).toEqual({ value: true, source: "metadata" })
    expect(policy.invocation).toEqual({ value: "allow", source: "metadata" })
  })

  test("legacy manual list forces hidden and manual", () => {
    const policy = resolved({
      skill: { name: "visual-qa-testing" },
      global: { manual: ["visual-qa-testing"] },
    })
    expect(policy.visible).toEqual({ value: false, source: "legacy-manual" })
    expect(policy.invocation).toEqual({ value: "manual", source: "legacy-manual" })
  })

  test("frontmatter manual flag forces hidden and manual", () => {
    const policy = resolved({ skill: { name: "effect", disableModelInvocation: true } })
    expect(policy.visible.value).toBe(false)
    expect(policy.invocation).toEqual({ value: "manual", source: "metadata" })
  })

  test("explicit global entries replace legacy hidden and manual for the same name", () => {
    const policy = resolved({
      skill: { name: "visual-qa-testing" },
      global: {
        manual: ["visual-qa-testing"],
        entries: { "visual-qa-testing": { visible: false, invocation: "allow" } },
      },
    })
    expect(policy.visible).toEqual({ value: false, source: "global-entry" })
    expect(policy.invocation).toEqual({ value: "allow", source: "global-entry" })
  })

  test("coexistence with the legacy list reverts when the entry is removed", () => {
    const withEntry = resolved({
      skill: { name: "effect" },
      global: { manual: ["effect"], entries: { effect: { visible: false, invocation: "allow" } } },
    })
    expect(withEntry.invocation.value).toBe("allow")
    const withoutEntry = resolved({ skill: { name: "effect" }, global: { manual: ["effect"] } })
    expect(withoutEntry.visible.value).toBe(false)
    expect(withoutEntry.invocation.value).toBe("manual")
  })

  test("agent entries win over global entries field by field", () => {
    const policy = resolved({
      skill: { name: "effect" },
      global: { entries: { effect: { visible: true, invocation: "allow" } } },
      agentSkills: { effect: { invocation: "deny" } },
    })
    expect(policy.visible).toEqual({ value: true, source: "global-entry" })
    expect(policy.invocation).toEqual({ value: "deny", source: "agent-entry" })
  })

  test("agent visible override shows a hidden skill while inheriting manual invocation", () => {
    const policy = resolved({
      skill: { name: "effect", disableModelInvocation: true },
      agentSkills: { effect: { visible: true } },
    })
    expect(policy.visible).toEqual({ value: true, source: "agent-entry" })
    expect(policy.invocation).toEqual({ value: "manual", source: "metadata" })
  })

  test("admission gate blocks deny always and manual without explicit selection", () => {
    const deny = SkillPolicy.admissionGate(
      { visible: { value: true, source: "metadata" }, invocation: { value: "deny", source: "global-entry" } },
      { explicitlySelected: true },
    )
    expect(deny).toBe("deny")
    const manual = SkillPolicy.admissionGate(
      { visible: { value: false, source: "metadata" }, invocation: { value: "manual", source: "metadata" } },
      { explicitlySelected: false },
    )
    expect(manual).toBe("manual")
    const manualSelected = SkillPolicy.admissionGate(
      { visible: { value: false, source: "metadata" }, invocation: { value: "manual", source: "metadata" } },
      { explicitlySelected: true },
    )
    expect(manualSelected).toBeUndefined()
    const ask = SkillPolicy.admissionGate(
      { visible: { value: true, source: "metadata" }, invocation: { value: "ask", source: "global-entry" } },
      { explicitlySelected: false },
    )
    expect(ask).toBeUndefined()
  })

  test("ask rules narrow only unselected ask-mode loads", () => {
    expect(SkillPolicy.askRules(
      { visible: { value: true, source: "metadata" }, invocation: { value: "ask", source: "global-entry" } },
      "effect",
      { explicitlySelected: false },
    )).toEqual([{ action: "skill", resource: "effect", effect: "ask" }])
    expect(SkillPolicy.askRules(
      { visible: { value: true, source: "metadata" }, invocation: { value: "ask", source: "global-entry" } },
      "effect",
      { explicitlySelected: true },
    )).toBeUndefined()
    expect(SkillPolicy.askRules(
      { visible: { value: true, source: "metadata" }, invocation: { value: "allow", source: "metadata" } },
      "effect",
      { explicitlySelected: false },
    )).toBeUndefined()
    expect(SkillPolicy.askRules(
      { visible: { value: true, source: "metadata" }, invocation: { value: "deny", source: "global-entry" } },
      "effect",
      { explicitlySelected: false },
    )).toBeUndefined()
  })

  test("validates both dialects, entries-only documents and preserves the policy through V1 migration", () => {
    const legacy = { manual: ["effect"] }
    const entriesOnly = {
      entries: { effect: { visible: false, invocation: "allow" as const }, other: { invocation: "deny" as const } },
    }
    for (const value of [legacy, entriesOnly, {}]) {
      expect(Schema.decodeUnknownSync(Config.Info)({ skill_invocation: value }).skill_invocation).toEqual(value)
      const migrated = ConfigMigrateV1.migrate(Schema.decodeUnknownSync(ConfigV1.Info)({ skill_invocation: value }))
      expect(migrated.skill_invocation).toEqual(value)
    }
    for (const schema of [Config.Info, ConfigV1.Info]) {
      expect(() => Schema.decodeUnknownSync(schema)({ skill_invocation: { manual: true } })).toThrow()
      expect(() =>
        Schema.decodeUnknownSync(schema)({ skill_invocation: { entries: { effect: { invocation: "sometimes" } } } }),
      ).toThrow()
      // Contract change with optional `manual`: entries-only documents are
      // valid, and unknown excess keys stay ignored by design.
      const decodedEmpty = Schema.decodeUnknownSync(Config.Info)({ skill_invocation: {} })
      expect((decodedEmpty.skill_invocation ?? {}) as Record<string, unknown>).toEqual({})
    }
  })

  test("v1 agent dialect carries per-agent skill overrides without leaking into provider options", () => {
    const agent = {
      name: "reviewer",
      skills: { effect: { visible: false, invocation: "ask" as const } },
    }
    const decoded = Schema.decodeUnknownSync(ConfigAgentV1.Info)(agent)
    expect(decoded.skills).toEqual({ effect: { visible: false, invocation: "ask" } })
    // KNOWN_KEYS routing: skills must not land in provider options.
    expect(decoded.options?.skills).toBeUndefined()
    const migrated = ConfigMigrateV1.migrateAgent(decoded)
    expect(migrated.skills).toEqual({ effect: { visible: false, invocation: "ask" } })
    expect(migrated.request === undefined || !("skills" in ((migrated.request.body ?? {}) as Record<string, unknown>))).toBe(true)
    const persisted = ConfigAgentV1.persisted(decoded)
    expect(persisted.skills).toEqual({ effect: { visible: false, invocation: "ask" } })
  })

  test("policiesFor resolves many skills against the same layers", () => {
    const policies = SkillPolicy.policiesFor(
      [
        { name: "effect", disableModelInvocation: true },
        { name: "other" },
      ],
      { entries: { effect: { visible: false, invocation: "allow" } } },
      { other: { invocation: "ask" } },
    )
    expect(policies.get("effect")?.invocation.value).toBe("allow")
    expect(policies.get("effect")?.visible.value).toBe(false)
    expect(policies.get("other")?.invocation).toEqual({ value: "ask", source: "agent-entry" })
  })
})
