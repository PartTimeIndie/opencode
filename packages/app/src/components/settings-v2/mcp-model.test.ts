import { describe, expect, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Schema } from "effect"
import {
  addMcpServerConfig,
  configuredMcpServers,
  mcpServerAvailableForProject,
  removeMcpServerConfig,
  setMcpServerEnabled,
  setProjectMcpServerAvailability,
  toggleMcpServerConfig,
} from "./mcp-model"

const decodeConfig = Schema.decodeUnknownSync(ConfigV1.Info)

describe("settings MCP model", () => {
  test("builds active global config shape instead of nested mcp.servers", () => {
    const config = addMcpServerConfig(
      { demo: { type: "local", command: ["echo", "demo"], enabled: false } },
      { name: "ctx7", type: "local", command: ["npx", "ctx7", "setup"] },
    )

    expect(config).toEqual({
      mcp: {
        demo: { type: "local", command: ["echo", "demo"], enabled: false },
        ctx7: { type: "local", command: ["npx", "ctx7", "setup"] },
      },
    })
    expect(decodeConfig(config).mcp?.ctx7).toEqual({ type: "local", command: ["npx", "ctx7", "setup"] })
  })

  test("lists, toggles, and removes active MCP config entries", () => {
    const mcp = {
      beta: { type: "remote" as const, url: "https://example.com/mcp", enabled: false },
      alpha: { type: "local" as const, command: ["echo", "alpha"] },
      statusOnly: { enabled: false },
    }

    expect(configuredMcpServers(mcp).map(([name]) => name)).toEqual(["alpha", "beta"])
    expect(toggleMcpServerConfig(mcp, "beta", mcp.beta)).toEqual({
      mcp: {
        ...mcp,
        beta: { type: "remote", url: "https://example.com/mcp", enabled: true },
      },
    })
    expect(toggleMcpServerConfig(mcp, "alpha", mcp.alpha)).toEqual({
      mcp: {
        ...mcp,
        alpha: { type: "local", command: ["echo", "alpha"], enabled: false },
      },
    })
    expect(removeMcpServerConfig(mcp, "alpha")).toEqual({
      mcp: {
        beta: { type: "remote", url: "https://example.com/mcp", enabled: false },
        statusOnly: { enabled: false },
      },
    })
  })

  test("removes Context7 landing page config without touching other servers", () => {
    expect(
      removeMcpServerConfig(
        {
          context7: { type: "remote", url: "https://context7.com/" },
          unityMCP: { type: "remote", url: "http://localhost:8080/mcp" },
        },
        "context7",
      ),
    ).toEqual({
      mcp: {
        unityMCP: { type: "remote", url: "http://localhost:8080/mcp" },
      },
    })
  })

  test("builds global and project availability MCP config", () => {
    const server = { type: "local" as const, command: ["uvx", "mcp-for-unity"] }

    expect(setMcpServerEnabled({ unityMCP: server }, "unityMCP", server, false)).toEqual({
      mcp: {
        unityMCP: { ...server, enabled: false },
      },
    })
    expect(setProjectMcpServerAvailability(undefined, "unityMCP", server, true)).toEqual({
      mcp: {
        unityMCP: { ...server, enabled: true },
      },
    })
    expect(setProjectMcpServerAvailability(undefined, "unityMCP", server, false)).toEqual({
      mcp: {
        unityMCP: { enabled: false },
      },
    })
    expect(
      setProjectMcpServerAvailability(
        {
          context7: { type: "remote", url: "https://context7.com/mcp" },
        },
        "unityMCP",
        server,
        true,
      ),
    ).toEqual({
      mcp: {
        context7: { type: "remote", url: "https://context7.com/mcp" },
        unityMCP: { ...server, enabled: true },
      },
    })
  })

  test("ignores stale project MCP config until the project config is freshly loaded", () => {
    const server = { type: "local" as const, command: ["uvx", "mcp-for-unity"], enabled: false }
    const staleLocal = { type: "local" as const, command: ["uvx", "mcp-for-unity"], enabled: true }

    expect(
      mcpServerAvailableForProject({
        server,
        local: staleLocal,
        fresh: false,
        override: undefined,
        remembered: undefined,
      }),
    ).toBe(false)
    expect(
      mcpServerAvailableForProject({
        server,
        local: staleLocal,
        fresh: true,
        override: undefined,
        remembered: undefined,
      }),
    ).toBe(true)
    expect(
      mcpServerAvailableForProject({
        server,
        local: { ...staleLocal, enabled: false },
        fresh: true,
        override: undefined,
        remembered: undefined,
      }),
    ).toBe(false)
    expect(
      mcpServerAvailableForProject({
        server,
        local: { ...staleLocal, enabled: false },
        fresh: true,
        override: undefined,
        remembered: true,
      }),
    ).toBe(false)
    expect(
      mcpServerAvailableForProject({
        server,
        local: staleLocal,
        fresh: false,
        override: true,
        remembered: undefined,
      }),
    ).toBe(true)
  })
})

describe("settings MCP component wiring", () => {
  test("writes availability from loaded project MCP and catches menu action failures", async () => {
    const source = await Bun.file(new URL("./mcp.tsx", import.meta.url)).text()

    expect(source).toContain("const previousMcp = projectMcp(directory)")
    expect(source).toContain("setProjectMcpServerAvailability(previousMcp, name, server, enabled)")
    expect(source).toContain("syncProjectMcpRuntime(name, [directory], enabled)")
    expect(source).toContain("serverSync().mcp.setAvailability(directory, name, enabled)")
    expect(source).toContain("config: project.previousConfig")
    expect(source).toContain('setStore("error", error instanceof Error ? error.message')
    expect(source).toContain("setAllAvailability(name, server, enabled).catch(() => undefined)")
    expect(source).toContain("setProjectAvailability(name, server, directory, enabled).catch(() => undefined)")
    expect(source).toContain('typeof store.projectAvailability[projectAvailabilityKey(name, directory)] === "boolean"')
    expect(source).toContain('import { parse } from "jsonc-parser"')
    expect(source).toContain("store.projectMcpLoadRetry")
    expect(source).toContain("scheduleProjectMcpRetry(key)")
    expect(source).toContain("projectMcpWriteVersions")
    expect(source).toContain("markProjectMcpChanged(directory)")
  })
})
