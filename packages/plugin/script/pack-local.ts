#!/usr/bin/env bun
import path from "node:path"
import { fileURLToPath } from "node:url"
import { cp, mkdir } from "node:fs/promises"

// Materialize the same public JS/declarations used in a release without
// publishing or changing workspace manifests. Public dependency packages travel together.
const root = fileURLToPath(new URL("../../..", import.meta.url))
const output = path.resolve(process.argv[2] ?? path.join(root, ".agent-tmp/plugin-boundaries/public-sdk"))
const workspace = await Bun.file(path.join(root, "package.json")).json()
const packages = [
  { source: "packages/sdk/js", destination: "sdk" },
  { source: "packages/llm", destination: "llm" },
  { source: "packages/plugin", destination: "plugin" },
]
const receipt = []
for (const item of packages) {
  const source = path.join(root, item.source)
  const manifest = await Bun.file(path.join(source, "package.json")).json()
  const destination = path.join(output, item.destination)
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: path.join(source, "dist"), onlyFiles: true }))
  if (!files.includes("index.d.ts")) throw new Error(`Build ${manifest.name} before packaging`)
  await mkdir(destination, { recursive: true })
  await cp(path.join(source, "dist"), path.join(destination, "dist"), { recursive: true })
  manifest.files = ["dist"]
  manifest.exports = Object.fromEntries(Object.entries(manifest.exports as Record<string, string | { default?: string; import?: string }>).map(([key, value]) => {
    const source = typeof value === "string" ? value : value.default ?? value.import
    if (!source) throw new Error(`Missing public export ${manifest.name}/${key}`)
    const target = source.replace("./src/", "./dist/").replace(/\.[jt]s$/, "")
    return [key, { types: `${target}.d.ts`, import: `${target}.js` }]
  }))
  manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies as Record<string, string>).map(([name, version]) => {
    // Bun resolves nested relative file dependencies against the consuming
    // checkout. This local install snapshot therefore uses its resolved path.
    if (name === "@opencode-ai/sdk") return [name, `file:${path.join(output, "sdk").replaceAll("\\", "/")}`]
    if (name === "@opencode-ai/llm") return [name, `file:${path.join(output, "llm").replaceAll("\\", "/")}`]
    if (version === "catalog:") {
      const pinned = workspace.workspaces.catalog[name]
      if (!pinned) throw new Error(`Missing catalog version for ${name}`)
      return [name, pinned]
    }
    if (version.startsWith("workspace:") || version.startsWith("catalog:")) throw new Error(`Unresolved dependency ${name}`)
    return [name, version]
  }))
  delete manifest.devDependencies
  delete manifest.scripts
  await Bun.write(path.join(destination, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
  const hashes = await Promise.all(files.sort().map(async (file) => ({
    path: `dist/${file.replaceAll("\\", "/")}`,
    sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(source, "dist", file)).arrayBuffer()).digest("hex"),
  })))
  receipt.push({ name: manifest.name, version: manifest.version, directory: item.destination, files: hashes })
}
await Bun.write(path.join(output, "manifest.json"), JSON.stringify({ packages: receipt }, null, 2) + "\n")
console.log(output)
