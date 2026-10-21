import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
import { requirePluginAPIs } from "@opencode-ai/plugin/api"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises"
import { constants, existsSync } from "node:fs"
import { createHash } from "node:crypto"

type PackageManifest = {
  exports?: Record<string, unknown>
  opencode?: { api?: unknown }
}

export function providerPackageDirectory() {
  if (process.env.OPENCODE_PROVIDER_PLUGIN_DIR) return process.env.OPENCODE_PROVIDER_PLUGIN_DIR
  const installed = path.join(path.dirname(process.execPath), "plugin-packages", "provider")
  return existsSync(path.join(installed, "release-manifest.json"))
    ? installed
    : fileURLToPath(new URL("../../../provider-plugins/", import.meta.url))
}

export function providerCachePath(root: string, owner: string, name: string) {
  if (!name || name === "." || name === ".." || /[\\/:]/.test(name)) throw new Error("Invalid provider cache name")
  return path.join(root, "provider-plugins", createHash("sha256").update(owner).digest("hex"), name)
}

export function readProviderCache(root: string, owner: string, name: string, signal: AbortSignal) {
  signal.throwIfAborted()
  return readFile(providerCachePath(root, owner, name), { encoding: "utf8", signal }).then(
    (value) => JSON.parse(value) as unknown,
  )
}

export async function migrateProviderCaches(
  root: string,
  mappings: readonly { owner: string; source: string; target: string }[],
) {
  for (const mapping of mappings) {
    for (const name of [mapping.source, mapping.target])
      if (!name || name === "." || name === ".." || /[\\/:]/.test(name))
        throw new Error("Invalid provider cache migration path")
    const directory = path.join(root, "provider-plugins", createHash("sha256").update(mapping.owner).digest("hex"))
    await mkdir(directory, { recursive: true })
    await copyFile(
      path.join(root, mapping.source),
      path.join(directory, mapping.target),
      constants.COPYFILE_EXCL,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error
    })
  }
}

/** Preinstalled and configured packages use this identical manifest/version/import path. */
export async function loadProviderPackage(spec: string, resolve: (specifier: string) => Promise<string>) {
  const directory = spec.startsWith("file://")
    ? fileURLToPath(spec)
    : path.isAbsolute(spec)
      ? spec
      : await resolve(spec)
  if (!(await stat(directory)).isDirectory()) return
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as PackageManifest
  const entry = manifest.exports?.["./provider"]
  // The same configured package may contain only app, server, or TUI entrypoints.
  if (entry === undefined) return
  requirePluginAPIs(spec, manifest.opencode?.api)
  if (!manifest.opencode?.api || typeof manifest.opencode.api !== "object" || !("provider" in manifest.opencode.api))
    throw new Error(`Provider plugin ${spec} must declare its provider API requirement`)
  if (typeof entry !== "string" || !entry.startsWith("./"))
    throw new Error(`Provider plugin ${spec} has an invalid ./provider export`)
  const target = path.resolve(directory, entry)
  const relative = path.relative(directory, target)
  if (relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative))
    throw new Error(`Provider plugin ${spec} exports a file outside its package`)
  const [canonicalDirectory, canonicalTarget] = await Promise.all([realpath(directory), realpath(target)])
  const canonicalRelative = path.relative(canonicalDirectory, canonicalTarget)
  if (canonicalRelative.startsWith(".." + path.sep) || canonicalRelative === ".." || path.isAbsolute(canonicalRelative))
    throw new Error(`Provider plugin ${spec} exports a file outside its package`)
  const imported: unknown = await import(pathToFileURL(canonicalTarget).href)
  const value = imported && typeof imported === "object" && "default" in imported ? imported.default : undefined
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    !("provider" in value) ||
    typeof value.provider !== "function"
  )
    throw new Error(`Provider plugin ${spec} must default export { id, provider }`)
  if (
    "integrations" in value &&
    (!Array.isArray(value.integrations) || value.integrations.some((id) => typeof id !== "string" || !id.trim()))
  )
    throw new Error(`Provider plugin ${spec} has invalid integration permissions`)
  for (const key of ["configure", "configureCatalog", "prepareTransport", "modelDefaults", "selectSmallModel"])
    if (key in value && typeof Reflect.get(value, key) !== "function")
      throw new Error(`Provider plugin ${spec} has invalid ${key} hook`)
  for (const key of ["transforms", "transports"])
    if (key in value) {
      const hooks = Reflect.get(value, key)
      if (
        !hooks ||
        typeof hooks !== "object" ||
        Array.isArray(hooks) ||
        Object.values(hooks).some((hook) => typeof hook !== "function")
      )
        throw new Error(`Provider plugin ${spec} has invalid ${key} hooks`)
    }
  return value as ProviderPluginModule
}
