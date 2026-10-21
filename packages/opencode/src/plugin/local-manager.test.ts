import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { cp, mkdir, mkdtemp } from "node:fs/promises"
import { BlobWriter, configure, TextReader, ZipWriter } from "@zip.js/zip.js"
import { Process } from "@/util/process"
import {
  installLocalPlugin,
  installLocalSkill,
  listLocalExtensions,
  uninstallLocalPlugin,
  uninstallLocalSkill,
} from "./local-manager"

configure({ useWebWorkers: false })

async function tempProject() {
  return mkdtemp(path.join(os.tmpdir(), "opencode-local-ext-"))
}

async function writeZip(file: string, entries: Record<string, string>) {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  for (const name of Object.keys(entries)) {
    await writer.add(name, new TextReader(entries[name] ?? ""))
  }
  await Bun.write(file, await (await writer.close()).arrayBuffer())
}

async function commitPluginSource(project: string, name: string, source: string) {
  const target = path.join(project, ".opencode", "plugin-sources", name)
  await mkdir(path.dirname(target), { recursive: true })
  await cp(source, target, { recursive: true })
  await Process.run(["git", "init", "-q"], { cwd: project })
  await Process.run(["git", "config", "user.email", "plugin-test@opencode.local"], { cwd: project })
  await Process.run(["git", "config", "user.name", "OpenCode Plugin Test"], { cwd: project })
  await Process.run(["git", "add", ".opencode/plugin-sources"], { cwd: project })
  await Process.run(["git", "commit", "-q", "-m", "test: add plugin source"], { cwd: project })
  return target
}

describe("LocalExtensionManager", () => {
  test("installs, lists, and uninstalls a local plugin folder with detected targets", async () => {
    const project = await tempProject()
    const source = path.join(project, "session-navigator-app")
    await mkdir(source)
    await Bun.write(
      path.join(source, "package.json"),
      JSON.stringify(
        {
          name: "session-navigator-app",
          displayName: "Session Navigator",
          type: "module",
          exports: {
            "./app": "./app.js",
            "./tui": "./tui.js",
          },
        },
        null,
        2,
      ),
    )
    await Bun.write(path.join(source, "app.js"), 'export default { id: "sessionNavigator", app() {} }')
    await Bun.write(path.join(source, "tui.js"), 'export default { id: "sessionNavigator", tui() {} }')

    const install = await installLocalPlugin({ directory: project, source })
    expect(install.ok).toBe(true)
    if (!install.ok) return
    expect(install.item.name).toBe("Session Navigator")
    expect(install.item.id).toBe("plugin:./plugins/session-navigator-app")
    expect(install.item.spec).toBe("./plugins/session-navigator-app")
    expect(new Set(install.item.targets)).toEqual(new Set(["app", "tui"]))

    const reinstall = await installLocalPlugin({ directory: project, source })
    expect(reinstall.ok).toBe(true)
    if (!reinstall.ok) return
    expect(new Set(reinstall.item.targets)).toEqual(new Set(["app", "tui"]))

    const target = path.join(project, ".opencode", "plugins", "session-navigator-app")
    expect(await Bun.file(path.join(target, "app.js")).exists()).toBe(true)
    expect(await Bun.file(path.join(project, ".opencode", "app.jsonc")).text()).toContain(
      "./plugins/session-navigator-app",
    )
    expect(await Bun.file(path.join(project, ".opencode", "tui.jsonc")).text()).toContain(
      "./plugins/session-navigator-app",
    )
    await Bun.write(
      path.join(project, ".opencode", "app.json"),
      JSON.stringify({ plugin: ["./plugins/session-navigator-app"] }),
    )

    const list = await listLocalExtensions(project)
    const plugins = list.plugins.filter((item) => item.name === "Session Navigator")
    expect(plugins).toHaveLength(2)
    expect(new Set(plugins.map((item) => item.target))).toEqual(new Set(["app", "tui"]))
    expect(plugins.every((item) => item.removable)).toBe(true)

    await commitPluginSource(project, "session-navigator-app", source)
    await uninstallLocalPlugin({
      directory: project,
      spec: "./plugins/session-navigator-app",
      file: path.join(project, ".opencode", "app.jsonc"),
      deleteFiles: true,
    })
    expect(await Bun.file(target).exists()).toBe(false)
    expect(await Bun.file(path.join(project, ".opencode", "app.jsonc")).text()).not.toContain(
      "./plugins/session-navigator-app",
    )
  })

  test("uses package display metadata before humanizing package specs without changing their identity", async () => {
    const project = await tempProject()
    const appConfig = path.join(project, ".opencode", "app.jsonc")
    const serverConfig = path.join(project, ".opencode", "opencode.jsonc")
    const packages = [
      {
        spec: "display-plugin@1.0.0",
        parts: ["display-plugin"],
        manifest: {
          name: "display-plugin",
          displayName: " Display Winner ",
          productName: "Product Ignored",
          opencode: { displayName: "Nested Ignored" },
        },
        expected: "Display Winner",
      },
      {
        spec: "product-plugin@1.0.0",
        parts: ["product-plugin"],
        manifest: {
          name: "product-plugin",
          productName: "Product Winner",
          opencode: { displayName: "Nested Ignored" },
        },
        expected: "Product Winner",
      },
      {
        spec: "nested-plugin@1.0.0",
        parts: ["nested-plugin"],
        manifest: { name: "nested-plugin", opencode: { displayName: "Nested Winner" } },
        expected: "Nested Winner",
      },
      {
        spec: "@scope/git-opencode-qa-app@2.0.0",
        parts: ["@scope", "git-opencode-qa-app"],
        manifest: { name: "@scope/git-opencode-qa-app" },
        expected: "Git QA",
      },
    ]

    await Promise.all(
      packages.map(async (item) => {
        const dir = path.join(project, ".opencode", "node_modules", ...item.parts)
        await mkdir(dir, { recursive: true })
        await Bun.write(path.join(dir, "package.json"), JSON.stringify(item.manifest))
      }),
    )
    await mkdir(path.join(project, ".opencode", "node_modules", "tui-opencode-app"), { recursive: true })
    await Bun.write(
      path.join(project, ".opencode", "node_modules", "tui-opencode-app", "package.json"),
      JSON.stringify({ name: "tui-opencode-app" }),
    )
    await Bun.write(appConfig, JSON.stringify({ plugin: packages.map((item) => item.spec) }))
    await Bun.write(serverConfig, JSON.stringify({ plugin: ["tui-opencode-app@1.0.0"] }))

    const list = await listLocalExtensions(project)
    expect(
      list.plugins
        .filter((item) => item.file === appConfig)
        .map((item) => ({ id: item.id, name: item.name, spec: item.spec })),
    ).toEqual(
      packages.map((item, index) => ({
        id: `plugin:app:${appConfig}:${index}`,
        name: item.expected,
        spec: item.spec,
      })),
    )
    expect(
      list.plugins
        .filter((item) => item.file === serverConfig)
        .map((item) => ({ id: item.id, name: item.name, spec: item.spec })),
    ).toEqual([
      {
        id: `plugin:server:${serverConfig}:0`,
        name: "TUI App",
        spec: "tui-opencode-app@1.0.0",
      },
    ])
  })

  test("reinstalling an already registered app plugin folder is idempotent", async () => {
    const project = await tempProject()
    const source = path.join(project, "session-navigator-app")
    await mkdir(source)
    await Bun.write(
      path.join(source, "package.json"),
      JSON.stringify(
        {
          name: "session-navigator-app",
          version: "1.0.0",
          type: "module",
          exports: {
            "./app": "./index.js",
          },
        },
        null,
        2,
      ),
    )
    await Bun.write(path.join(source, "index.js"), 'export default { id: "session-navigator-app", app() {} }')

    const install = await installLocalPlugin({ directory: project, source })
    expect(install.ok).toBe(true)
    const reinstall = await installLocalPlugin({ directory: project, source })
    expect(reinstall.ok).toBe(true)
    if (!reinstall.ok) return
    expect(reinstall.item.name).toBe("Session Navigator")
    expect(reinstall.item.spec).toBe("./plugins/session-navigator-app")
    expect(reinstall.item.targets).toEqual(["app"])
  })

  test("installs zip archives with a single top-level plugin folder", async () => {
    const project = await tempProject()
    const source = path.join(project, "source-plugin.zip")
    await writeZip(source, {
      "zip-plugin/index.js": 'export default { id: "zipPlugin", app() {} }',
    })

    const install = await installLocalPlugin({ directory: project, source })
    expect(install.ok).toBe(true)
    if (!install.ok) return

    const target = path.join(project, ".opencode", "plugins", "zip-plugin")
    expect(await Bun.file(path.join(target, "index.js")).exists()).toBe(true)
    expect(await Bun.file(path.join(project, ".opencode", "app.jsonc")).text()).toContain("./plugins/zip-plugin")
  })

  test("installs zip archives whose plugin files are at the archive root", async () => {
    const project = await tempProject()
    const source = path.join(project, "root-plugin.zip")
    await writeZip(source, {
      "index.js": 'export default { id: "rootPlugin", app() {} }',
    })

    const install = await installLocalPlugin({ directory: project, source })
    expect(install.ok).toBe(true)
    if (!install.ok) return

    const target = path.join(project, ".opencode", "plugins", "root-plugin")
    expect(await Bun.file(path.join(target, "index.js")).exists()).toBe(true)
  })

  test("rejects unsafe zip paths", async () => {
    const project = await tempProject()
    const source = path.join(project, "unsafe-plugin.zip")
    await writeZip(source, {
      "../outside.js": 'export default { id: "unsafe", app() {} }',
    })

    const install = await installLocalPlugin({ directory: project, source })
    expect(install.ok).toBe(false)
    if (install.ok) return
    expect(install.code).toBe("invalid_source")
  })

  test("installs and uninstalls a local skill folder by frontmatter name", async () => {
    const project = await tempProject()
    const source = path.join(project, "source-skill")
    await mkdir(source)
    await Bun.write(
      path.join(source, "SKILL.md"),
      [
        "---",
        "name: local-session-skill",
        "description: local skill for tests",
        "---",
        "",
        "Use for local test coverage.",
      ].join("\n"),
    )

    const install = await installLocalSkill({ directory: project, source })
    expect(install.ok).toBe(true)
    if (!install.ok) return

    const target = path.join(project, ".opencode", "skills", "local-session-skill")
    expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(true)

    const list = await listLocalExtensions(project)
    const item = list.skills.find((skill) => skill.name === "local-session-skill")
    expect(item?.path).toBe(target)
    expect(item?.removable).toBe(true)

    await uninstallLocalSkill({ directory: project, name: "local-session-skill", path: target })
    expect(await Bun.file(target).exists()).toBe(false)
  })

  test("installs skill archives from archive root", async () => {
    const project = await tempProject()
    const source = path.join(project, "skill-archive.zip")
    await writeZip(source, {
      "SKILL.md": ["---", "name: archived-local-skill", "---", "", "Body."].join("\n"),
    })

    const install = await installLocalSkill({ directory: project, source })
    expect(install.ok).toBe(true)
    if (!install.ok) return
    expect(await Bun.file(path.join(project, ".opencode", "skills", "archived-local-skill", "SKILL.md")).exists()).toBe(
      true,
    )
  })

  test("removes the local plugin root for config entries pointing at nested files", async () => {
    const project = await tempProject()
    const plugin = path.join(project, ".opencode", "plugins", "nested-plugin")
    await mkdir(plugin, { recursive: true })
    await Bun.write(path.join(plugin, "index.js"), 'export default { id: "nestedPlugin", app() {} }')
    await mkdir(path.join(project, ".opencode"), { recursive: true })
    await Bun.write(
      path.join(project, ".opencode", "app.jsonc"),
      JSON.stringify({ plugin: ["./plugins/nested-plugin/index.js"] }, null, 2),
    )

    await commitPluginSource(project, "nested-plugin", plugin)
    await uninstallLocalPlugin({
      directory: project,
      spec: "./plugins/nested-plugin/index.js",
      file: path.join(project, ".opencode", "app.jsonc"),
      deleteFiles: true,
    })

    expect(await Bun.file(plugin).exists()).toBe(false)
  })

  test("blocks plugin uninstall when the durable source folder is missing", async () => {
    const project = await tempProject()
    const plugin = path.join(project, ".opencode", "plugins", "local-plugin")
    const config = path.join(project, ".opencode", "app.jsonc")
    await mkdir(plugin, { recursive: true })
    await Bun.write(path.join(plugin, "index.js"), 'export default { id: "localPlugin", app() {} }')
    await Bun.write(config, JSON.stringify({ plugin: ["./plugins/local-plugin"] }, null, 2))

    await expect(
      uninstallLocalPlugin({
        directory: project,
        spec: "./plugins/local-plugin",
        file: config,
        deleteFiles: true,
      }),
    ).rejects.toThrow("durable source folder is missing")
    await expect(
      uninstallLocalPlugin({
        directory: project,
        spec: "./plugins/local-plugin",
        file: config,
        deleteFiles: false,
      }),
    ).rejects.toThrow("durable source folder is missing")
    expect(await Bun.file(path.join(plugin, "index.js")).exists()).toBe(true)
    expect(await Bun.file(config).text()).toContain("./plugins/local-plugin")
  })

  test("blocks plugin uninstall when the source folder has uncommitted changes", async () => {
    const project = await tempProject()
    const plugin = path.join(project, ".opencode", "plugins", "local-plugin")
    const config = path.join(project, ".opencode", "app.jsonc")
    await mkdir(plugin, { recursive: true })
    await Bun.write(path.join(plugin, "index.js"), 'export default { id: "localPlugin", app() {} }')
    await Bun.write(config, JSON.stringify({ plugin: ["./plugins/local-plugin"] }, null, 2))
    const source = await commitPluginSource(project, "local-plugin", plugin)
    await Bun.write(path.join(source, "index.js"), 'export default { id: "changedPlugin", app() {} }')

    await expect(
      uninstallLocalPlugin({
        directory: project,
        spec: "./plugins/local-plugin",
        file: config,
        deleteFiles: true,
      }),
    ).rejects.toThrow("source folder has uncommitted changes")
    expect(await Bun.file(path.join(plugin, "index.js")).exists()).toBe(true)
  })

  test("blocks plugin uninstall when runtime differs from the committed source", async () => {
    const project = await tempProject()
    const plugin = path.join(project, ".opencode", "plugins", "local-plugin")
    const config = path.join(project, ".opencode", "app.jsonc")
    await mkdir(plugin, { recursive: true })
    await Bun.write(path.join(plugin, "index.js"), 'export default { id: "localPlugin", app() {} }')
    await Bun.write(config, JSON.stringify({ plugin: ["./plugins/local-plugin"] }, null, 2))
    await commitPluginSource(project, "local-plugin", plugin)
    await Bun.write(path.join(plugin, "index.js"), 'export default { id: "runtimeOnlyChange", app() {} }')

    await expect(
      uninstallLocalPlugin({
        directory: project,
        spec: "./plugins/local-plugin",
        file: config,
        deleteFiles: true,
      }),
    ).rejects.toThrow("runtime differs from committed source folder")
    expect(await Bun.file(path.join(plugin, "index.js")).exists()).toBe(true)
  })
})
