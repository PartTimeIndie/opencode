import { SkillV2 } from "@opencode-ai/core/skill"
import { Location } from "@opencode-ai/core/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi, LocationMiddleware } from "./location"
import { InvalidRequestError } from "../errors"

export const SkillGroup = HttpApiGroup.make("server.skill")
  .add(
    HttpApiEndpoint.get("skill.list", "/api/skill", {
      query: Schema.Struct({ ...LocationQuery.fields, agent: Schema.optional(Schema.String) }),
      success: Location.response(Schema.Array(SkillV2.Info)),
      error: [InvalidRequestError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.list",
          summary: "List skills",
          description:
            "Retrieve currently registered skills. With an agent query, each skill carries its effective visibility and invocation policy for that agent.",
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
  .add(
    HttpApiEndpoint.get("skill.diagnostics", "/api/skill/diagnostics", {
      query: Schema.Struct({ ...LocationQuery.fields, agent: Schema.optional(Schema.String) }),
      success: Location.response(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            manualOnly: Schema.Boolean,
            missingTools: Schema.Array(Schema.String),
          }),
        ),
      ),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.diagnostics",
          summary: "Explain skill constraints",
          description:
            "Read-only hints from the existing skill catalog and selected agent policy. Grants no invocation authority.",
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
