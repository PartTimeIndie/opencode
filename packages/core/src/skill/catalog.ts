export * as SkillCatalog from "./catalog"

import { createHash } from "node:crypto"
import type { Message } from "@opencode-ai/llm"

export function retainedOutputs(messages: ReadonlyArray<Message>) {
  return messages.flatMap((message) =>
    message.role !== "tool"
      ? []
      : message.content.flatMap((part) =>
          part.type === "tool-result" &&
          part.name === "skill" &&
          part.result.type === "text" &&
          typeof part.result.value === "string" &&
          part.result.value.startsWith("<skill_group ")
            ? [part.result.value]
            : [],
        ),
  )
}
import { ConfigSkillGroups } from "../config/skill-groups"
import type { SkillV2 } from "../skill"

export type Entry = { type: "skill" | "group"; name: string; title?: string; description: string }
export type Catalog = { revision: string; root: Entry[]; groups: Record<string, Entry[]>; issues: string[] }
const navigation =
  "Open a group with skill({group}) for direct child descriptions only. No search or automatic flat fallback."
const compare = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

export function renderEntries(entries: ReadonlyArray<Entry>) {
  return entries
    .map((entry) =>
      entry.type === "group"
        ? `<group id="${escape(entry.name)}"><title>${escape(entry.title ?? entry.name)}</title><description>${escape(entry.description)}</description></group>`
        : `<skill><name>${escape(entry.name)}</name><description>${escape(entry.description)}</description></skill>`,
    )
    .join("\n")
}

export function project(skills: ReadonlyArray<SkillV2.Info>, config?: ConfigSkillGroups.Info): Catalog {
  const visible = [
    ...new Map(
      skills
        .filter((skill) => !skill.disableModelInvocation && skill.description !== undefined)
        .map((skill) => [skill.name, skill]),
    ).values(),
  ].sort((a, b) => compare(a, b))
  const flat = visible.map((skill): Entry => ({ type: "skill", name: skill.name, description: skill.description! }))
  const issues: string[] = []
  const graphError = ConfigSkillGroups.graphError(config?.groups ?? [])
  if (graphError) throw new Error(graphError)
  const definitions = new Map((config?.groups ?? []).map((group) => [group.id, group]))
  const assigned = new Map(
    visible.map((skill) => {
      const ids = [...new Set(config?.memberships?.[skill.name] ?? skill.groups ?? [])].sort()
      for (const id of ids) {
        if (!definitions.has(id)) issues.push(`Unknown group ${id} for skill ${skill.name}`)
      }
      return [skill.name, ids.filter((id) => definitions.has(id))]
    }),
  )
  const groups: Record<string, Entry[]> = {}
  const claimed = new Set<string>()
  const leafNames = (entries: ReadonlyArray<Entry>): string[] =>
    entries.flatMap((entry) => (entry.type === "skill" ? [entry.name] : leafNames(groups[entry.name] ?? [])))
  const build = (parent?: string): Entry[] => {
    const entries = [...definitions.values()]
      .filter((group) => group.parent === parent)
      .sort((a, b) => compare({ name: a.id } as Entry, { name: b.id } as Entry))
      .flatMap((group): Entry[] => {
        const children = build(group.id)
        const members = new Set(leafNames(children))
        const entry: Entry = { type: "group", name: group.id, title: group.title, description: group.description }
        // Compare both the direct representation and the complete flat family.
        if (members.size < 3 || renderEntries([entry]).length + navigation.length + 1 >= renderEntries(children).length)
          return children
        groups[group.id] = children
        return [entry]
      })
    for (const entry of flat) {
      if (claimed.has(entry.name)) continue
      const ids = assigned.get(entry.name) ?? []
      if (parent ? ids.includes(parent) : ids.length === 0) {
        entries.push(entry)
        claimed.add(entry.name)
      }
    }
    return entries.sort(compare)
  }
  const root = config?.enabled ? build() : flat
  // Unselected memberships never create duplicate descriptors; nested groups own their children.
  const revision = createHash("sha256").update(JSON.stringify({ root, groups, visible })).digest("hex").slice(0, 20)
  return { revision, root, groups, issues }
}

export function render(catalog: Catalog) {
  return [
    "Skills provide specialized instructions. Load a selected skill with skill({name}).",
    ...(Object.keys(catalog.groups).length ? [navigation] : []),
    `<available_skills revision="${catalog.revision}">`,
    renderEntries(catalog.root),
    "</available_skills>",
  ].join("\n")
}

export function expand(catalog: Catalog, id: string, retained: ReadonlyArray<string> = []) {
  const children = catalog.groups[id]
  if (!children) return
  const output = `<skill_group id="${escape(id)}" revision="${catalog.revision}">\n${renderEntries(children)}\n</skill_group>`
  // Only exact model-visible output suppresses repetition. No process/session loaded ledger.
  return retained.includes(output)
    ? `Skill group ${id} revision ${catalog.revision} is already present in the current context.`
    : output
}
