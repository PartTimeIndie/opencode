import { expect, test } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SkillV2 } from "@opencode-ai/core/skill"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { skillConstraintDiagnostics } from "../src/handlers/skill-diagnostics"

const skill = new SkillV2.Info({
  name: "manual",
  disableModelInvocation: true,
  requiredTools: ["surface", "image_generate"],
  location: AbsolutePath.make("C:/skills/manual/SKILL.md"),
  content: "private content",
})

test("diagnostics reuse missingTools, expose no content and retain exact slash-token boundaries", () => {
  const agent = new AgentV2.Info({
    ...AgentV2.Info.empty(AgentV2.ID.make("build")),
    tools: { mode: "explicit", entries: { surface: { visible: true, permission: "allow" } } },
  })
  expect(skillConstraintDiagnostics([skill], agent)).toEqual([
    { name: "manual", manualOnly: true, missingTools: ["image_generate"] },
  ])
  expect(SkillV2.invokedBySlash(skill, "message /manual")).toBe(true)
  expect(SkillV2.invokedBySlash(skill, "message /manual-other")).toBe(false)
})

test("permission denial is reported by the existing policy evaluator", () => {
  const agent = new AgentV2.Info({
    ...AgentV2.Info.empty(AgentV2.ID.make("build")),
    permissions: [{ action: "surface", resource: "*", effect: "deny" }],
  })
  expect(skillConstraintDiagnostics([skill], agent)[0]?.missingTools).toEqual(["surface"])
  expect(skillConstraintDiagnostics([skill])[0]?.missingTools).toEqual([])
})
