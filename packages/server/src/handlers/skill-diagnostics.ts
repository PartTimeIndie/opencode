import { SkillV2 } from "@opencode-ai/core/skill"
import type { AgentV2 } from "@opencode-ai/core/agent"

/** Projection only: the existing skill registry and policy evaluator remain authoritative. */
export function skillConstraintDiagnostics(skills: ReadonlyArray<SkillV2.Info>, agent?: AgentV2.Info) {
  return skills.map((skill) => ({
    name: skill.name,
    manualOnly: skill.disableModelInvocation === true,
    missingTools: agent ? SkillV2.missingTools(skill, agent) : [],
  }))
}
