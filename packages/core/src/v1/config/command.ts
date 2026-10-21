export * as ConfigCommandV1 from "./command"

import { Schema } from "effect"
import { CommandV2 } from "../../command"

export const Info = Schema.Struct({
  template: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  action: Schema.optional(CommandV2.Action),
  subtask: Schema.optional(Schema.Boolean),
})
export type Info = Schema.Schema.Type<typeof Info>
