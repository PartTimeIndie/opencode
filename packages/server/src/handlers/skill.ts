import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillPolicy } from "@opencode-ai/core/skill/policy"
import { Config } from "@opencode-ai/core/config"
import { AgentV2 } from "@opencode-ai/core/agent"
import { skillConstraintDiagnostics } from "./skill-diagnostics"
import { InvalidRequestError } from "../errors"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../groups/location"

/** Attach effective per-skill policy for the requested agent (global view without one). */
export function skillsWithEffectivePolicy(
  skills: ReadonlyArray<SkillV2.Info>,
  invocation: Config.ConfigIssue extends never ? never : ReturnType<typeof Config.globalLatest<"skill_invocation">>,
  agent: AgentV2.Info | undefined,
): SkillV2.Info[] {
  return skills.map((skill) => {
    const resolved = SkillPolicy.resolveForSkill({ skill, global: invocation, agentSkills: agent?.skills })
    return new SkillV2.Info({
      ...skill,
      effective: {
        visible: resolved.visible.value,
        invocation: resolved.invocation.value,
        sources: {
          visible: resolved.visible.source,
          invocation: resolved.invocation.source,
        },
      },
    })
  })
}

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  handlers
    .handle("skill.list", (ctx) =>
      response(
        Effect.gen(function* () {
          const skills = yield* SkillV2.Service.use((skill) => skill.list())
          const agentName = ctx.query.agent
          const agent = agentName === undefined ? undefined : yield* AgentV2.Service.use((agents) => agents.get(AgentV2.ID.make(agentName)))
          if (agentName !== undefined && !agent)
            return yield* Effect.fail(
              new InvalidRequestError({ message: `Agent not found: ${agentName}`, field: "agent" }),
            )
          const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
          const entries = config ? yield* config.entries() : []
          const invocation = Config.globalLatest(entries, "skill_invocation")
          return skillsWithEffectivePolicy(skills, invocation, agent)
        }),
      ),
    )
    .handle("skill.diagnostics", (ctx) =>
      response(
        Effect.gen(function* () {
          const skills = yield* SkillV2.Service.use((skill) => skill.list())
          const agents = yield* AgentV2.Service.use((agent) => agent.all())
          return skillConstraintDiagnostics(
            skills,
            agents.find((agent) => agent.id === ctx.query.agent),
          )
        }),
      ),
    )
    .handle("skill.resolve", (ctx) =>
      response(
        SkillV2.Service.use((skill) =>
          skill
            .list({ refresh: true })
            .pipe(Effect.map((skills) => SkillV2.resolveSelected(skills, ctx.payload.names))),
        ),
      ),
    ),
)
