import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { resolveDesktopTestingCli } from "./desktop-testing-cli"

describe("resolveDesktopTestingCli", () => {
  test("uses the checkout CLI for a repository workspace", () => {
    const root = "C:\\repo"
    const entry = join(root, "packages", "opencode", "src", "index.ts")
    expect(
      resolveDesktopTestingCli(
        { directory: join(root, "packages", "app"), env: {}, platform: "win32", exists: (path) => path === entry },
        ["run"],
      ),
    ).toEqual({
      command: "bun",
      args: ["run", "--conditions=browser", entry, "run"],
      cwd: join(root, "packages", "app"),
    })
  })

  test("finds the installed Windows CLI when the target workspace is external", () => {
    const appData = "C:\\Users\\test\\AppData\\Roaming"
    const binary = join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe")
    expect(
      resolveDesktopTestingCli(
        {
          directory: "C:\\external-project",
          env: { APPDATA: appData, PATH: "" },
          platform: "win32",
          exists: (path) => path === binary,
        },
        ["run", "--format", "json"],
      ),
    ).toEqual({ command: binary, args: ["run", "--format", "json"], cwd: "C:\\external-project" })
  })
})
