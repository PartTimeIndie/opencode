import { expect, test } from "bun:test"
import path from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"

const selectors = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_TUI_CONFIG"] as const

test("starts without inherited config selectors", () => {
  selectors.forEach((key) => {
    expect(process.env[key]).toBeUndefined()
    expect(Flag[key]).toBeUndefined()
  })
})

test("preload clears inherited config selectors before source imports", async () => {
  const child = Bun.spawn(
    [process.execPath, "test", import.meta.path, "--test-name-pattern", "^starts without inherited config selectors$"],
    {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        OPENCODE_CONFIG: "synthetic-inherited-config.json",
        OPENCODE_CONFIG_DIR: "synthetic-inherited-config-directory",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "synthetic/inherited" }),
        OPENCODE_TUI_CONFIG: "synthetic-inherited-tui.json",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    },
  )
  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(stderr).not.toContain("(fail)")
    expect(code).toBe(0)
  } finally {
    child.kill()
  }
}, 30_000)
