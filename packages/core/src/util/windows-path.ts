import { spawnSync } from "node:child_process"
import path from "node:path"

const MACHINE_ENVIRONMENT = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"
const USER_ENVIRONMENT = "HKCU\\Environment"

let registry: [string | undefined, string | undefined] | undefined

export function executablePath(env: NodeJS.ProcessEnv = process.env) {
  const inherited = env.PATH ?? env.Path ?? ""
  if (process.platform !== "win32") return inherited
  registry ??= [readRegistryPath(MACHINE_ENVIRONMENT, env), readRegistryPath(USER_ENVIRONMENT, env)]
  return mergeWindowsPath([inherited, ...registry], env)
}

export function mergeWindowsPath(values: Array<string | undefined>, env: NodeJS.ProcessEnv) {
  const variables = new Map(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]))
  const seen = new Set<string>()
  return values
    .flatMap((value) => value?.split(path.win32.delimiter) ?? [])
    .map((value) => {
      const expanded = value
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .replace(/%([^%]+)%/g, (match, key: string) => variables.get(key.toLowerCase()) ?? match)
      return expanded.length > path.win32.parse(expanded).root.length ? expanded.replace(/[\\/]+$/, "") : expanded
    })
    .filter((value) => {
      if (!value) return false
      const key = value.replace(/[\\/]+$/, "").toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join(path.win32.delimiter)
}

export function parseWindowsRegistryPath(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i)?.[1]?.trim())
    .find((value): value is string => Boolean(value))
}

function readRegistryPath(key: string, env: NodeJS.ProcessEnv) {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows"
  const result = spawnSync(path.win32.join(systemRoot, "System32", "reg.exe"), ["query", key, "/v", "Path"], {
    encoding: "utf8",
    env,
    timeout: 2_000,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) return
  return parseWindowsRegistryPath(result.stdout)
}
