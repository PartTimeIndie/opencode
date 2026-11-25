export * as ConfigSkillInvocation from "./skill-invocation"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export const SkillEntry = Schema.Struct({
  visible: Schema.Boolean.pipe(Schema.optional),
  invocation: Schema.Literals(["allow", "ask", "manual", "deny"]).pipe(Schema.optional),
})

// Durable same-chat skill selection memory. Absent values resolve to the
// built-in defaults; every field is finite and positive — there is no
// "infinite" zero and no silent clamping.
export const SelectionMemory = Schema.Struct({
  enabled: Schema.Boolean,
  minutes: PositiveInt,
  messages: PositiveInt,
})
export type SelectionMemory = typeof SelectionMemory.Type

export const defaultSelectionMemory: SelectionMemory = { enabled: true, minutes: 15, messages: 15 }

export const resolveSelectionMemory = (
  info: { readonly selection_memory?: SelectionMemory | undefined } | undefined,
): SelectionMemory => ({
  enabled: info?.selection_memory?.enabled ?? defaultSelectionMemory.enabled,
  minutes: info?.selection_memory?.minutes ?? defaultSelectionMemory.minutes,
  messages: info?.selection_memory?.messages ?? defaultSelectionMemory.messages,
})

// `manual` is the legacy exact-name list. It stays optional so entries-only
// documents decode; an absent list evaluates as empty, never as an error.
export const Info = Schema.Struct({
  manual: Schema.Array(Schema.String).pipe(Schema.optional),
  entries: Schema.Record(Schema.String, SkillEntry).pipe(Schema.optional),
  selection_memory: SelectionMemory.pipe(Schema.optional),
})
