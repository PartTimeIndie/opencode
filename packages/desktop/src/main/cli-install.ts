import { execFile } from "node:child_process"
import { access, copyFile, mkdir, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"

export type CliInstallDependencies = {
  platform: NodeJS.Platform
  resourcesPath: string
  localAppData: string | undefined
  env: NodeJS.ProcessEnv
  access: typeof access
  mkdir: typeof mkdir
  copyFile: typeof copyFile
  rename: typeof rename
  rm: typeof rm
  randomUUID: typeof randomUUID
  readUserPath: () => Promise<string>
  writeUserPath: (value: string) => Promise<void>
}

export async function installCli(deps: CliInstallDependencies = defaults()) {
  if (deps.platform !== "win32") throw new Error("CLI installation is unsupported on this platform")
  if (!deps.localAppData) throw new Error("Cannot install CLI: LOCALAPPDATA is not set")

  const source = join(deps.resourcesPath, "opencode-cli.exe")
  await deps.access(source).catch(() => {
    throw new Error(`Cannot install CLI: packaged resource is missing at ${source}`)
  })

  const directory = join(deps.localAppData, "OpenCode", "bin")
  const target = join(directory, "opencode.exe")
  await deps.mkdir(directory, { recursive: true })
  await replaceCliAtomically(deps, source, directory, target)

  const userPath = await deps.readUserPath()
  const nextUserPath = prependPath(directory, userPath)
  if (nextUserPath !== userPath) await deps.writeUserPath(nextUserPath)
  const processPath = deps.env.Path ?? deps.env.PATH ?? ""
  deps.env.Path = prependPath(directory, processPath)
  return target
}

export async function refreshManagedCli(deps: CliInstallDependencies = defaults()) {
  if (deps.platform !== "win32" || !deps.localAppData) return

  const directory = join(deps.localAppData, "OpenCode", "bin")
  const target = join(directory, "opencode.exe")
  const targetExists = await deps.access(target).then(() => true).catch(() => false)
  if (!targetExists) return

  const source = join(deps.resourcesPath, "opencode-cli.exe")
  await deps.access(source).catch(() => {
    throw new Error(`Cannot refresh CLI: packaged resource is missing at ${source}`)
  })

  return replaceCliAtomically(deps, source, directory, target)
}

async function replaceCliAtomically(deps: CliInstallDependencies, source: string, directory: string, target: string) {
  const temporary = join(directory, `.opencode-${deps.randomUUID()}.tmp`)
  const cleanup = () => deps.rm(temporary, { force: true }).catch(() => undefined)

  await deps.copyFile(source, temporary).catch(async (error) => {
    await cleanup()
    throw error
  })
  await deps.rename(temporary, target).catch(async (error) => {
    await cleanup()
    throw error
  })
  return target
}

export function prependPath(directory: string, value: string) {
  if (value.split(";").some((entry) => normalizePathEntry(entry) === normalizePathEntry(directory))) return value
  return value ? `${directory};${value}` : directory
}

function normalizePathEntry(value: string) {
  return resolve(value.trim().replace(/^"|"$/g, "")).replace(/[\\/]+$/, "").toLowerCase()
}

function defaults(): CliInstallDependencies {
  return {
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    localAppData: process.env.LOCALAPPDATA,
    env: process.env,
    access,
    mkdir,
    copyFile,
    rename,
    rm,
    randomUUID,
    readUserPath: () => runPowerShell("[Environment]::GetEnvironmentVariable('Path', 'User')"),
    writeUserPath: (value) =>
      runPowerShell("[Environment]::SetEnvironmentVariable('Path', {0}, 'User')", value).then(() => undefined),
  }
}

export function runPowerShell(command: string, ...args: string[]) {
  const encoded = Buffer.from(buildPowerShellScript(command, args), "utf16le").toString("base64")
  return new Promise<string>((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], (error, stdout) => {
      if (error) return reject(error)
      resolve(stdout.trimEnd())
    })
  })
}

export function buildPowerShellScript(command: string, args: string[]) {
  return command.replace(/\{(\d+)\}/g, (_, index) => toPowerShellLiteral(args[Number(index)] ?? ""))
}

// Single-quoted PowerShell literals are verbatim: no `$` expansion, no backtick
// escapes, and no `;` splitting. Doubling `'` is the only escaping needed, so the
// resulting script safely embeds arbitrary argument values without shell re-parsing.
export function toPowerShellLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}
