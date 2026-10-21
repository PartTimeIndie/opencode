import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { copyPluginPackages } from "../../../script/plugin-package-artifacts"
import { auditPluginSources } from "../../../script/audit-plugin-sources"

test("source boundary gate rejects private types, escaping paths and undeclared dependencies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-audit-"))
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "neutral", peerDependencies: { "@opencode-ai/plugin": "^1.17.7" } }))
    const file = path.join(root, "index.ts")
    for (const source of [
      'import type { Session } from "@opencode-ai/core/session"',
      'export { value } from "../host/private"',
      'const module = import("undeclared-package")',
      'type Host = import("@/private").Host',
    ]) {
      fs.writeFileSync(file, source)
      expect(() => auditPluginSources(root)).toThrow()
    }
    fs.writeFileSync(file, 'import type { Plugin } from "@opencode-ai/plugin"; import fs from "node:fs"')
    expect(auditPluginSources(root)).toBe("neutral")
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("packages every split chunk and binds manifest bytes without source or dependencies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-artifacts-"))
  try {
    const source = path.join(root, "source")
    const plugin = path.join(source, "neutral")
    fs.mkdirSync(path.join(plugin, "dist"), { recursive: true })
    fs.mkdirSync(path.join(plugin, "src"))
    fs.writeFileSync(path.join(plugin, "src", "private.ts"), "source only")
    fs.writeFileSync(path.join(plugin, "dist", "index.js"), 'export { value } from "./chunk.js"')
    fs.writeFileSync(path.join(plugin, "dist", "chunk.js"), "export const value = 42")
    fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ name: "neutral", version: "1.0.0", type: "module",
      opencode: { api: { provider: 1 } }, exports: { "./provider": "./dist/index.js" } }))
    const output = path.join(root, "output")
    const result = copyPluginPackages(source, output)
    expect(result[0]!.files.map((file) => file.path)).toEqual(["dist/chunk.js", "dist/index.js", "package.json"])
    expect(fs.existsSync(path.join(output, "neutral", "src"))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(output, "release-manifest.json"), "utf8")).artifacts).toEqual(result)
    expect(() => copyPluginPackages(source, output)).toThrow("already exists")
    fs.writeFileSync(path.join(plugin, "dist", "chunk.js"), "export const value = 43")
    expect(copyPluginPackages(source, path.join(root, "next"))[0]!.sha256).not.toBe(result[0]!.sha256)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
