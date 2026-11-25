export type SkillReferenceCommand = {
  name: string
  description?: string
  aliases?: string[]
  source?: "command" | "mcp" | "skill"
}

export type SkillReferenceToolbarItem = {
  title: string
  skill?: {
    name: string
    aliases?: string[]
  }
}

export type SkillReference = {
  name: string
  reference: string
  title?: string
  description?: string
  aliases: string[]
}

export type SkillReferenceToolbarCommandItem = SkillReferenceToolbarItem & {
  command?: {
    name: string
  }
}

export type SkillReferenceDiagnostic = {
  name: string
  title?: string
  reference: string
  kind: "command-not-skill" | "not-found" | "manual-only" | "missing-tools"
  message: string
  missingTools?: string[]
}

/** Read-only projection of existing command sources and server-side skill constraints. */
export function skillReferenceDiagnostics(input: {
  commands: SkillReferenceCommand[]
  toolbar?: SkillReferenceToolbarCommandItem[]
  constraints?: { name: string; manualOnly: boolean; missingTools: string[] }[]
}): SkillReferenceDiagnostic[] {
  const commands = new Map(input.commands.map((item) => [item.name, item]))
  const constraints = new Map(input.constraints?.map((item) => [item.name, item]))
  return (input.toolbar ?? []).flatMap((item): SkillReferenceDiagnostic[] => {
    const name = (item.command?.name ?? item.skill?.name)?.trim()
    if (!name || (item.command && item.skill)) return []
    const base = { name, title: item.title, reference: `/${name}` }
    const command = commands.get(name)
    const constraint = constraints.get(name)
    if (!command && !constraint)
      return [{ ...base, kind: "not-found", message: "Name not found in the current location catalog." }]
    if (command && command.source !== "skill")
      return [
        {
          ...base,
          kind: "command-not-skill",
          message: "This is a command, not a skill. An appended reference does not dispatch its command template.",
        },
      ]
    return [
      ...(constraint?.manualOnly
        ? [
            {
              ...base,
              kind: "manual-only" as const,
              message:
                "Manual-only skill. An armed toolbar click alone loads nothing, but the slash token submitted with your message counts as the explicit invocation.",
            },
          ]
        : []),
      ...(constraint?.missingTools.length
        ? [
            {
              ...base,
              kind: "missing-tools" as const,
              missingTools: constraint.missingTools,
              message: `Tools unavailable for the selected agent: ${constraint.missingTools.join(", ")}. A reference does not enable tools.`,
            },
          ]
        : []),
    ]
  })
}

export function skillReferences(input: { commands: SkillReferenceCommand[]; toolbar?: SkillReferenceToolbarItem[] }) {
  const commands = new Map(input.commands.filter((item) => item.source === "skill").map((item) => [item.name, item]))
  if (!input.toolbar) return Array.from(commands.values(), (command) => reference(command))

  return input.toolbar.flatMap((item) => {
    if (!item.skill) return []
    const command = commands.get(item.skill.name)
    if (!command) return []
    return [reference(command, item)]
  })
}

function reference(command: SkillReferenceCommand, item?: SkillReferenceToolbarItem): SkillReference {
  return {
    name: command.name,
    reference: `/${command.name}`,
    title: item?.title,
    description: command.description,
    aliases: Array.from(
      new Set(
        [...(command.aliases ?? []), ...(item?.skill?.aliases ?? [])].map((alias) => alias.trim()).filter(Boolean),
      ),
    ),
  }
}
