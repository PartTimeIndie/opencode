import { describe, expect, test } from "bun:test"
import { command } from "../../src/cli/self"

describe("cli self command", () => {
  test("keeps the TypeScript entrypoint when running through Bun", () => {
    expect(
      command(["storage", "session-worker", "input.json"], {
        execPath: "C:\\Tools\\bun.exe",
        argv: ["C:\\Tools\\bun.exe", "C:\\repo\\src\\index.ts", "serve"],
      }),
    ).toEqual([
      "C:\\Tools\\bun.exe",
      "C:\\repo\\src\\index.ts",
      "storage",
      "session-worker",
      "input.json",
    ])
  })

  test("invokes a compiled OpenCode executable directly", () => {
    expect(
      command(["storage", "migrate"], {
        execPath: "C:\\OpenCode\\opencode.exe",
        argv: ["C:\\OpenCode\\opencode.exe", "serve"],
      }),
    ).toEqual(["C:\\OpenCode\\opencode.exe", "storage", "migrate"])
  })
})
