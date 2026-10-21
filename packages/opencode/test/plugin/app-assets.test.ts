import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "../fixture/fixture"

const { AppPluginAssets } = await import("../../src/plugin/app/assets")

describe("plugin.app.assets", () => {
  test("freezes app plugin assets and rejects path or hash drift", async () => {
    await using tmp = await tmpdir()
    const cwd = process.cwd()
    const plugin = path.join(tmp.path, "plugin")
    await fs.mkdir(path.join(tmp.path, ".opencode"), { recursive: true })
    await fs.mkdir(plugin, { recursive: true })
    await Bun.write(
      path.join(plugin, "package.json"),
      JSON.stringify(
        {
          name: "acme-app-plugin",
          displayName: "Acme Tools",
          version: "1.2.3",
          type: "module",
          exports: {
            "./app": "./app.js",
          },
        },
        null,
        2,
      ),
    )
    await Bun.write(path.join(plugin, "app.js"), 'export default { id: "acme", app: async () => {} }\n')
    await Bun.write(
      path.join(tmp.path, ".opencode", "app.jsonc"),
      JSON.stringify({ plugin: [pathToFileURL(plugin).href] }, null, 2),
    )

    try {
      process.chdir(tmp.path)
      AppPluginAssets.resetForTesting()

      const manifest = await AppPluginAssets.clientManifest()
      const item = manifest.plugins.find((entry) => entry.id === "acme-app-plugin")
      expect(item?.version).toMatch(/^1\.2\.3-[0-9a-f]{16}$/)
      expect(item?.module).toBe(`/app/plugin/acme-app-plugin/${item?.version}/app.js`)
      expect(item?.hash).toHaveLength(64)
      expect(item?.displayName).toBe("Acme Tools")

      const asset = await AppPluginAssets.readAsset("acme-app-plugin", item!.version, "app.js")
      expect(asset.status).toBe(200)
      if (asset.status !== 200) throw new Error("expected plugin asset to load")
      expect(Buffer.from(asset.body).toString("utf8")).toContain('id: "acme"')

      expect((await AppPluginAssets.readAsset("acme-app-plugin", "1.2.4", "app.js")).status).toBe(404)
      expect((await AppPluginAssets.readAsset("acme-app-plugin", item!.version, "../package.json")).status).toBe(404)

      await Bun.write(path.join(plugin, "app.js"), 'export default { id: "mutated", app: async () => {} }\n')
      expect((await AppPluginAssets.readAsset("acme-app-plugin", item!.version, "app.js")).status).toBe(409)

      const mutated = (await AppPluginAssets.clientManifest()).plugins.find((entry) => entry.id === item?.id)
      expect(mutated?.version).toMatch(/^1\.2\.3-[0-9a-f]{16}$/)
      expect(mutated?.version).not.toBe(item?.version)
      expect(mutated?.hash).not.toBe(item?.hash)
      expect(mutated?.module).toBe(`/app/plugin/acme-app-plugin/${mutated?.version}/app.js`)
      expect((await AppPluginAssets.readAsset("acme-app-plugin", mutated!.version, "app.js")).status).toBe(200)
    } finally {
      process.chdir(cwd)
      AppPluginAssets.resetForTesting()
    }
  })

  test("serves frozen assets by plugin id and version", async () => {
    await using tmp = await tmpdir()
    const cwd = process.cwd()
    const pluginA = path.join(tmp.path, "plugin-a")
    const pluginB = path.join(tmp.path, "plugin-b")
    const projectA = path.join(tmp.path, "project-a")
    const projectB = path.join(tmp.path, "project-b")

    await createAppPlugin(pluginA, "shared-app-plugin", 'export default { id: "shared-a", app: async () => {} }\n')
    await createAppPlugin(pluginB, "shared-app-plugin", 'export default { id: "shared-b", app: async () => {} }\n')
    await writeAppConfig(projectA, pluginA)
    await writeAppConfig(projectB, pluginB)

    try {
      process.chdir(tmp.path)
      AppPluginAssets.resetForTesting()

      const manifestA = await AppPluginAssets.clientManifest(projectA)
      const manifestB = await AppPluginAssets.clientManifest(projectB)
      const itemA = manifestA.plugins.find((entry) => entry.id === "shared-app-plugin")
      const itemB = manifestB.plugins.find((entry) => entry.id === "shared-app-plugin")

      expect(itemA?.version).toMatch(/^1\.0\.0-[0-9a-f]{16}$/)
      expect(itemB?.version).toMatch(/^1\.0\.0-[0-9a-f]{16}$/)
      expect(itemB?.version).not.toBe(itemA?.version)

      const assetA = await AppPluginAssets.readAsset("shared-app-plugin", itemA!.version, "app.js")
      const assetB = await AppPluginAssets.readAsset("shared-app-plugin", itemB!.version, "app.js")

      expect(assetA.status).toBe(200)
      expect(assetB.status).toBe(200)
      if (assetA.status !== 200 || assetB.status !== 200) throw new Error("expected plugin assets to load")
      expect(Buffer.from(assetA.body).toString("utf8")).toContain("shared-a")
      expect(Buffer.from(assetB.body).toString("utf8")).toContain("shared-b")
    } finally {
      process.chdir(cwd)
      AppPluginAssets.resetForTesting()
    }
  })

  test("refreshes cached manifests when plugin files are added", async () => {
    await using tmp = await tmpdir()
    const cwd = process.cwd()
    const plugin = path.join(tmp.path, "plugin")

    await createAppPlugin(plugin, "file-set-app-plugin", 'export default { id: "file-set", app: async () => {} }\n')
    await writeAppConfig(tmp.path, plugin)

    try {
      process.chdir(tmp.path)
      AppPluginAssets.resetForTesting()

      const first = (await AppPluginAssets.clientManifest()).plugins.find((entry) => entry.id === "file-set-app-plugin")
      expect(first?.version).toMatch(/^1\.0\.0-[0-9a-f]{16}$/)

      await fs.mkdir(path.join(plugin, "assets"), { recursive: true })
      await Bun.write(path.join(plugin, "assets", "skill.svg"), "<svg />\n")

      const refreshed = (await AppPluginAssets.clientManifest()).plugins.find(
        (entry) => entry.id === "file-set-app-plugin",
      )
      expect(refreshed?.version).toMatch(/^1\.0\.0-[0-9a-f]{16}$/)
      expect(refreshed?.version).not.toBe(first?.version)
      expect((await AppPluginAssets.readAsset("file-set-app-plugin", refreshed!.version, "assets/skill.svg")).status).toBe(
        200,
      )
    } finally {
      process.chdir(cwd)
      AppPluginAssets.resetForTesting()
    }
  })

  test("publishes web assets without exposing hidden files or private keys", async () => {
    await using tmp = await tmpdir()
    const cwd = process.cwd()
    const plugin = path.join(tmp.path, "plugin")

    await createAppPlugin(plugin, "safe-assets-app-plugin", 'export default { id: "safe-assets", app: async () => {} }\n')
    await Promise.all([
      writeAsset(plugin, "styles/app.css", "body {}\n"),
      writeAsset(plugin, "images/icon.png", Buffer.from([137, 80, 78, 71])),
      writeAsset(plugin, "fonts/app.woff2", Buffer.from([119, 79, 70, 50])),
      writeAsset(plugin, "runtime/app.wasm", Buffer.from([0, 97, 115, 109])),
      writeAsset(plugin, ".env", "TOKEN=hidden\n"),
      writeAsset(plugin, ".npmrc", "//registry.example/:_authToken=hidden\n"),
      writeAsset(plugin, ".private/token.txt", "hidden\n"),
      writeAsset(plugin, "assets/.internal/icon.svg", "<svg />\n"),
      writeAsset(plugin, "server.pem", "private\n"),
      writeAsset(plugin, "signing.key", "private\n"),
      writeAsset(plugin, "bundle.p12", "private\n"),
      writeAsset(plugin, "apple-signing.p8", "private\n"),
      writeAsset(plugin, "putty.ppk", "private\n"),
      writeAsset(plugin, "credentials.json", '{"token":"private"}\n'),
      writeAsset(plugin, "config/secrets.yaml", "token: private\n"),
      writeAsset(plugin, "id_ed25519", "private\n"),
    ])
    await writeAppConfig(tmp.path, plugin)

    try {
      process.chdir(tmp.path)
      AppPluginAssets.resetForTesting()

      const item = (await AppPluginAssets.clientManifest()).plugins.find(
        (entry) => entry.id === "safe-assets-app-plugin",
      )
      expect(item).toBeDefined()

      for (const file of ["app.js", "styles/app.css", "images/icon.png", "fonts/app.woff2", "runtime/app.wasm"]) {
        expect((await AppPluginAssets.readAsset(item!.id, item!.version, file)).status).toBe(200)
      }

      for (const file of [
        ".env",
        ".npmrc",
        ".private/token.txt",
        "assets/.internal/icon.svg",
        "server.pem",
        "signing.key",
        "bundle.p12",
        "apple-signing.p8",
        "putty.ppk",
        "credentials.json",
        "config/secrets.yaml",
        "id_ed25519",
      ]) {
        expect((await AppPluginAssets.readAsset(item!.id, item!.version, file)).status).toBe(404)
      }

      await Bun.write(path.join(plugin, ".env"), "TOKEN=changed\n")
      const unchanged = (await AppPluginAssets.clientManifest()).plugins.find((entry) => entry.id === item!.id)
      expect(unchanged?.version).toBe(item!.version)
    } finally {
      process.chdir(cwd)
      AppPluginAssets.resetForTesting()
    }
  })

  test("refreshes cached manifests when app config adds a plugin", async () => {
    await using tmp = await tmpdir()
    const cwd = process.cwd()
    const pluginA = path.join(tmp.path, "plugin-a")
    const pluginB = path.join(tmp.path, "plugin-b")

    await createAppPlugin(pluginA, "first-app-plugin", 'export default { id: "first", app: async () => {} }\n')
    await createAppPlugin(pluginB, "second-app-plugin", 'export default { id: "second", app: async () => {} }\n')
    await writeAppConfig(tmp.path, pluginA)

    try {
      process.chdir(tmp.path)
      AppPluginAssets.resetForTesting()

      const first = await AppPluginAssets.clientManifest()
      expect(first.plugins.map((entry) => entry.id)).toEqual(["first-app-plugin"])

      await writeAppConfig(tmp.path, pluginA, pluginB)

      const refreshed = await AppPluginAssets.clientManifest()
      expect(refreshed.plugins.map((entry) => entry.id).toSorted()).toEqual(["first-app-plugin", "second-app-plugin"])
    } finally {
      process.chdir(cwd)
      AppPluginAssets.resetForTesting()
    }
  })

  test("publishes audio, focused-input, skill-catalog, and desktop-service capabilities while dropping unknown capabilities", async () => {
    await using tmp = await tmpdir()
    const cwd = process.cwd()
    const plugin = path.join(tmp.path, "capabilities-app-plugin")
    await createAppPlugin(
      plugin,
      "capabilities-app-plugin",
      'export default { id: "capabilities", app: async () => {} }\n',
      ["host:skills", "host:text-input", "host:desktop-services", "host:audio", "ui:floating", "host:unknown"],
    )
    await writeAppConfig(tmp.path, plugin)

    try {
      process.chdir(tmp.path)
      AppPluginAssets.resetForTesting()

      const item = (await AppPluginAssets.clientManifest()).plugins.find(
        (entry) => entry.id === "capabilities-app-plugin",
      )
      expect(item?.capabilities).toEqual(["host:skills", "host:text-input", "host:desktop-services", "host:audio", "ui:floating"])
    } finally {
      process.chdir(cwd)
      AppPluginAssets.resetForTesting()
    }
  })

  test("skips local app plugins whose declared entrypoint is missing", async () => {
    await using tmp = await tmpdir()
    const cwd = process.cwd()
    const plugin = path.join(tmp.path, "missing-entry-app-plugin")
    await createAppPlugin(plugin, "missing-entry-app-plugin", 'export default { id: "missing", app: async () => {} }\n')
    await fs.rm(path.join(plugin, "app.js"))
    await writeAppConfig(tmp.path, plugin)
    const warn = spyOn(console, "warn").mockImplementation(() => {})

    try {
      process.chdir(tmp.path)
      AppPluginAssets.resetForTesting()

      const manifest = await AppPluginAssets.clientManifest()
      expect(manifest.plugins.find((entry) => entry.id === "missing-entry-app-plugin")).toBeUndefined()
      expect(manifest.plugins.every((entry) => entry.hash.length > 0)).toBe(true)
      expect(
        warn.mock.calls.some((call) => call[0] === "[app-plugin] skipping app plugin with missing entrypoint"),
      ).toBe(true)
    } finally {
      process.chdir(cwd)
      AppPluginAssets.resetForTesting()
      warn.mockRestore()
    }
  })
})

async function createAppPlugin(dir: string, name: string, app: string, capabilities?: string[]) {
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        type: "module",
        exports: {
          "./app": "./app.js",
        },
        ...(capabilities ? { opencode: { app: { capabilities } } } : {}),
      },
      null,
      2,
    ),
  )
  await Bun.write(path.join(dir, "app.js"), app)
}

async function writeAsset(root: string, file: string, content: string | Buffer) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await Bun.write(path.join(root, file), content)
}

async function writeAppConfig(project: string, ...plugins: string[]) {
  await fs.mkdir(path.join(project, ".opencode"), { recursive: true })
  await Bun.write(
    path.join(project, ".opencode", "app.jsonc"),
    JSON.stringify({ plugin: plugins.map((plugin) => pathToFileURL(plugin).href) }, null, 2),
  )
}
