import { SkillV2 } from "@opencode-ai/core/skill"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../groups/location"

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  handlers
    .handle("skill.list", () => response(SkillV2.Service.use((skill) => skill.list())))
    .handle("skill.resolve", (ctx) =>
      response(
        SkillV2.Service.use((skill) =>
          skill.list({ refresh: true }).pipe(Effect.map((skills) => SkillV2.resolveSelected(skills, ctx.payload.names))),
        ),
      ),
    ),
)
