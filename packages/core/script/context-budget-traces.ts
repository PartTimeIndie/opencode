import { SkillCatalog } from "../src/skill/catalog"

export function catalogTrace(flat: SkillCatalog.Catalog, grouped: SkillCatalog.Catalog, openings: string[]) {
  const roots = { F: SkillCatalog.render(flat), G: SkillCatalog.render(grouped) }
  const history: string[] = []
  const expansions = openings.map((id) => {
    const output = SkillCatalog.expand(grouped, id, history)
    if (!output) throw new Error(`Unknown group ${id}`)
    const call = JSON.stringify({ tool: "skill", input: { group: id } })
    history.push(call, output)
    return { id, callChars: call.length, resultChars: output.length, retainedChars: history.join("\n").length }
  })
  const requests = [
    { F: roots.F.length, G: roots.G.length },
    ...expansions.map((expansion) => ({ F: roots.F.length, G: roots.G.length + expansion.retainedChars })),
  ]
  const visibleNames = new Set(grouped.root.filter((entry) => entry.type === "skill").map((entry) => entry.name))
  for (const id of openings)
    for (const entry of grouped.groups[id]) if (entry.type === "skill") visibleNames.add(entry.name)
  const unopened = flat.root.filter((entry) => entry.type === "skill" && !visibleNames.has(entry.name))
  return {
    kind: "calculated-fixed-request-count-counterfactual",
    warning:
      "Catalog/navigation chars only, not provider tokens or real traffic. F omits group-only navigation; common prompts, full skill loads and message framing are omitted from both sides. Actual F may need fewer turns.",
    groupsOpened: openings,
    uniqueOpenings: new Set(openings).size,
    repeatedOpenings: openings.length - new Set(openings).size,
    expansions,
    unopenedSkills: unopened.map((entry) => entry.name),
    unopenedDescriptorChars: SkillCatalog.renderEntries(unopened).length,
    finalRequest: requests.at(-1)!,
    allGroupsOpened: Object.keys(grouped.groups).every((id) => openings.includes(id)),
    requests,
    cumulativeChars: {
      F: requests.reduce((sum, request) => sum + request.F, 0),
      G: requests.reduce((sum, request) => sum + request.G, 0),
    },
  }
}
