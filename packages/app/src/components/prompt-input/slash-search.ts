import fuzzysort from "fuzzysort"
import type { NormalizedCommand } from "@/context/global-sync/utils"
import type { SlashCommand } from "./slash-popover"

export type SlashSearchContext = {
  slashAt: number
  tokenEnd: number
  token: string
  rest: string
  query: string
}

const slashDirectKeys = ["trigger", "title", (command: SlashCommand) => command.aliases?.join(" ") ?? ""]
const slashShortSearchTerms = new Set(["ai", "cd", "ci", "db", "js", "qa", "ts", "ui", "ux"])

export function commandToSlashCommand(command: NormalizedCommand): SlashCommand {
  return {
    id: `custom.${command.name}`,
    trigger: command.name,
    title: command.name,
    description: command.description,
    type: "custom",
    source: command.source,
    agent: command.agent,
    model: command.model,
    variant: command.variant,
    requiredTools: command.requiredTools,
    aliases: command.aliases,
  }
}

export function supportsSlashCommand(
  command: SlashCommand,
  agent:
    | {
        tools?: {
          mode: "inherit" | "explicit"
          entries: Record<string, { visible?: boolean; permission?: "allow" | "ask" | "deny" }>
        }
      }
    | undefined,
) {
  if (!command.requiredTools?.length || !agent) return true
  return command.requiredTools.every((tool) => {
    const entry = agent.tools?.entries[tool]
    if (agent.tools?.mode === "explicit" && !entry) return false
    return entry?.visible !== false && entry?.permission !== "deny"
  })
}

export function slashSearchContext(value: string, cursor: number): SlashSearchContext | undefined {
  const before = value.slice(0, cursor)
  const match = Array.from(before.matchAll(/(?:^|\s)\/([^\s:]*)/g)).at(-1)
  if (!match || match.index === undefined) return

  const slashAt = match.index + match[0].indexOf("/")
  // A space commits the current slash expression. Keep its popover closed even
  // when the cursor moves back into the trigger; only a later slash starts a
  // fresh expression.
  if (/\s/.test(value.slice(slashAt + 1))) return
  const token = match[1] ?? ""
  const tokenEnd = slashAt + token.length + 1
  const rest = before.slice(tokenEnd).replace(/^:/, "").trim()
  if (!token && before.length > tokenEnd) return
  return { slashAt, tokenEnd, token, rest, query: [token, rest].filter(Boolean).join(" ") }
}

export function normalizeSlashSuffix(value: string) {
  if (!value.startsWith(":")) return value
  const rest = value.slice(1)
  if (!rest) return " "
  if (/^\s/.test(rest)) return rest
  return ` ${rest}`
}

function directSlashMatches(commands: SlashCommand[], query: string) {
  const needle = query.trim().toLowerCase()
  const matches = needle ? fuzzysort.go(needle, commands, { keys: slashDirectKeys }).map((result) => result.obj) : commands
  return matches.map((cmd) => ({ ...cmd, match: "direct" as const }))
}

function extendedSlashMatches(commands: SlashCommand[], query: string) {
  const terms = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}-]+/u)
        .filter((term) => term.length >= 3 || slashShortSearchTerms.has(term)),
    ),
  ).slice(0, 20)
  if (terms.length === 0) return []

  return commands
    .map((cmd, index) => ({
      cmd,
      index,
      score: terms.filter((term) => `${cmd.trigger} ${cmd.title} ${cmd.description ?? ""}`.toLowerCase().includes(term))
        .length,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => ({ ...item.cmd, match: "extended" as const }))
}

export function searchSlashCommands(commands: SlashCommand[], search: SlashSearchContext | undefined) {
  if (!search) return directSlashMatches(commands, "")
  const direct = search.token || !search.rest ? directSlashMatches(commands, search.token) : []
  const seen = new Set(direct.map((cmd) => cmd.id))
  return [...direct, ...extendedSlashMatches(commands.filter((cmd) => !seen.has(cmd.id)), search.rest)]
}
