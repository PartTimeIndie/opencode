import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadProviderPackage, migrateProviderCaches } from "../src/plugin/provider-loader"
import { createHash } from "node:crypto"

test("provider manifests reject incompatible APIs and escaped exports before evaluating code", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-api-"))
  try {
    await writeFile(path.join(root, "index.js"), 'throw new Error("must not evaluate")')
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ exports: { "./provider": "./index.js" }, opencode: { api: { provider: 99 } } }),
    )
    await expect(loadProviderPackage(pathToFileURL(root).href, async () => root)).rejects.toThrow(
      "requires provider API 99",
    )
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ exports: { "./provider": "./../index.js" }, opencode: { api: { provider: 1 } } }),
    )
    await expect(loadProviderPackage(pathToFileURL(root).href, async () => root)).rejects.toThrow("outside its package")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("file and resolved provider packages use the same public contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-package-"))
  try {
    await mkdir(path.join(root, "dist"))
    await writeFile(
      path.join(root, "dist/index.js"),
      'export default { id: "independent", integrations: ["independent"], async provider() { return {} } }',
    )
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ exports: { "./provider": "./dist/index.js" }, opencode: { api: { provider: 1 } } }),
    )
    const file = await loadProviderPackage(pathToFileURL(root).href, async () => {
      throw new Error("should not resolve file package")
    })
    const installed = await loadProviderPackage("independent-package", async () => root)
    expect(installed).toBe(file)
    expect(file?.id).toBe("independent")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("canonical package exports reject outside junctions and allow internal junctions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-junction-"))
  const directory = path.join(root, "package")
  try {
    await mkdir(path.join(directory, "inside"), { recursive: true })
    await mkdir(path.join(root, "outside"))
    await writeFile(path.join(root, "outside/index.js"), 'throw new Error("outside code must not evaluate")')
    await writeFile(path.join(directory, "inside/index.js"), 'export default { id: "inside", async provider() {} }')
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ exports: { "./provider": "./link/index.js" }, opencode: { api: { provider: 1 } } }))
    await symlink(path.join(root, "outside"), path.join(directory, "link"), "junction")
    await expect(loadProviderPackage(directory, async () => directory)).rejects.toThrow("outside its package")
    await unlink(path.join(directory, "link"))
    await symlink(path.join(directory, "inside"), path.join(directory, "link"), "junction")
    expect((await loadProviderPackage(directory, async () => directory))?.id).toBe("inside")
    await unlink(path.join(directory, "link"))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("malformed public provider hooks fail before activation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-hooks-"))
  try {
    await writeFile(
      path.join(root, "index.js"),
      'export default { id: "broken", async provider() {}, transforms: { message: 42 } }',
    )
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ exports: { "./provider": "./index.js" }, opencode: { api: { provider: 1 } } }),
    )
    await expect(loadProviderPackage(pathToFileURL(root).href, async () => root)).rejects.toThrow(
      "invalid transforms hooks",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("legacy cache migration preserves new data and source across repeated startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-cache-"))
  try {
    const mapping = { owner: "neutral", source: "legacy.json", target: "models.json" }
    await writeFile(path.join(root, mapping.source), '{"models":["old"]}')
    await migrateProviderCaches(root, [mapping])
    const target = path.join(
      root,
      "provider-plugins",
      createHash("sha256").update(mapping.owner).digest("hex"),
      mapping.target,
    )
    expect(await Bun.file(target).json()).toEqual({ models: ["old"] })
    await writeFile(target, '{"models":["new"]}')
    await migrateProviderCaches(root, [mapping])
    expect(await Bun.file(target).json()).toEqual({ models: ["new"] })
    expect(await Bun.file(path.join(root, mapping.source)).json()).toEqual({ models: ["old"] })
    await expect(migrateProviderCaches(root, [{ ...mapping, target: "../escape" }])).rejects.toThrow(
      "Invalid provider cache migration path",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
