#!/usr/bin/env bun
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { requirePluginAPIs } from "@opencode-ai/plugin/api"
import { auditPluginSources } from "../../../script/audit-plugin-sources"
import { releaseTargetHash } from "./desktop-release-files"

const root = path.resolve(import.meta.dir, "../../..")
const serverPackages = ["opencode-scheduler", "opencode-runtime-services", "opencode-voice-conversation", "opencode-review", "opencode-problem-solver", "opencode-openrouter-media"]

export function preparePluginRelease(input: { output: string; configDirectory: string; sourceRoot: string; serverRoot: string }) {
  if (fs.existsSync(input.output)) throw new Error("Use a fresh immutable plugin release output directory")
  const entries: Array<{ source: string; target: string; expectedBaseHash: string | null }> = []
  const packages: Array<{name: string; version: string; api: Record<string, number>; sha256: string}> = []
  const configFile = path.join(input.configDirectory, "opencode.json")
  const configBaseline = releaseTargetHash(configFile)
  const contents = fs.readFileSync(configFile, "utf8")
  if (releaseTargetHash(configFile) !== configBaseline) throw new Error("Configuration changed while reading the release input")
  const errors: ParseError[] = []
  const config = parse(contents, errors) as { plugin?: unknown[] }
  if (errors.length || !config || typeof config !== "object" || (config.plugin !== undefined && !Array.isArray(config.plugin))) throw new Error("Cannot prepare invalid global plugin configuration")
  const replacements = new Map<string, string>()
  const retained = new Set<string>()
  fs.mkdirSync(input.output, { recursive: true })
  for (const name of serverPackages) {
    const source = path.join(input.serverRoot, name)
    auditPluginSources(source)
    const destination = path.join(input.output, "server", name)
    const manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"))
    requirePluginAPIs(name, manifest.opencode?.api)
    if (!fs.statSync(path.join(source, "dist", "index.js")).isFile()) throw new Error(`Build ${name} before preparing release`)
    fs.mkdirSync(destination, { recursive: true })
    fs.cpSync(path.join(source, "dist"), path.join(destination, "dist"), { recursive: true, errorOnExist: true, force: false })
    fs.copyFileSync(path.join(source, "package.json"), path.join(destination, "package.json"))
    // Old installations may use node_modules junctions into editable source repos.
    // Activate generated packages in their own directory without touching those links.
    const target = path.join(input.configDirectory, "plugin-packages", name)
    entries.push({ source: destination, target, expectedBaseHash: releaseTargetHash(target) })
    replacements.set(name, pathToFileURL(target + path.sep).href)
    packages.push({ name: manifest.name, version: manifest.version, api: manifest.opencode?.api ?? {}, sha256: digest(destination) })
  }
  const plugins = (config.plugin ?? []).filter((entry) => {
    const spec = typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : undefined
    if (
      typeof spec === "string" &&
      (/^chat-chain-manager(?:@[^/]+)?$/.test(spec) ||
        (spec.startsWith("file:") && /\/plugin-packages\/chat-chain-manager\/?$/.test(spec)))
    )
      return false
    // The same provider package now owns both built-in auth and external Cursor hooks.
    if (typeof spec !== "string" || !/^cursor-opencode-provider(?:@[^/]+)?$/.test(spec)) return true
    if (Array.isArray(entry) && entry.length > 1) throw new Error("Cursor plugin options need an explicit migration before release")
    return false
  }).map((entry) => {
    const spec = typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : undefined
    if (typeof spec !== "string") throw new Error("Unknown plugin declaration; refusing to discard it")
    const replacement = serverPackages.find((name) => spec === name || spec.startsWith(name + "@") || spec === replacements.get(name))
    if (!replacement) return entry
    const next = replacements.get(replacement)!
    retained.add(replacement)
    return Array.isArray(entry) ? [next, ...entry.slice(1)] : next
  })
  plugins.push(...[...replacements].filter(([name]) => !retained.has(name)).map(([, spec]) => spec))
  const stagedConfig = path.join(input.output, "opencode.json")
  fs.writeFileSync(stagedConfig, applyEdits(contents, modify(contents, ["plugin"], plugins, { formattingOptions: { insertSpaces: true, tabSize: 2 } })))
  entries.push({ source: stagedConfig, target: configFile, expectedBaseHash: configBaseline })
  const appSource = path.join(input.sourceRoot, ".opencode", "plugin-sources")
  for (const directory of fs.readdirSync(appSource, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const source = path.join(appSource, directory.name)
    auditPluginSources(source)
    const manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"))
    requirePluginAPIs(manifest.name, manifest.opencode?.api)
    const snapshot = path.join(input.output, "app", directory.name)
    fs.cpSync(source, snapshot, { recursive: true, errorOnExist: true, force: false })
    const target = path.join(input.sourceRoot, ".opencode", "plugins", directory.name)
    entries.push({ source: snapshot, target, expectedBaseHash: releaseTargetHash(target) })
    packages.push({ name: manifest.name, version: manifest.version, api: manifest.opencode?.api ?? {}, sha256: digest(snapshot) })
  }
  const descriptor = path.join(input.output, "release-input.json")
  fs.writeFileSync(descriptor, JSON.stringify({ entries, packages }, null, 2))
  return descriptor
}

function digest(directory: string) {
  const hash = createHash("sha256")
  const visit = (folder: string) => fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((entry) => {
    if (entry.isSymbolicLink()) throw new Error(`Plugin source symlink is not allowed: ${entry.name}`)
    const filename = path.join(folder, entry.name)
    if (entry.isDirectory()) return visit(filename)
    hash.update(path.relative(directory, filename).replaceAll("\\", "/"))
    hash.update("\0")
    hash.update(fs.readFileSync(filename))
  })
  visit(directory)
  return hash.digest("hex")
}

if (import.meta.main) console.log(preparePluginRelease({
  output: path.resolve(process.argv[2] ?? path.join(root, ".agent-tmp", "plugin-boundaries", `release-${Date.now()}`)),
  configDirectory: path.join(os.homedir(), ".config", "opencode"), sourceRoot: root, serverRoot: path.dirname(root),
}))
