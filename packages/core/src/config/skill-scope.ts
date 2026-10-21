export * as ConfigSkillScope from "./skill-scope"

import { Schema } from "effect"

export const Info = Schema.Record(Schema.String, Schema.Struct({
  mode: Schema.Literals(["global", "projects"]),
  projects: Schema.Array(Schema.String).pipe(Schema.optional),
}))
