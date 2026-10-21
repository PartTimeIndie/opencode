import { expect, test } from "bun:test"
import path from "node:path"
import { isBuiltin } from "node:module"
import { ProviderPackages } from "../src/plugin/provider"

test("every preinstalled provider declares its public entrypoint and all source dependencies", async () => {
  const failures: string[] = []
  for (const name of ProviderPackages) {
    const directory = path.resolve(import.meta.dir, "../../provider-plugins", name)
    const manifest = await Bun.file(path.join(directory, "package.json")).json()
    expect(manifest.exports["./provider"]).toStartWith("./dist/")
    expect(manifest.opencode.api.provider).toBe(1)
    const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies }
    for await (const file of new Bun.Glob("src/**/*.{ts,tsx,js}").scan({ cwd: directory, onlyFiles: true })) {
      const source = await Bun.file(path.join(directory, file)).text()
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g)) {
        const specifier = match[1]
        if (isBuiltin(specifier)) continue
        if (specifier.startsWith(".")) {
          const resolved = path.resolve(directory, path.dirname(file), specifier)
          if (!resolved.startsWith(directory + path.sep)) failures.push(`${name}/${file}: private relative import ${specifier}`)
          continue
        }
        if (specifier.startsWith("@opencode-ai/core") || specifier.startsWith("@/")) {
          failures.push(`${name}/${file}: private host import ${specifier}`)
          continue
        }
        const dependency = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]
        if (!dependencies[dependency]) failures.push(`${name}/${file}: undeclared dependency ${dependency}`)
      }
    }
  }
  expect(failures).toEqual([])
})
