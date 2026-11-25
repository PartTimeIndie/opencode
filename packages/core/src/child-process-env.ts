export * as ChildProcessEnv from "./child-process-env"

const INTERNAL_STARTUP_VARIABLES = [
  "OPENCODE_DEFER_DB_STARTUP_REPAIRS",
  "OPENCODE_DEFER_BACKGROUND_STARTUP",
] as const

const GIT_CONFIG_VARIABLE = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/

export function external(environment: NodeJS.ProcessEnv) {
  const entries = Object.entries(environment).flatMap(
    ([key, value]): [string, string][] =>
      value === undefined || INTERNAL_STARTUP_VARIABLES.some((internal) => internal === key) ? [] : [[key, value]],
  )
  const visible = incompleteGitConfig(entries)
    ? entries.filter(([key]) => !GIT_CONFIG_VARIABLE.test(key.toUpperCase()))
    : entries
  return Object.fromEntries(visible)
}

// A parent such as the Codex desktop app injects git settings through GIT_CONFIG_* variables, but the set can arrive
// incomplete (Windows drops empty values), and git then refuses every command before running it. Such a set is dropped
// whole so git falls back to its normal config files.
function incompleteGitConfig(entries: [string, string][]) {
  const family = entries.filter(([key]) => GIT_CONFIG_VARIABLE.test(key.toUpperCase()))
  const count = family.find(([key]) => key.toUpperCase() === "GIT_CONFIG_COUNT")?.[1]
  if (count === undefined) return false
  if (!/^\d+$/.test(count)) return true
  const total = Number(count)
  const names = new Set(family.map(([key]) => key.toUpperCase()))
  if (total * 2 + 1 > family.length) return true
  return Array.from({ length: total }, (_, index) => index).some(
    (index) => !names.has(`GIT_CONFIG_KEY_${index}`) || !names.has(`GIT_CONFIG_VALUE_${index}`),
  )
}
