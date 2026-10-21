export * as ConfigSkillGroups from "./skill-groups"

import { Schema } from "effect"

export const ID = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/))
export const Group = Schema.Struct({
  id: ID,
  title: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.String.check(Schema.isMinLength(1)),
  parent: ID.pipe(Schema.optional),
})
export type Group = typeof Group.Type

export function graphError(groups: ReadonlyArray<Group>): string | undefined {
  const byID = new Map(groups.map((group) => [group.id, group]))
  if (byID.size !== groups.length) return "Duplicate skill group ID"
  for (const group of groups) {
    const visited = new Set([group.id])
    let parent = group.parent
    while (parent) {
      if (!byID.has(parent)) return "Unknown skill group parent"
      if (visited.has(parent)) return "Cyclic skill groups"
      visited.add(parent)
      parent = byID.get(parent)?.parent
    }
  }
}

export const Info = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.optional),
  groups: Schema.Array(Group),
  // Overrides are keyed by canonical name, never aliases. An empty array means standalone.
  memberships: Schema.Record(Schema.String, Schema.Array(ID)).pipe(Schema.optional),
}).check(
  Schema.makeFilter((value) => {
    const error = graphError(value.groups)
    if (error) return error
    const ids = new Set(value.groups.map((group) => group.id))
    return (
      Object.values(value.memberships ?? {}).every((items) => items.every((id) => ids.has(id))) ||
      "Unknown skill group membership"
    )
  }),
)
export type Info = typeof Info.Type
