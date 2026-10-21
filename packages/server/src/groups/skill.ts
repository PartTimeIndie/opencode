import { SkillV2 } from "@opencode-ai/core/skill"
import { Location } from "@opencode-ai/core/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi, LocationMiddleware } from "./location"

export const SkillGroup = HttpApiGroup.make("server.skill")
  .add(
    HttpApiEndpoint.get("skill.list", "/api/skill", {
      query: LocationQuery,
      success: Location.response(Schema.Array(SkillV2.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.list",
          summary: "List skills",
          description: "Retrieve currently registered skills.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("skill.resolve", "/api/skill/resolve", {
      query: LocationQuery,
      payload: SkillV2.ResolveInput,
      success: Location.response(SkillV2.ResolveOutput),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.resolve",
          summary: "Resolve selected skill content",
          description: "Resolve only explicitly selected registered skill names to their current instruction content.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "skills",
      description: "Experimental skill routes.",
    }),
  )
  .middleware(LocationMiddleware)
