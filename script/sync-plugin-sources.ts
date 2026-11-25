import { existsSync } from "fs"
import { cp, lstat, mkdir, readdir, rm } from "fs/promises"
import path from "path"
import { selectPluginSources } from "./sync-plugin-selection"

const sourceRoot = path.join(process.cwd(), ".opencode", "plugin-sources")
const targetRoot = path.join(process.cwd(), ".opencode", "plugins")

const sources = (await readdir(sourceRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory())
const selected = new Set(selectPluginSources(sources.map((entry) => entry.name), process.argv.slice(2)))
const plugins = sources.filter((entry) => selected.has(entry.name))

await mkdir(targetRoot, { recursive: true })

await Promise.all(
  plugins.map(async (plugin) => {
    const source = path.join(sourceRoot, plugin.name)
    const target = path.join(targetRoot, plugin.name)

    if (existsSync(target) && (await lstat(target)).isSymbolicLink()) {
      throw new Error(`Refusing to replace symlinked plugin target: ${target}`)
    }

    await rm(target, { recursive: true, force: true })
    await cp(source, target, { recursive: true })
    console.log(`synced ${path.relative(process.cwd(), source)} -> ${path.relative(process.cwd(), target)}`)
  }),
)
