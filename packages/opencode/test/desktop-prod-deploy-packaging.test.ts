import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  buildDesktopSources,
  isDeployableSourceFile,
  nativeWindowsCliOutput,
  requiredDesktopPackageFiles,
  sourceFingerprintGitEnvironment,
} from "../script/desktop-prod-deploy"

describe("desktop prod deploy CLI packaging", () => {
  test("copies current plugin source and assets before building", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "desktop-plugin-sync-"))
    try {
      const source = path.join(root, ".opencode/plugin-sources/example-app")
      const runtime = path.join(root, ".opencode/plugins/example-app")
      await mkdir(source, { recursive: true })
      await mkdir(runtime, { recursive: true })
      await Bun.write(path.join(source, "index.js"), "export default { id: 'example-app' }")
      await Bun.write(path.join(source, "icon.svg"), "<svg/>")
      await Bun.write(path.join(runtime, "stale.js"), "stale")
      await buildDesktopSources(root, "build.log", async (args, cwd) => {
        if (args[2] === "sync:plugins") {
          const child = Bun.spawn([process.execPath, path.resolve("../../script/sync-plugin-sources.ts")], {
            cwd, stdout: "ignore", stderr: "pipe",
          })
          expect(await child.exited).toBe(0)
          return
        }
        expect(await Bun.file(path.join(runtime, "index.js")).text()).toBe("export default { id: 'example-app' }")
        expect(await Bun.file(path.join(runtime, "icon.svg")).text()).toBe("<svg/>")
        expect(await Bun.file(path.join(runtime, "stale.js")).exists()).toBe(false)
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("syncs app plugins before the desktop build using the repository root", async () => {
    const calls: Array<{ args: string[]; cwd: string; log: string }> = []
    await buildDesktopSources("repo", "build.log", async (args, cwd, log) => {
      calls.push({ args, cwd, log })
    })
    expect(calls).toEqual([
      { args: [process.execPath, "run", "sync:plugins"], cwd: "repo", log: "build.log" },
      { args: [process.execPath, "run", "build"], cwd: path.join("repo", "packages", "desktop"), log: "build.log" },
    ])
  })

  test("does not build stale plugins when synchronization fails", async () => {
    const calls: string[][] = []
    await expect(buildDesktopSources("repo", "build.log", async (args) => {
      calls.push(args)
      throw new Error("plugin sync failed")
    })).rejects.toThrow("plugin sync failed")
    expect(calls).toEqual([[process.execPath, "run", "sync:plugins"]])
  })

  test.each([
    ["x64", "opencode-windows-x64"],
    ["arm64", "opencode-windows-arm64"],
  ] as const)("resolves the %s native Windows CLI output", (arch, directory) => {
    expect(nativeWindowsCliOutput("C:\\repo\\packages\\opencode", arch)).toBe(
      path.join("C:\\repo\\packages\\opencode", "dist", directory, "bin", "opencode.exe"),
    )
  })

  test("requires the native CLI in the packaged desktop", () => {
    expect(requiredDesktopPackageFiles()).toContain(path.join("resources", "opencode-cli.exe"))
    for (const family of ["provider", "tui"]) {
      expect(requiredDesktopPackageFiles()).toContain(path.join("resources", "plugin-packages", family, "release-manifest.json"))
    }
  })
})

describe("desktop prod deploy source fingerprint filter", () => {
  test("removes inherited git config injection variables before source enumeration", () => {
    expect(
      sourceFingerprintGitEnvironment({
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "*",
        GIT_CONFIG_KEY_1: "core.autocrlf",
        GIT_CONFIG_VALUE_1: "true",
        GIT_DIR: "C:/repo/.git",
        PATH: "C:/tools",
      }),
    ).toEqual({ GIT_DIR: "C:/repo/.git", PATH: "C:/tools" })
  })

  test("excludes runtime caches that refresh while the app runs", () => {
    expect(isDeployableSourceFile("packages/opencode/.opencode/cache/cursor/cursor-models.json")).toBe(false)
    expect(isDeployableSourceFile("packages/app/.opencode/cache/example.json")).toBe(false)
  })

  test("excludes build output and dependency directories", () => {
    for (const file of [
      "packages/opencode/dist/opencode-windows-x64/bin/opencode.exe",
      "packages/desktop/out/main/index.js",
      "packages/app/node_modules/@solidjs/router/dist/index.js",
      "packages/app/e2e/test-results/regression/spec.spec.ts-snapshots/x.png",
    ]) {
      expect(isDeployableSourceFile(file)).toBe(false)
    }
  })

  test("keeps real deployable source", () => {
    for (const file of [
      "packages/core/src/control-plane/move-session.ts",
      "packages/app/src/context/prompt-session.ts",
      "packages/opencode/script/desktop-prod-deploy.ts",
    ]) {
      expect(isDeployableSourceFile(file)).toBe(true)
    }
  })
})
