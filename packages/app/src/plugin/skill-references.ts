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

export function skillReferences(input: {
  commands: SkillReferenceCommand[]
  toolbar?: SkillReferenceToolbarItem[]
}) {
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
        [...(command.aliases ?? []), ...(item?.skill?.aliases ?? [])]
          .map((alias) => alias.trim())
          .filter(Boolean),
      ),
    ),
  }
}
