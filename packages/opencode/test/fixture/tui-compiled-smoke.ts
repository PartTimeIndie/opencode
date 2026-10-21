import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import { runtimeModules } from "@opentui/keymap/runtime-modules"
import { RGBA } from "@opentui/core"
import { createSignal } from "solid-js"
import { useBindings } from "@opentui/keymap/solid"
import { requirePluginAPIs } from "@opencode-ai/plugin/api"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

ensureRuntimePluginSupport({ additional: runtimeModules })
const directory = process.argv[2]
const probe = await import(pathToFileURL(path.join(directory, "peer-probe.js")).href)
if (probe.RGBA !== RGBA || probe.createSignal !== createSignal || probe.useBindings !== useBindings)
  throw new Error("Plugin peer modules do not share host runtime identity")
const packages = []
for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const root = path.join(directory, entry.name)
  const file = Bun.file(path.join(root, "package.json"))
  if (!(await file.exists())) continue
  const manifest = await file.json()
  requirePluginAPIs(manifest.name, manifest.opencode.api)
  const loaded = await import(pathToFileURL(path.join(root, manifest.exports["./tui"])).href)
  if (typeof loaded.default?.tui !== "function") throw new Error(`Missing TUI factory in ${manifest.name}`)
  packages.push({ name: manifest.name, id: loaded.default.id })
}
if (packages.length !== 12) throw new Error(`Expected twelve packages, loaded ${packages.length}`)
console.log(JSON.stringify({ runtimeIdentity: true, packages }))
