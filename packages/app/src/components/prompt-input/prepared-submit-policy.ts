const GOAL_CLEAR_COMMANDS = new Set(["clear", "stop", "off", "reset", "none", "cancel"])
const GOAL_STATUS_COMMANDS = new Set(["status", "history", "list", "pause", "resume", "focus"])

export function visibleGoalFromCommandArguments(value: string) {
  const args = value.trim()
  const normalized = args.toLowerCase()
  // These controls own plugin state; only server metadata can confirm the focused goal.
  if (!args || GOAL_STATUS_COMMANDS.has(normalized) || /^(?:add|edit|sisyphus|focus)(?:\s|$)/.test(normalized)) return undefined
  if (GOAL_CLEAR_COMMANDS.has(normalized)) return ""
  return args
}

/** Mirrors the ordinary submit's command/goal distinction without consulting the live route. */
export function preparedSendPolicy(input: {
  text: string
  working: boolean
  shouldQueue: boolean
  commands: readonly { name: string; source?: string }[]
}) {
  const goal = input.text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/)
  const goalCommand = goal && input.commands.find((item) => item.name === "goal")
  if (goal && !goalCommand) return { error: "Goal command is unavailable" }
  const visibleGoal = goal ? visibleGoalFromCommandArguments(goal[1]?.trim() ?? "") : undefined
  if (goal && !visibleGoal) return { command: "goal", arguments: goal[1]?.trim() ?? "", visibleGoal }
  if (visibleGoal) return { command: undefined, arguments: "", visibleGoal }
  const [head, ...args] = input.text.split(" ")
  const name = head?.startsWith("/") ? head.slice(1) : undefined
  const custom = input.working || input.shouldQueue ? undefined : input.commands.find((item) => item.name === name && item.source !== "skill")
  return { command: custom?.name, arguments: args.join(" "), visibleGoal }
}
