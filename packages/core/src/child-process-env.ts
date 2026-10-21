export * as ChildProcessEnv from "./child-process-env"

const INTERNAL_STARTUP_VARIABLES = [
  "OPENCODE_DEFER_DB_STARTUP_REPAIRS",
  "OPENCODE_DEFER_BACKGROUND_STARTUP",
] as const

export function external(environment: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(environment).flatMap(([key, value]) =>
      value === undefined || INTERNAL_STARTUP_VARIABLES.some((internal) => internal === key) ? [] : [[key, value]],
    ),
  )
}
