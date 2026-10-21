import { describe, expect, test } from "bun:test"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { MCP } from "../../src/mcp/index"

const overrideConfigs: ConfigMCPV1.Info[] = [
  { type: "local", command: ["npx", "-y", "computer-use-mcp"], timeout: 12_345 },
  { type: "local", command: ["computer-use-mcp"], timeout: 12_345 },
  { type: "remote", url: "https://example.com/mcp", timeout: 12_345 },
]

describe("MCP.connectTimeout", () => {
  test.each([
    ["npx", ["npx", "-y", "computer-use-mcp"]],
    ["Windows npx shim", ["C:\\Program Files\\nodejs\\npx.cmd", "-y", "computer-use-mcp"]],
    ["bunx", ["bunx", "server-package"]],
    ["bun x", ["bun", "x", "server-package"]],
    ["npm exec", ["npm", "exec", "server-package"]],
    ["pnpx", ["pnpx", "server-package"]],
    ["pnpm dlx", ["pnpm", "dlx", "server-package"]],
    ["yarn dlx", ["yarn", "dlx", "server-package"]],
  ])("allows a cold package install for %s", (_name, command) => {
    expect(MCP.connectTimeout({ type: "local", command })).toBe(120_000)
  })

  test("keeps the default for direct local executables", () => {
    expect(MCP.connectTimeout({ type: "local", command: ["computer-use-mcp"] })).toBe(30_000)
  })

  test("keeps the default for remote servers", () => {
    expect(MCP.connectTimeout({ type: "remote", url: "https://example.com/mcp" })).toBe(30_000)
  })

  test.each(overrideConfigs)("preserves a configured timeout for $type servers", (config) => {
    expect(MCP.connectTimeout(config)).toBe(12_345)
  })
})
