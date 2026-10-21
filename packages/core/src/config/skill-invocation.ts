export * as ConfigSkillInvocation from "./skill-invocation"

import { Schema } from "effect"

export const Info = Schema.Struct({
  manual: Schema.Array(Schema.String),
})
