import { expect, test } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { skillsWithEffectivePolicy } from "../src/handlers/skill"

const skill = (name: string, extra: Partial<SkillV2.Info> = {}): SkillV2.Info => ({
  name,
  description: `Guidance for ${name}`,
  location: AbsolutePath.make(`C:/skills/${name}/SKILL.md`),
  content: `Instructions for ${name}`,
  ...extra,
})

test("skill.list policy view resolves global entries and per-agent overrides with sources", () => {
  const invocation = {
    entries: {
      hidden: { visible: false, invocation: "allow" as const },
      legacy: { invocation: "deny" as const },
    },
    manual: ["legacy"],
  }
  const agent = new AgentV2.Info({
    ...AgentV2.Info.empty(AgentV2.ID.make("reviewer")),
    skills: { hidden: { invocation: "ask" } },
  })
  const result = skillsWithEffectivePolicy(
    [skill("hidden"), skill("legacy", { disableModelInvocation: true }), skill("plain")],
    invocation,
    agent,
  )
  expect(result.find((item) => item.name === "hidden")?.effective).toEqual({
    visible: false,
    invocation: "ask",
    sources: { visible: "global-entry", invocation: "agent-entry" },
  })
  expect(result.find((item) => item.name === "legacy")?.effective).toEqual({
    visible: false,
    invocation: "deny",
    sources: { visible: "metadata", invocation: "global-entry" },
  })
  expect(result.find((item) => item.name === "plain")?.effective).toEqual({
    visible: true,
    invocation: "allow",
    sources: { visible: "metadata", invocation: "metadata" },
  })
})

test("the global view without an agent keeps hidden skills listed for management", () => {
  const result = skillsWithEffectivePolicy([skill("legacy")], { manual: ["legacy"] }, undefined)
  expect(result).toHaveLength(1)
  expect(result[0]?.effective).toEqual({
    visible: false,
    invocation: "manual",
    sources: { visible: "legacy-manual", invocation: "legacy-manual" },
  })
})
