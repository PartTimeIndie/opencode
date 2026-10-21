import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { preparePluginRelease } from "../script/prepare-plugin-release"
import { prepareExternalRelease } from "../script/desktop-prod-deploy"

test("prepares a joint plugin configuration without touching live files and preserves options on repeated preparation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-plugin-release-"))
  try {
    const configDirectory = path.join(root, "config")
    const sourceRoot = path.join(root, "host")
    const serverRoot = path.join(root, "repos")
    fs.mkdirSync(configDirectory)
    const original = '// preserved comment\n{"plugin":["opencode-scheduler",["opencode-goal-plugin",{"maxTokens":123}],"cursor-opencode-provider","file:///C:/Users/test/.config/opencode/plugin-packages/chat-chain-manager/",["chat-chain-manager",{"unlimited":true}],"ponytail"],"unrelated":{"keep":true}}'
    fs.writeFileSync(path.join(configDirectory, "opencode.json"), original)
    for (const name of ["opencode-scheduler", "opencode-runtime-services", "opencode-voice-conversation", "opencode-review", "opencode-problem-solver", "opencode-openrouter-media"]) {
      const folder = path.join(serverRoot, name)
      fs.mkdirSync(path.join(folder, "dist"), { recursive: true })
      fs.writeFileSync(path.join(folder, "dist", "index.js"), "export default {}")
      fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify({ name, version: "2.0.0", opencode: { api: { server: 2 } } }))
    }
    const app = path.join(sourceRoot, ".opencode", "plugin-sources", "neutral")
    fs.mkdirSync(path.join(configDirectory, "node_modules"))
    fs.symlinkSync(path.join(serverRoot, "opencode-scheduler"), path.join(configDirectory, "node_modules", "opencode-scheduler"), process.platform === "win32" ? "junction" : "dir")
    fs.mkdirSync(app, { recursive: true })
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "neutral", version: "1", opencode: { api: { app: 2 } } }))
    fs.writeFileSync(path.join(app, "index.js"), "export const version = 1")
    const output = path.join(root, "candidate")
    const descriptor = preparePluginRelease({ output, configDirectory, sourceRoot, serverRoot })
    expect(fs.readFileSync(path.join(configDirectory, "opencode.json"), "utf8")).toBe(original)
    const text = fs.readFileSync(path.join(output, "opencode.json"), "utf8")
    expect(text).toContain("// preserved comment")
    const config = parse(text)
    expect(config.unrelated).toEqual({ keep: true })
    expect(config.plugin).toContainEqual(["opencode-goal-plugin", { maxTokens: 123 }])
    expect(config.plugin).not.toContain("cursor-opencode-provider")
    expect(config.plugin).not.toContain("file:///C:/Users/test/.config/opencode/plugin-packages/chat-chain-manager/")
    expect(config.plugin).not.toContainEqual(["chat-chain-manager", { unlimited: true }])
    expect(config.plugin).toHaveLength(8)
    expect(JSON.parse(fs.readFileSync(descriptor, "utf8")).entries).toHaveLength(8)
    expect(fs.lstatSync(path.join(configDirectory, "node_modules", "opencode-scheduler")).isSymbolicLink()).toBe(true)
    expect(JSON.parse(fs.readFileSync(descriptor, "utf8")).entries[0].target).toBe(path.join(configDirectory, "plugin-packages", "opencode-scheduler"))
    fs.writeFileSync(path.join(app, "index.js"), "export const version = 2")
    expect(fs.readFileSync(path.join(output, "app", "neutral", "index.js"), "utf8")).toBe("export const version = 1")
    // Simulate the previous release's config in this isolated fixture only.
    fs.writeFileSync(path.join(configDirectory, "opencode.json"), text)
    expect(() => prepareExternalRelease(descriptor, path.join(root, "transaction"))).toThrow("changed since descriptor")
    expect(fs.existsSync(path.join(root, "transaction"))).toBe(false)
    const next = path.join(root, "next")
    preparePluginRelease({ output: next, configDirectory, sourceRoot, serverRoot })
    expect(parse(fs.readFileSync(path.join(next, "opencode.json"), "utf8"))).toEqual(config)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
