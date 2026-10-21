import os from "node:os"
import path from "node:path"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { BlobReader, BlobWriter, configure, ZipReader } from "@zip.js/zip.js"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { type ParseError, applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"
import { AppPluginAssets } from "@/plugin/app/assets"
import { patchPluginConfig, readPluginManifest, type Target } from "@/plugin/install"
import { parsePluginSpecifier } from "@/plugin/shared"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"

configure({ useWebWorkers: false })

type ExtensionKind = "plugin" | "skill"
type ExtensionScope = "project" | "global" | "external"
type PluginTarget = "app" | "server" | "tui" | "unknown"

type ListItem = {
  id: string
  kind: ExtensionKind
  name: string
  target?: PluginTarget
  targets?: PluginTarget[]
  source: string
  scope: ExtensionScope
  spec?: string
  path?: string
  file?: string
  configFile?: string
  description?: string
  removable: boolean
  reason?: string
}

type InstallInput = {
  directory: string
  source: string
  force?: boolean
}

type UninstallPluginInput = {
  directory: string
  spec: string
  file?: string
  deleteFiles?: boolean
}

type UninstallSkillInput = {
  directory: string
  name: string
  path?: string
}

type InstallResult =
  | { ok: true; item: ListItem }
  | { ok: false; code: "target_exists"; target: string; message: string }
  | { ok: false; code: "invalid_source"; message: string }
  | { ok: false; code: "patch_failed"; message: string }

type PreparedSource = {
  source: string
  name: string
  cleanup?: () => Promise<void>
}

const pluginWordNames: Record<string, string> = {
  ai: "AI",
  api: "API",
  cli: "CLI",
  git: "Git",
  mcp: "MCP",
  opencode: "OpenCode",
  openai: "OpenAI",
  qa: "QA",
  sdk: "SDK",
  stt: "STT",
  tui: "TUI",
  ui: "UI",
  url: "URL",
  ux: "UX",
}
const pluginNameConnectors = new Set(["and", "for", "of", "to"])

function localPaths(directory: string) {
  const root = Filesystem.resolve(directory)
  const config = path.join(root, ".opencode")
  return {
    root,
    config,
    plugins: path.join(config, "plugins"),
    pluginSources: path.join(config, "plugin-sources"),
    skills: path.join(config, "skills"),
  }
}

function targetName(file: string) {
  return path.basename(file).replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "") || "item"
}

function archiveName(file: string) {
  return targetName(
    path
      .basename(file)
      .replace(/\.tar\.gz$/i, "")
      .replace(/\.tgz$/i, "")
      .replace(/\.(zip|tar)$/i, ""),
  )
}

function appConfigFiles(directory: string) {
  const config = localPaths(directory).config
  return [path.join(config, "app.jsonc"), path.join(config, "app.json")]
}

function configFileRows(directory: string) {
  const paths = localPaths(directory)
  const dirs = [
    { dir: Global.Path.config, scope: "global" as const, source: "global" },
    ...(Flag.OPENCODE_CONFIG_DIR
      ? [{ dir: Flag.OPENCODE_CONFIG_DIR, scope: "global" as const, source: "config-dir" }]
      : []),
    { dir: paths.config, scope: "project" as const, source: "project" },
  ]
  const rows = dirs.flatMap((dir) => [
    ...["opencode.jsonc", "opencode.json", "config.json"].map((name) => ({
      ...dir,
      target: "server" as const,
      file: path.join(dir.dir, name),
    })),
    ...["tui.jsonc", "tui.json"].map((name) => ({
      ...dir,
      target: "tui" as const,
      file: path.join(dir.dir, name),
    })),
    ...["app.jsonc", "app.json"].map((name) => ({
      ...dir,
      target: "app" as const,
      file: path.join(dir.dir, name),
    })),
  ])
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = `${row.target}:${Filesystem.resolve(row.file)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function exists(file: string) {
  return stat(file)
    .then(() => true)
    .catch(() => false)
}

function pluginSpec(item: unknown) {
  if (typeof item === "string") return item
  if (!Array.isArray(item)) return undefined
  return typeof item[0] === "string" ? item[0] : undefined
}

function parseJsoncFile(text: string, file: string) {
  const errors: ParseError[] = []
  const data = parse(text, errors, { allowTrailingComma: true })
  if (!errors.length) return data
  const error = errors[0]
  const lines = text.substring(0, error.offset).split("\n")
  throw new Error(`${file}:${lines.length}:${lines[lines.length - 1].length + 1} ${printParseErrorCode(error.error)}`)
}

async function readPluginConfig(file: string) {
  const text = await Filesystem.readText(file).catch(() => undefined)
  if (text === undefined) return { text: "{}", list: [] as unknown[], data: undefined as unknown }
  const data = parseJsoncFile(text.trim() ? text : "{}", file)
  const list =
    data && typeof data === "object" && !Array.isArray(data) && Array.isArray((data as { plugin?: unknown }).plugin)
      ? (data as { plugin: unknown[] }).plugin
      : []
  return { text: text.trim() ? text : "{}", list, data }
}

function specPath(spec: string, configFile: string) {
  if (spec.startsWith("file://")) return fileURLToPath(spec)
  if (path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return spec
  if (!spec.startsWith(".")) return undefined
  return path.resolve(path.dirname(configFile), spec)
}

function localItemPath(spec: string | undefined, configFile: string | undefined, root: string) {
  if (!spec || !configFile) return undefined
  const resolved = specPath(spec, configFile)
  if (!resolved) return undefined
  const next = Filesystem.resolve(resolved)
  return Filesystem.contains(root, next) ? next : undefined
}

function localPluginRoot(spec: string | undefined, configFile: string | undefined, root: string) {
  const resolved = localItemPath(spec, configFile, root)
  if (!resolved) return undefined
  const rel = path.relative(Filesystem.resolve(root), resolved)
  const top = rel.split(path.sep).filter(Boolean)[0]
  if (!top || top === "..") return undefined
  return path.join(root, top)
}

async function pluginName(input: { spec: string; target: PluginTarget; configFile?: string; path?: string }) {
  const resolved = input.path ?? (input.configFile ? specPath(input.spec, input.configFile) : undefined)
  const info = await pluginPackageInfo(input.spec, input.configFile, resolved)
  const configured = stringValue(info?.displayName) ?? stringValue(info?.productName)
  if (configured) return configured

  const opencode = info?.opencode
  if (opencode && typeof opencode === "object" && !Array.isArray(opencode)) {
    const configured = stringValue((opencode as { displayName?: unknown }).displayName)
    if (configured) return configured
  }
  return humanPluginName(stringValue(info?.name) ?? resolved ?? input.spec, input.target)
}

async function pluginPackageInfo(spec: string, configFile: string | undefined, resolved: string | undefined) {
  if (resolved) {
    const info = await stat(resolved).catch(() => undefined)
    const dir = info?.isDirectory() ? resolved : path.dirname(resolved)
    return Filesystem.readJson<Record<string, unknown>>(path.join(dir, "package.json")).catch(() => undefined)
  }
  if (!configFile) return
  return Filesystem.readJson<Record<string, unknown>>(
    path.join(path.dirname(configFile), "node_modules", ...parsePluginSpecifier(spec).pkg.split("/"), "package.json"),
  ).catch(() => undefined)
}

function stringValue(value: unknown) {
  if (typeof value !== "string") return
  const next = value.trim()
  return next || undefined
}

function humanPluginName(value: string, target: PluginTarget) {
  const pkg = parsePluginSpecifier(value).pkg.replace(/\\/g, "/").replace(/\/+$/, "")
  const base = path.posix.basename(pkg)
  const stem = base.slice(0, base.length - path.posix.extname(base).length) || base
  const words = stem.split(/[-_.\s]+/).filter(Boolean)
  const trimmed = target === "app" && words.at(-1)?.toLowerCase() === "app" ? words.slice(0, -1) : words
  const normalized = trimmed.filter((word, index) => word.toLowerCase() !== "opencode" || index === 0)
  return normalized
    .map((word, index) => {
      const lower = word.toLowerCase()
      if (pluginWordNames[lower]) return pluginWordNames[lower]
      if (index > 0 && pluginNameConnectors.has(lower)) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(" ")
    .replace(/\bMulti Agent\b/g, "Multi-Agent")
}

async function removePluginSpec(input: UninstallPluginInput) {
  const files = input.file ? [input.file] : appConfigFiles(input.directory)
  for (const file of files) {
    const config = await readPluginConfig(file)
    const index = config.list.findIndex((item) => pluginSpec(item) === input.spec)
    if (index === -1) continue
    const text = applyEdits(
      config.text,
      modify(config.text, ["plugin", index], undefined, {
        formattingOptions: { tabSize: 2, insertSpaces: true },
      }),
    )
    await Filesystem.write(file, text)
    return file
  }
}

async function safeRemove(target: string, root: string) {
  const next = Filesystem.resolve(target)
  const base = Filesystem.resolve(root)
  if (!Filesystem.contains(base, next)) throw new Error(`Refusing to delete outside ${base}: ${next}`)
  await rm(next, { force: true, recursive: true })
}

function skillInfoFromFrontmatter(text: string, fallback: string) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const lines = match?.[1]?.split(/\r?\n/) ?? []
  const rawName = lines.find((item) => /^name:\s*/.test(item))?.replace(/^name:\s*/, "").trim()
  const rawDescription = lines.find((item) => /^description:\s*/.test(item))?.replace(/^description:\s*/, "").trim()
  return {
    name: targetName((rawName || fallback).replace(/^['"]|['"]$/g, "")),
    description: rawDescription?.replace(/^['"]|['"]$/g, ""),
  }
}

function safeArchivePath(root: string, entry: string) {
  const normalized = path.posix.normalize(entry.replace(/\\/g, "/"))
  if (!normalized || normalized === "." || normalized === "..") return
  if (normalized.startsWith("../") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return
  const target = Filesystem.resolve(path.join(root, ...normalized.split("/")))
  return Filesystem.contains(Filesystem.resolve(root), target) ? target : undefined
}

async function extractZipArchive(file: string, dir: string) {
  const reader = new ZipReader(new BlobReader(new Blob([await readFile(file)])))
  try {
    for (const entry of await reader.getEntries()) {
      const target = safeArchivePath(dir, entry.filename)
      if (!target) throw new Error(`Archive contains unsafe path: ${entry.filename}`)
      if (entry.directory) {
        await mkdir(target, { recursive: true })
        continue
      }
      const data = await entry.getData?.(new BlobWriter())
      if (!data) continue
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, Buffer.from(await data.arrayBuffer()))
    }
  } finally {
    await reader.close()
  }
}

async function extractTarArchive(file: string, dir: string) {
  const list = await Process.run(["tar", "-tf", file], { nothrow: true })
  if (list.code !== 0) {
    const message = list.stderr.toString().trim() || "tar is not available or could not read this archive"
    throw new Error(message)
  }
  for (const entry of list.stdout.toString().split(/\r?\n/).filter(Boolean)) {
    if (!safeArchivePath(dir, entry)) throw new Error(`Archive contains unsafe path: ${entry}`)
  }
  const out = await Process.run(["tar", "-xf", file, "-C", dir], { nothrow: true })
  if (out.code !== 0) throw new Error(out.stderr.toString().trim() || "Failed to extract archive")
}

async function archiveRoot(dir: string, fallback: string) {
  const items = (await readdir(dir, { withFileTypes: true })).filter(
    (item) => item.name !== "__MACOSX" && item.name !== ".DS_Store",
  )
  const hasRootMarker = await hasPluginIndex(dir)
  if (hasRootMarker || (await exists(path.join(dir, "package.json"))) || (await exists(path.join(dir, "SKILL.md")))) {
    return { source: dir, name: fallback }
  }
  const dirs = items.filter((item) => item.isDirectory())
  if (dirs.length === 1) return { source: path.join(dir, dirs[0]!.name), name: dirs[0]!.name }
  throw new Error("Archive must contain one plugin/skill folder or package.json, index.*, or SKILL.md at its root")
}

function archiveKind(file: string) {
  const lower = file.toLowerCase()
  if (lower.endsWith(".zip")) return "zip"
  if (lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar"
}

async function prepareSource(input: string): Promise<PreparedSource | InstallResult> {
  const source = Filesystem.resolve(input)
  const sourceStat = await stat(source).catch(() => undefined)
  if (!sourceStat) return { ok: false, code: "invalid_source", message: `Source does not exist: ${source}` }
  if (sourceStat.isDirectory()) return { source, name: path.basename(source) }

  const kind = archiveKind(source)
  if (!kind) return { source, name: path.basename(source) }

  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-extension-"))
  try {
    if (kind === "zip") await extractZipArchive(source, temp)
    if (kind === "tar") await extractTarArchive(source, temp)
    const root = await archiveRoot(temp, archiveName(source))
    return { ...root, cleanup: () => rm(temp, { force: true, recursive: true }) }
  } catch (error) {
    await rm(temp, { force: true, recursive: true })
    const message = error instanceof Error ? error.message : "Failed to extract archive"
    return { ok: false, code: "invalid_source", message }
  }
}

async function hasPluginIndex(dir: string) {
  for (const name of ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"]) {
    if (await exists(path.join(dir, name))) return true
  }
  return false
}

function targetKind(target: Target): PluginTarget {
  return target.kind
}

async function pluginInstallItem(input: {
  target: string
  spec: string
  targets: PluginTarget[]
  file?: string
  configFile?: string
}): Promise<ListItem> {
  return {
    id: `plugin:${input.spec}`,
    kind: "plugin",
    name: await pluginName({ spec: input.spec, target: input.targets[0] ?? "unknown", path: input.target }),
    target: input.targets[0],
    targets: input.targets,
    source: "project",
    scope: "project",
    spec: input.spec,
    path: input.target,
    file: input.file,
    configFile: input.configFile,
    removable: true,
  }
}

async function installedProjectPlugin(input: {
  directory: string
  target: string
  spec: string
  targets: PluginTarget[]
}) {
  const items = (await listPluginExtensions(input.directory)).filter(
    (item) => item.scope === "project" && item.spec === input.spec && item.path === input.target,
  )
  const configured = new Set(items.map((item) => item.target).filter((target): target is PluginTarget => Boolean(target)))
  if (!input.targets.every((target) => configured.has(target))) return
  return pluginInstallItem({
    target: input.target,
    spec: input.spec,
    targets: input.targets,
    file: items[0]?.file,
    configFile: items[0]?.configFile,
  })
}

async function detectPluginTargets(source: string) {
  const manifest = await readPluginManifest(source).catch(() => undefined)
  if (manifest?.ok) return manifest.targets.map(targetKind)
  const sourceStat = await stat(source).catch(() => undefined)
  if (sourceStat?.isDirectory() && (await hasPluginIndex(source))) return ["app" as const]
  if (sourceStat?.isFile() && /\.(cjs|js|mjs|ts|tsx)$/i.test(source)) return ["app" as const]
  return []
}

async function patchPluginTargets(input: { paths: ReturnType<typeof localPaths>; spec: string; targets: PluginTarget[] }) {
  const targets = input.targets
    .filter((target): target is Exclude<PluginTarget, "unknown"> => target !== "unknown")
    .map((kind) => ({ kind }))
  if (!targets.length) return { ok: false as const, code: "patch_failed" as const, message: "No plugin targets found" }
  return patchPluginConfig(
    {
      spec: input.spec,
      targets,
      force: true,
      vcs: "git",
      worktree: input.paths.root,
      directory: input.paths.root,
    },
    {
      readText: Filesystem.readText,
      write: Filesystem.write,
      exists,
      files: (dir, name) => [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)],
    },
  )
}

async function listPluginExtensions(directory: string) {
  const paths = localPaths(directory)
  const groups = await Promise.all(
    configFileRows(directory).map(async (row) => {
      const config = await readPluginConfig(row.file)
      return Promise.all(
        config.list.map(async (item, index): Promise<ListItem | undefined> => {
          const spec = pluginSpec(item)
          if (!spec) return
          const local = localPluginRoot(spec, row.file, paths.plugins)
          const projectConfig = Filesystem.contains(paths.config, row.file)
          return {
            id: `plugin:${row.target}:${row.file}:${index}`,
            kind: "plugin",
            name: await pluginName({ spec, target: row.target, configFile: row.file, path: local }),
            target: row.target,
            targets: [row.target],
            source: row.source,
            scope: row.scope,
            spec,
            path: local,
            file: row.file,
            configFile: row.file,
            removable: Boolean(local && projectConfig),
            reason: local && projectConfig ? undefined : "Nicht projektlokal",
          }
        }),
      )
    }),
  ).catch(() => [] as Array<Array<ListItem | undefined>>)
  const seen = new Set<string>()
  return groups.flat().filter(isListItem).filter((item) => {
    const key = pluginIdentity(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function skillFromDirectory(input: {
  dir: string
  scope: ExtensionScope
  source: string
  removable: boolean
  reason?: string
}): Promise<ListItem | undefined> {
  const file = path.join(input.dir, "SKILL.md")
  if (!(await exists(file))) return
  const info = skillInfoFromFrontmatter(await Filesystem.readText(file), path.basename(input.dir))
  return {
    id: `skill:${file}`,
    kind: "skill",
    name: info.name,
    target: "unknown",
    source: input.source,
    scope: input.scope,
    path: input.dir,
    file,
    description: info.description,
    removable: input.removable,
    reason: input.reason,
  } satisfies ListItem
}

function isListItem(item: ListItem | undefined): item is ListItem {
  return item !== undefined
}

function pluginIdentity(item: ListItem) {
  return `${item.target ?? "unknown"}:${item.path ? Filesystem.resolve(item.path) : item.spec ? parsePluginSpecifier(item.spec).pkg : item.id}`
}

async function directSkillDirs(root: string) {
  return readdir(root, { withFileTypes: true })
    .then((items) => items.filter((item) => item.isDirectory()).map((item) => path.join(root, item.name)))
    .catch(() => [] as string[])
}

async function nestedSkillDirs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const current = entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md") ? [root] : []
  const nested = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => nestedSkillDirs(path.join(root, entry.name))),
  )
  return [...current, ...nested.flat()]
}

function readSkillPathConfig(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { paths: [] as string[], urls: [] as string[] }
  const skills = (data as { skills?: unknown }).skills
  if (!skills || typeof skills !== "object" || Array.isArray(skills)) return { paths: [] as string[], urls: [] as string[] }
  const paths = Array.isArray((skills as { paths?: unknown }).paths)
    ? (skills as { paths: unknown[] }).paths.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : []
  const urls = Array.isArray((skills as { urls?: unknown }).urls)
    ? (skills as { urls: unknown[] }).urls.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : []
  return { paths, urls }
}

async function listSkillExtensions(directory: string) {
  const paths = localPaths(directory)
  const home = os.homedir()
  const roots = [
    { root: path.join(paths.config, "skills"), scope: "project" as const, source: "project", removable: true },
    { root: path.join(paths.config, "skill"), scope: "project" as const, source: "project", removable: true },
    { root: path.join(Global.Path.config, "skills"), scope: "global" as const, source: "global", removable: false },
    { root: path.join(Global.Path.config, "skill"), scope: "global" as const, source: "global", removable: false },
    { root: path.join(home, ".agents", "skills"), scope: "external" as const, source: ".agents", removable: false },
    { root: path.join(home, ".claude", "skills"), scope: "external" as const, source: ".claude", removable: false },
  ]
  const direct = (
    await Promise.all(
      roots.map(async (root) =>
        Promise.all(
          (await directSkillDirs(root.root)).map((dir) =>
            skillFromDirectory({
              dir,
              scope: root.scope,
              source: root.source,
              removable: root.removable && Filesystem.contains(paths.skills, dir),
              reason: root.removable && Filesystem.contains(paths.skills, dir) ? undefined : "Nicht projektlokal",
            }),
          ),
        ),
      ),
    )
  )
    .flat()
    .filter(isListItem)

  const fromConfig = (
    await Promise.all(
      configFileRows(directory)
        .filter((row) => row.target === "server")
        .map(async (row) => {
          const config = await readPluginConfig(row.file)
          const skillConfig = readSkillPathConfig(config.data)
          const pathItems = (
            await Promise.all(
              skillConfig.paths.map(async (raw) => {
                const root = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(row.file), raw)
                return Promise.all(
                  (await nestedSkillDirs(root)).map((dir) =>
                    skillFromDirectory({
                      dir,
                      scope: row.scope,
                      source: row.source,
                      removable: false,
                      reason: "Nicht projektlokal",
                    }),
                  ),
                )
              }),
            )
          ).flat()
          return [
            ...pathItems.filter(isListItem),
            ...skillConfig.urls.map(
              (url, index): ListItem => ({
                id: `skill-url:${row.file}:${index}`,
                kind: "skill",
                name: url,
                target: "unknown",
                source: row.source,
                scope: row.scope,
                spec: url,
                file: row.file,
                configFile: row.file,
                removable: false,
                reason: "Nicht projektlokal",
              }),
            ),
          ]
        }),
    )
  ).flat()

  const seen = new Set<string>()
  return [...direct, ...fromConfig].filter((item) => {
    const key = item.path ?? item.spec ?? item.id
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function listLocalExtensions(directory: string) {
  const plugins = await listPluginExtensions(directory)
  const skills = await listSkillExtensions(directory)
  return { plugins, skills }
}

export async function installLocalPlugin(input: InstallInput): Promise<InstallResult> {
  const paths = localPaths(input.directory)
  const prepared = await prepareSource(input.source)
  if ("ok" in prepared) return prepared
  try {
    const sourceStat = await stat(prepared.source).catch(() => undefined)
    if (!sourceStat) return { ok: false, code: "invalid_source", message: `Source does not exist: ${prepared.source}` }
    const targets = await detectPluginTargets(prepared.source)
    if (!targets.length) {
      return {
        ok: false,
        code: "invalid_source",
        message: "Select a plugin folder with package.json exports or an index.js/index.ts entrypoint",
      }
    }
    const target = path.join(paths.plugins, targetName(prepared.name))
    const spec = `./plugins/${path.basename(target)}`
    if ((await exists(target)) && !input.force) {
      const item = await installedProjectPlugin({ directory: paths.root, target, spec, targets })
      if (item) {
        AppPluginAssets.invalidate()
        return { ok: true, item }
      }
      return {
        ok: false,
        code: "target_exists",
        target,
        message: `Plugin target already exists: ${target}. Confirm overwrite to replace it.`,
      }
    }

    await mkdir(paths.plugins, { recursive: true })
    if (input.force) await rm(target, { force: true, recursive: true })
    await cp(prepared.source, target, { recursive: sourceStat.isDirectory(), force: true })

    const patch = await patchPluginTargets({ paths, spec, targets })
    if (!patch.ok) return { ok: false, code: "patch_failed", message: `Failed to update config: ${patch.code}` }

    AppPluginAssets.invalidate()
    return {
      ok: true,
      item: await pluginInstallItem({
        target,
        spec,
        targets,
        file: patch.items[0]?.file,
        configFile: patch.items[0]?.file,
      }),
    }
  } finally {
    await prepared.cleanup?.()
  }
}

export async function uninstallLocalPlugin(input: UninstallPluginInput) {
  const paths = localPaths(input.directory)
  const target = input.file ? localPluginRoot(input.spec, input.file, paths.plugins) : undefined
  if (target && !Filesystem.contains(paths.plugins, target)) {
    throw new Error(`Refusing to delete non-local plugin: ${target}`)
  }
  if (target) await requireCommittedPluginSource(paths, target)
  const removedFrom = await removePluginSpec(input)
  if (target && input.deleteFiles !== false) await safeRemove(target, paths.plugins)
  AppPluginAssets.invalidate()
  return { ok: true, removedFrom, removedPath: input.deleteFiles === false ? undefined : target }
}

async function requireCommittedPluginSource(paths: ReturnType<typeof localPaths>, target: string) {
  const source = path.join(paths.pluginSources, path.basename(target))
  if (!(await exists(source))) {
    throw new Error(`Plugin uninstall blocked: durable source folder is missing: ${source}`)
  }

  const repository = await Process.run(["git", "rev-parse", "--show-toplevel"], {
    cwd: paths.root,
    nothrow: true,
  })
  if (repository.code !== 0) {
    throw new Error(`Plugin uninstall blocked: source folder is not in a Git repository: ${source}`)
  }

  const root = repository.stdout.toString().trim()
  if (!root || !Filesystem.contains(root, source)) {
    throw new Error(`Plugin uninstall blocked: source folder is outside the project Git repository: ${source}`)
  }
  const relative = path.relative(root, source).split(path.sep).join("/")
  const tracked = await Process.run(["git", "ls-files", "--", relative], { cwd: root, nothrow: true })
  if (!tracked.stdout.toString().trim()) {
    throw new Error(`Plugin uninstall blocked: source folder is not committed to Git: ${source}`)
  }
  const status = await Process.run(["git", "status", "--porcelain=v1", "--untracked-files=all", "--", relative], {
    cwd: root,
    nothrow: true,
  })
  if (status.code !== 0 || status.stdout.toString().trim()) {
    throw new Error(`Plugin uninstall blocked: source folder has uncommitted changes: ${source}`)
  }

  const parity = await Process.run(["git", "diff", "--no-index", "--quiet", "--", source, target], {
    cwd: root,
    nothrow: true,
  })
  if (parity.code === 0) return
  if (parity.code === 1) {
    throw new Error(`Plugin uninstall blocked: runtime differs from committed source folder: ${source}`)
  }
  throw new Error(`Plugin uninstall blocked: source/runtime comparison failed for ${source}`)
}

export async function installLocalSkill(input: InstallInput): Promise<InstallResult> {
  const paths = localPaths(input.directory)
  const prepared = await prepareSource(input.source)
  if ("ok" in prepared) return prepared
  try {
    const skillFile = path.join(prepared.source, "SKILL.md")
    if (!(await exists(skillFile))) {
      return { ok: false, code: "invalid_source", message: "Select a skill folder or archive containing SKILL.md" }
    }
    const info = skillInfoFromFrontmatter(await Filesystem.readText(skillFile), path.basename(prepared.source))
    const target = path.join(paths.skills, info.name)
    if ((await exists(target)) && !input.force) {
      if (!(await exists(path.join(target, "SKILL.md")))) {
        return {
          ok: false,
          code: "target_exists",
          target,
          message: `Skill target already exists: ${target}. Confirm overwrite to replace it.`,
        }
      }
      return {
        ok: true,
        item: {
          id: `skill:${info.name}`,
          kind: "skill",
          name: info.name,
          target: "unknown",
          source: "project",
          scope: "project",
          path: target,
          file: path.join(target, "SKILL.md"),
          description: info.description,
          removable: true,
        },
      }
    }

    await mkdir(paths.skills, { recursive: true })
    if (input.force) await rm(target, { force: true, recursive: true })
    await cp(prepared.source, target, { recursive: true, force: true })
    return {
      ok: true,
      item: {
        id: `skill:${info.name}`,
        kind: "skill",
        name: info.name,
        target: "unknown",
        source: "project",
        scope: "project",
        path: target,
        file: path.join(target, "SKILL.md"),
        description: info.description,
        removable: true,
      },
    }
  } finally {
    await prepared.cleanup?.()
  }
}

export async function uninstallLocalSkill(input: UninstallSkillInput) {
  const paths = localPaths(input.directory)
  const target = input.path ? Filesystem.resolve(input.path) : path.join(paths.skills, targetName(input.name))
  await safeRemove(target, paths.skills)
  return { ok: true, removedPath: target }
}

export * as LocalExtensionManager from "./local-manager"
