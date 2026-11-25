export * as ConfigDelegation from "./delegation"

import { Schema } from "effect"

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/\S/))

/** References describe a preference, never a grant or an implicit model chain. */
export const Selection = Schema.Struct({
  agent: Name.pipe(Schema.optional),
  model: Name.pipe(Schema.optional),
  variant: Name.pipe(Schema.optional),
  chain: Name.pipe(Schema.optional),
}).check(Schema.makeFilter((value) =>
  Object.values(value).some((entry) => entry !== undefined) && !(value.model && value.chain)
    || "Choose at least one configured reference, and either a direct model or a chain"))
export type Selection = typeof Selection.Type

export const Preference = Schema.Struct({
  topic: Name,
  selections: Schema.Array(Selection).check(Schema.isMinLength(1)),
})

export const Rule = Schema.Struct({
  topic: Name.pipe(Schema.optional),
  allowed: Schema.Array(Selection).check(Schema.isMinLength(1)),
})

/** Mirror default and full context are invariants, not configurable switches.
 * Topic matching is supplied by Main's judgment, never inferred from keywords. */
export const Info = Schema.Struct({
  ordinaryQuestions: Schema.Boolean.pipe(Schema.optional),
  preferences: Schema.Array(Preference).pipe(Schema.optional),
  rules: Schema.Array(Rule).pipe(Schema.optional),
})
export type Info = typeof Info.Type
