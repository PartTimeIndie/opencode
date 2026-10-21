import { existsSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"

type Input = {
  directory?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
}

export function resolveDesktopTestingCli(input: Input, args: string[]) {
  const cwd = input.directory || process.cwd()
  const env = input.env ?? process.env
  const exists = input.exists ?? existsSync
  if (env.OPENCODE_DESKTOP_TESTING_CLI) return { command: env.OPENCODE_DESKTOP_TESTING_CLI, args, cwd }
  const repoEntry = findRepoCliEntry(cwd, exists)
  if (repoEntry) {
    return {
      command: env.OPENCODE_DESKTOP_TESTING_BUN || "bun",
      args: ["run", "--conditions=browser", repoEntry, ...args],
      cwd,
    }
  }
  const installed = installedCliCandidates(env, input.platform ?? process.platform).find(exists)
  if (installed) return { command: installed, args, cwd }
  return { command: "opencode", args, cwd }
}

function findRepoCliEntry(directory: string, exists: (path: string) => boolean) {
  let current = directory
  for (;;) {
    const candidate = join(current, "packages", "opencode", "src", "index.ts")
    if (exists(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

function installedCliCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const names = platform === "win32" ? ["opencode.exe", "opencode.cmd"] : ["opencode"]
  const appData = env.APPDATA
    ? names.flatMap((name) => [
        join(env.APPDATA!, "npm", "node_modules", "opencode-ai", "bin", name),
        join(env.APPDATA!, "npm", name),
      ])
    : []
  return [
    ...appData,
    ...String(env.PATH || "")
      .split(delimiter)
      .filter(Boolean)
      .flatMap((directory) => names.map((name) => join(directory, name))),
  ]
}
