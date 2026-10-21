import { afterAll, describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const root = path.resolve(import.meta.dir, "../../..")
const tools = ["github-pr-search.ts", "github-triage.ts"]
const temporary = await mkdtemp(path.join(os.tmpdir(), "opencode-plugin-tool-"))

afterAll(() => rm(temporary, { recursive: true, force: true }))

describe("tool subpath export", () => {
  test("loads durable tools through the workspace source subpath", async () => {
    const fixture = path.join(temporary, "workspace")
    await copyTools(fixture)
    await mkdir(path.join(fixture, "node_modules", "@opencode-ai"), { recursive: true })
    await symlink(
      path.join(root, "packages", "plugin"),
      path.join(fixture, "node_modules", "@opencode-ai", "plugin"),
      "junction",
    )

    expect(await importTools(fixture)).toEqual([0, 0])
  })

  test("loads durable tools through the published dist subpath", async () => {
    const fixture = path.join(temporary, "published")
    const plugin = path.join(fixture, "node_modules", "@opencode-ai", "plugin")
    await copyTools(fixture)
    await mkdir(path.join(plugin, "dist"), { recursive: true })
    await Bun.write(
      path.join(plugin, "package.json"),
      JSON.stringify({
        name: "@opencode-ai/plugin",
        type: "module",
        exports: {
          ".": "./dist/missing-index.js",
          "./tool": "./dist/tool.js",
        },
      }),
    )
    const build = await Bun.build({
      entrypoints: [path.join(root, "packages", "plugin", "src", "tool.ts")],
      outdir: path.join(plugin, "dist"),
      packages: "external",
    })
    expect(build.success).toBe(true)
    await symlink(
      path.join(root, "packages", "plugin", "node_modules", "zod"),
      path.join(fixture, "node_modules", "zod"),
      "junction",
    )

    expect(await importTools(fixture)).toEqual([0, 0])
  })
})

async function copyTools(fixture: string) {
  await mkdir(path.join(fixture, ".opencode", "tools"), { recursive: true })
  await Promise.all(
    tools.map(async (name) => {
      const source = path.join(root, ".opencode", "tools", name)
      expect(await Bun.file(source).text()).toContain('from "@opencode-ai/plugin/tool"')
      await cp(source, path.join(fixture, ".opencode", "tools", name))
    }),
  )
}

async function importTools(fixture: string) {
  return tools.map(
    (name) =>
      Bun.spawnSync([process.execPath, path.join(fixture, ".opencode", "tools", name)], { cwd: fixture }).exitCode,
  )
}
