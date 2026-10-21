import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { builtinServerPlugins } from "../../src/plugin/builtin-server"
import { PluginLoader } from "../../src/plugin/loader"
import { tmpdir } from "../fixture/fixture"
import { ResponseStreamError, SYNTHETIC_ATTACHMENT_PROMPT } from "@opencode-ai/plugin/transport"
import type { Config, PluginModule } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk"

test("all eleven preinstalled auth packages build and load through the external plugin loader outside the workspace", async () => {
  await using directory = await tmpdir()
  const previous = process.env.OPENCODE_PROVIDER_PLUGIN_DIR
  const source = fileURLToPath(new URL("../../../provider-plugins/", import.meta.url))
  try {
    process.env.OPENCODE_PROVIDER_PLUGIN_DIR = directory.path
    const entries = builtinServerPlugins({ experimentalWebSockets: true })
    expect(entries).toHaveLength(11)
    for (const entry of entries) {
      const spec = Array.isArray(entry.spec) ? entry.spec[0] : entry.spec
      const target = fileURLToPath(spec)
      const packageSource = path.join(source, path.basename(target))
      const manifest = await Bun.file(path.join(packageSource, "package.json")).json()
      const entrypoints = [path.join(packageSource, "src/server.ts"), ...(manifest.exports["./adapter"] ? [path.join(packageSource, "src/adapter.ts")] : [])]
      const build = await Bun.build({ entrypoints, outdir: path.join(target, "dist"), target: "bun", splitting: true })
      expect(build.logs).toEqual([])
      expect(build.success).toBe(true)
      await Bun.write(path.join(target, "package.json"), JSON.stringify({ ...manifest, exports: { "./server": "./dist/server.js" } }))
    }
    const errors: unknown[] = []
    const loaded = await PluginLoader.loadExternal({ items: entries, kind: "server", report: { error: (...args) => errors.push(args), missing: (...args) => errors.push(args) } })
    expect(errors).toEqual([])
    expect(loaded).toHaveLength(11)
    expect(new Set(loaded.map((entry) => (entry.mod.default as { id: string }).id)).size).toBe(11)
    for (const entry of loaded) {
      expect(entry.entry.startsWith(directory.path) || entry.entry.startsWith(pathToFileURL(directory.path).href)).toBe(true)
      expect(typeof (entry.mod.default as { server: unknown }).server).toBe("function")
    }
    expect(loaded[0].options).toEqual({ experimentalWebSockets: true })
    const cursor = loaded.find((entry) => (entry.mod.default as PluginModule).id === "@opencode-ai/provider-cursor")!
    const hooks = await (cursor.mod.default as PluginModule).server({
      directory: directory.path,
      client: createOpencodeClient({ baseUrl: "http://127.0.0.1:1" }),
    } as never)
    expect(hooks.auth?.provider).toBe("cursor")
    expect(typeof hooks.auth?.loader).toBe("function")
    expect(hooks.auth?.methods).toHaveLength(2)
    expect(Object.keys(hooks.tool ?? {})).toContain("custom_websearch")
    const config: Config = { provider: { cursor: { models: { existing: { name: "Existing model" } } } } }
    await hooks.config?.(config)
    expect(config.provider?.cursor.models).toHaveProperty("existing")
    const adapter = config.provider?.cursor.npm!
    expect(adapter).toBe(pathToFileURL(path.join(directory.path, "cursor/dist/adapter.js")).href)
    expect(typeof (await import(adapter)).createCursor).toBe("function")
    await hooks.dispose?.()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_PROVIDER_PLUGIN_DIR
    else process.env.OPENCODE_PROVIDER_PLUGIN_DIR = previous
  }
}, 30_000)

test("builtin provider plugins use the packaged directory for a detached CLI", async () => {
  await using directory = await tmpdir()
  const executable = Object.getOwnPropertyDescriptor(process, "execPath")!
  const previous = process.env.OPENCODE_PROVIDER_PLUGIN_DIR
  const resources = path.join(directory.path, "resources")
  const packaged = path.join(resources, "plugin-packages", "provider")
  try {
    await mkdir(packaged, { recursive: true })
    await Bun.write(path.join(packaged, "release-manifest.json"), "{}")
    Object.defineProperty(process, "execPath", { ...executable, value: path.join(resources, "opencode-cli.exe") })
    delete process.env.OPENCODE_PROVIDER_PLUGIN_DIR

    const entries = builtinServerPlugins({ experimentalWebSockets: false })
    expect(entries.map((entry) => (Array.isArray(entry.spec) ? entry.spec[0] : entry.spec))).toEqual(
      ["openai", "github-copilot", "cursor", "gitlab", "poe", "cloudflare-workers-ai", "cloudflare-ai-gateway", "azure", "digitalocean", "snowflake-cortex", "xai"].map(
        (name) => pathToFileURL(path.join(packaged, name)).href,
      ),
    )
    expect(entries[0]?.spec).toEqual([
      pathToFileURL(path.join(packaged, "openai")).href,
      { experimentalWebSockets: false },
    ])
  } finally {
    Object.defineProperty(process, "execPath", executable)
    if (previous === undefined) delete process.env.OPENCODE_PROVIDER_PLUGIN_DIR
    else process.env.OPENCODE_PROVIDER_PLUGIN_DIR = previous
  }
})

test("transport failures retain their public identity across independently bundled plugins", async () => {
  await using directory = await tmpdir()
  const entry = fileURLToPath(new URL("../../../plugin/src/transport.ts", import.meta.url))
  const build = await Bun.build({ entrypoints: [entry], outdir: directory.path, target: "bun" })
  expect(build.success).toBe(true)
  const detached = await import(pathToFileURL(path.join(directory.path, "transport.js")).href)
  const error = new detached.ResponseStreamError("response ended before completion", { cause: new Error("socket closed") })
  expect(error).toBeInstanceOf(ResponseStreamError)
  expect(new ResponseStreamError("local")).toBeInstanceOf(detached.ResponseStreamError)
  expect(new Error("ordinary")).not.toBeInstanceOf(ResponseStreamError)
  expect({ name: "ProviderResponseStreamError", message: "spoof", [Symbol.for("@opencode-ai/plugin/ResponseStreamError")]: true }).not.toBeInstanceOf(ResponseStreamError)
  expect(error.cause.message).toBe("socket closed")
  expect(detached.SYNTHETIC_ATTACHMENT_PROMPT).toBe(SYNTHETIC_ATTACHMENT_PROMPT)
})
