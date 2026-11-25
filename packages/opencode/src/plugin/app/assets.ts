import { createHash } from "node:crypto"
import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { ConfigParse } from "@/config/parse"
import { ConfigPlugin } from "@/config/plugin"
import { PluginLoader } from "@/plugin/loader"
import { Filesystem } from "@/util/filesystem"
import { isRecord } from "@opencode-ai/core/util/record"
import { pluginDisplayName } from "@opencode-ai/core/util/plugin-name"

type AppPluginConfig = {
  plugin?: ConfigPluginV1.Spec[]
}

type AssetFile = {
  file: string
  hash: string
  mtimeMs: number
  size: number
}

type AssetManifest = {
  id: string
  displayName: string
  spec: string
  version: string
  root: string
  entry: string
  module: string
  hash: string
  capabilities: string[]
  ai: AppPluginAIManifest
  files: Record<string, AssetFile>
}

type AppPluginAIManifest = {
  tools: string[]
}

export type AppPluginClientManifest = {
  id: string
  displayName: string
  spec: string
  version: string
  module: string
  hash: string
  capabilities: string[]
  ai: AppPluginAIManifest
}

const legacyCapabilities = [
  "ui:dock",
  "ui:slots",
  "commands",
  "routes",
  "kv",
  "ui:toolbar",
  "ui:settings",
  "ui:loading",
  "ui:models",
  "client",
  "events",
  "chat:parts",
  "host:projects",
  "host:navigation",
  "host:sessions",
  "host:git",
  "host:http",
  "host:command",
  "automation",
]

const knownCapabilities = new Set([
  ...legacyCapabilities,
  "ui:overlay",
  "ui:floating",
  "host:ai",
  "host:images",
  "host:stt",
  "host:tts",
  "host:audio",
  "host:composer",
  "host:toolbar",
  "host:skills",
  "host:skill-content",
  "host:text-input",
  "host:desktop-services",
  "host:session-policy",
  "host:session-context",
  "host:session-attention",
  "host:session-attention-read",
])

const privateAssetExtensions = new Set([".jks", ".key", ".keystore", ".p12", ".p8", ".pem", ".pfx", ".ppk"])
const privateAssetNames = new Set([
  "credentials.json",
  "credentials.yaml",
  "credentials.yml",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
])

const frozen = new Map<string, Promise<AssetManifest[]>>()

export function resetForTesting() {
  frozen.clear()
}

export function invalidate() {
  frozen.clear()
}

function configFiles(directory: string) {
  const dirs = [Global.Path.config]
  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    const up = Filesystem.findUp(".opencode", directory, undefined, { rootFirst: true })
    return up.then((items) => [
      ...dirs.flatMap((dir) => [path.join(dir, "app.json"), path.join(dir, "app.jsonc")]),
      ...items.flatMap((dir) => [path.join(dir, "app.json"), path.join(dir, "app.jsonc")]),
      ...(Flag.OPENCODE_CONFIG_DIR
        ? [path.join(Flag.OPENCODE_CONFIG_DIR, "app.json"), path.join(Flag.OPENCODE_CONFIG_DIR, "app.jsonc")]
        : []),
    ])
  }
  return Promise.resolve([
    ...dirs.flatMap((dir) => [path.join(dir, "app.json"), path.join(dir, "app.jsonc")]),
    ...(Flag.OPENCODE_CONFIG_DIR
      ? [path.join(Flag.OPENCODE_CONFIG_DIR, "app.json"), path.join(Flag.OPENCODE_CONFIG_DIR, "app.jsonc")]
      : []),
  ])
}

function readPluginSpec(value: unknown): value is ConfigPluginV1.Spec {
  if (typeof value === "string" && value.trim()) return true
  if (!Array.isArray(value) || value.length !== 2) return false
  if (typeof value[0] !== "string" || !value[0].trim()) return false
  return isRecord(value[1])
}

async function loadConfigFile(file: string): Promise<AppPluginConfig | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return
  const data = ConfigParse.jsonc(text, file)
  if (!isRecord(data)) return {}
  const plugins = Array.isArray(data.plugin) ? data.plugin.filter(readPluginSpec) : undefined
  return {
    plugin: plugins?.length
      ? await Promise.all(plugins.map((plugin) => ConfigPlugin.resolvePluginSpec(plugin, file)))
      : undefined,
  }
}

async function pluginOrigins(directory: string) {
  const origins: ConfigPlugin.Origin[] = []
  for (const file of await configFiles(directory)) {
    const config = await loadConfigFile(file).catch((error) => {
      console.warn("[app-plugin] skipping invalid app config", { file, error })
      return undefined
    })
    if (!config?.plugin?.length) continue
    const scope: ConfigPlugin.Scope = Filesystem.contains(directory, file) ? "local" : "global"
    origins.push(...config.plugin.map((spec) => ({ spec, scope, source: file })))
  }
  return ConfigPlugin.deduplicatePluginOrigins(origins)
}

function fileFromUrl(value: string) {
  return value.startsWith("file://") ? fileURLToPath(value) : value
}

async function pluginRoot(row: PluginLoader.Resolved) {
  if (row.pkg?.dir) return Filesystem.resolve(row.pkg.dir)
  const file = fileFromUrl(row.target)
  const stat = await Filesystem.statAsync(file)
  return Filesystem.resolve(stat?.isDirectory() ? file : path.dirname(file))
}

function manifestID(row: PluginLoader.Resolved, root: string) {
  const name = row.pkg?.json.name
  if (typeof name === "string" && name.trim()) return name.trim()
  return path.basename(root).replace(/[^a-zA-Z0-9_.:-]/g, "-")
}

async function hashFile(file: string) {
  return hashContent(await readFile(file))
}

function hashContent(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex")
}

async function assetFile(file: string): Promise<AssetFile> {
  const info = await stat(file)
  return {
    file,
    hash: await hashFile(file),
    mtimeMs: info.mtimeMs,
    size: info.size,
  }
}

async function walkFiles(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries
      .filter((entry) => publishableAsset(entry.name, entry.isDirectory()))
      .map(async (entry) => {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) return walkFiles(root, file)
        if (entry.isFile()) return [file]
        return []
      }),
  )
  return nested.flat()
}

function publishableAsset(name: string, directory: boolean) {
  const lower = name.toLowerCase()
  if (lower.startsWith(".")) return false
  if (directory) return lower !== "node_modules"
  if (privateAssetNames.has(lower)) return false
  return !privateAssetExtensions.has(path.extname(lower))
}

function relativeAsset(root: string, file: string) {
  return path.relative(root, file).split(path.sep).join("/")
}

function manifestContentHash(files: Record<string, AssetFile>) {
  return createHash("sha256")
    .update(
      Object.entries(files)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([file, item]) => `${file}\0${item.hash}`)
        .join("\0"),
    )
    .digest("hex")
}

async function createAssetManifest(origin: ConfigPlugin.Origin) {
  const spec = ConfigPlugin.pluginSpecifier(origin.spec)
  const plan = { spec, options: ConfigPlugin.pluginOptions(origin.spec), deprecated: false }
  const resolved = await PluginLoader.resolve(plan, "app")
  if (!resolved.ok) {
    if (resolved.stage !== "missing") console.warn("[app-plugin] failed to resolve app plugin", { spec, resolved })
    return
  }

  const root = await pluginRoot(resolved.value)
  const entry = Filesystem.resolve(fileFromUrl(resolved.value.entry))
  if (!Filesystem.contains(root, entry)) {
    console.warn("[app-plugin] rejected entry outside plugin root", { spec, root, entry })
    return
  }
  if (!(await Filesystem.statAsync(entry))?.isFile()) {
    console.warn("[app-plugin] skipping app plugin with missing entrypoint", { spec, entry })
    return
  }

  const files = Object.fromEntries(
    await Promise.all((await walkFiles(root)).map(async (file) => [relativeAsset(root, file), await assetFile(file)])),
  )
  const entryRel = relativeAsset(root, entry)
  const entryAsset = files[entryRel]
  if (!entryAsset) {
    console.warn("[app-plugin] skipping app plugin with unavailable entrypoint asset", { spec, entry })
    return
  }
  const contentHash = manifestContentHash(files)
  const packageVersion = resolved.value.pkg?.json.version
  const meta = appPluginMetadata(resolved.value.pkg?.json)
  const version =
    typeof packageVersion === "string" && packageVersion.trim()
      ? `${packageVersion.trim()}-${contentHash.slice(0, 16)}`
      : contentHash.slice(0, 16)

  return {
    id: manifestID(resolved.value, root),
    displayName: pluginDisplayName(manifestID(resolved.value, root), resolved.value.pkg?.json.displayName),
    spec,
    version,
    root,
    entry,
    module: entryRel,
    hash: entryAsset.hash,
    capabilities: meta.capabilities,
    ai: meta.ai,
    files,
  } satisfies AssetManifest
}

export function appPluginMetadata(pkg: Record<string, unknown> | undefined) {
  const opencode = isRecord(pkg?.opencode) ? pkg.opencode : undefined
  const app = isRecord(opencode?.app) ? opencode.app : undefined
  const capabilities =
    stringList(app?.capabilities)?.filter(
      (item) => knownCapabilities.has(item) || /^services:[^:]+:[a-zA-Z0-9._-]+$/.test(item),
    ) ?? legacyCapabilities
  const ai = isRecord(app?.ai) ? app.ai : undefined
  return {
    capabilities,
    ai: { tools: stringList(ai?.tools) ?? [] },
  }
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
}

async function loadManifests(directory = process.cwd()) {
  const seen = new Set<string>()
  const manifests: AssetManifest[] = []
  for (const origin of await pluginOrigins(directory)) {
    const manifest = await createAssetManifest(origin).catch((error) => {
      console.warn("[app-plugin] failed to build app plugin manifest", {
        spec: ConfigPlugin.pluginSpecifier(origin.spec),
        error,
      })
      return undefined
    })
    if (!manifest) continue
    if (seen.has(manifest.id)) {
      console.warn("[app-plugin] duplicate app plugin id", { id: manifest.id, spec: manifest.spec })
      continue
    }
    seen.add(manifest.id)
    manifests.push(manifest)
  }
  return manifests
}

async function manifests(directory = process.cwd()) {
  const key = Filesystem.resolve(directory)
  const cached = frozen.get(key)
  if (cached) {
    const list = await cached
    if (await manifestsCurrent(key, list)) return list
  }
  const next = loadManifests(key)
  frozen.set(key, next)
  return next
}

async function manifestsCurrent(directory: string, list: AssetManifest[]) {
  const currentSpecs = (await pluginOrigins(directory))
    .map((origin) => ConfigPlugin.pluginSpecifier(origin.spec))
    .toSorted()
  if (!sameList(currentSpecs, list.map((plugin) => plugin.spec).toSorted())) return false

  for (const plugin of list) {
    const currentFiles = (await walkFiles(plugin.root)).map((file) => relativeAsset(plugin.root, file)).toSorted()
    if (!sameList(currentFiles, Object.keys(plugin.files).toSorted())) return false

    for (const file of currentFiles) {
      const item = plugin.files[file]
      if (!item) return false
      const info = await stat(item.file).catch(() => undefined)
      if (!info) return false
      if (info.size !== item.size || info.mtimeMs !== item.mtimeMs) return false
    }
  }
  return true
}

function sameList(a: string[], b: string[]) {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

function pluginAssetPath(input: { id: string; version: string; file: string }) {
  return `/app/plugin/${encodeURIComponent(input.id)}/${encodeURIComponent(input.version)}/${input.file
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`
}

export async function clientManifest(directory?: string) {
  return {
    plugins: (await manifests(directory)).map((plugin): AppPluginClientManifest => ({
      id: plugin.id,
      displayName: plugin.displayName,
      spec: plugin.spec,
      version: plugin.version,
      module: pluginAssetPath({ id: plugin.id, version: plugin.version, file: plugin.module }),
      hash: plugin.hash,
      capabilities: plugin.capabilities,
      ai: plugin.ai,
    })),
  }
}

export async function hostPolicy(id: string, version: string, hash: string, directory?: string) {
  // Config or plugin changes can invalidate the manifest cache after the UI has
  // loaded its caller identity. Rebuild the routed directory before checking it.
  const list = directory ? await manifests(directory) : (await Promise.all([...frozen.values()])).flat()
  const plugins = list
    .filter((item) => item.id === id && item.version === version && item.hash === hash)
  const plugin = plugins[0]
  if (!plugin) return
  const capabilities = plugin.capabilities.toSorted()
  const tools = plugin.ai.tools.toSorted()
  if (
    plugins.some(
      (item) => !sameList(item.capabilities.toSorted(), capabilities) || !sameList(item.ai.tools.toSorted(), tools),
    )
  ) {
    return
  }
  return { capabilities: plugin.capabilities, ai: plugin.ai }
}

export const hostAIPolicy = hostPolicy

export async function readAsset(id: string, version: string, file: string) {
  const list = frozen.size ? (await Promise.all([...frozen.values()])).flat() : await manifests()
  const plugin = list.find((item) => item.id === id && item.version === version)
  if (!plugin) return { status: 404 as const, body: "Not found" }
  const normalized = file.replace(/\\/g, "/").replace(/^\/+/, "")
  const item = plugin.files[normalized]
  if (!item) return { status: 404 as const, body: "Not found" }
  const next = Filesystem.resolve(item.file)
  if (!Filesystem.contains(plugin.root, next)) return { status: 404 as const, body: "Not found" }
  const body = await readFile(next)
  if (hashContent(body) !== item.hash)
    return { status: 409 as const, body: "Plugin asset changed after manifest freeze" }
  return {
    status: 200 as const,
    body,
    contentType: await Filesystem.mimeType(next),
  }
}

export * as AppPluginAssets from "./assets"
