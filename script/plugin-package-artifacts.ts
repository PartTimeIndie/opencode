import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { requirePluginAPIs } from "../packages/plugin/src/api"
import { auditPluginSources } from "./audit-plugin-sources"

/** Build outputs and manifests only: detached packages must not depend on checkout node_modules. */
export function copyPluginPackages(source: string, destination: string) {
  if (fs.existsSync(destination)) throw new Error(`Plugin artifact destination already exists: ${destination}`)
  const artifacts = fs.readdirSync(source, { withFileTypes: true }).filter((entry) => entry.isDirectory() && fs.existsSync(path.join(source, entry.name, "package.json"))).map((entry) => {
    const directory = path.join(source, entry.name)
    auditPluginSources(directory)
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))
    requirePluginAPIs(manifest.name, manifest.opencode?.api)
    for (const target of Object.values(manifest.exports ?? {})) {
      if (typeof target !== "string" || !target.startsWith("./dist/")) throw new Error(`Plugin export is not a built artifact: ${manifest.name}`)
      const relative = path.relative(directory, path.resolve(directory, target))
      if (relative.startsWith("..") || !fs.statSync(path.join(directory, relative)).isFile()) throw new Error(`Plugin export is missing: ${manifest.name}`)
    }
    const output = path.join(destination, entry.name)
    fs.mkdirSync(output, { recursive: true })
    fs.cpSync(path.join(directory, "dist"), path.join(output, "dist"), { recursive: true, errorOnExist: true, force: false })
    fs.copyFileSync(path.join(directory, "package.json"), path.join(output, "package.json"))
    const files: Array<{path: string; sha256: string}> = []
    const scan = (folder: string) => fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((file) => {
      if (file.isSymbolicLink()) throw new Error(`Symlink in plugin artifact: ${file.name}`)
      if (file.isDirectory()) return scan(path.join(folder, file.name))
      files.push({ path: path.relative(output, path.join(folder, file.name)).replaceAll("\\", "/"), sha256: createHash("sha256").update(fs.readFileSync(path.join(folder, file.name))).digest("hex") })
    })
    scan(output)
    return { directory: entry.name, name: manifest.name, version: manifest.version, api: manifest.opencode?.api ?? {}, files,
      sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex") }
  })
  if (!artifacts.length) throw new Error(`No built plugin packages: ${source}`)
  fs.writeFileSync(path.join(destination, "release-manifest.json"), JSON.stringify({ artifacts }, null, 2))
  return artifacts
}
