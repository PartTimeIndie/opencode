import { describe, expect, test } from "bun:test"
import { McpStarter } from "@opencode-ai/core/mcp/starter"

describe("McpStarter", () => {
  test("parses explicit local starter commands", () => {
    expect(McpStarter.parseInput("npx ctx7 setup")).toEqual({
      name: "ctx7",
      config: { type: "local", command: ["npx", "ctx7", "setup"] },
    })

    expect(McpStarter.parseInput("npx -y @modelcontextprotocol/server-filesystem .")).toEqual({
      name: "modelcontextprotocol-server-filesystem",
      config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] },
    })
  })

  test("does not treat natural language as a local command", () => {
    expect(McpStarter.parseInput("install context7 for me")).toBeUndefined()
  })

  test("normalizes JSON returned by the MCP starter agent", () => {
    expect(
      McpStarter.parseAgentOutput(`Here is the config:\n\`\`\`json
      {"name":"Ctx7 MCP","config":{"type":"local","command":["npx","ctx7","setup"]}}
      \`\`\``),
    ).toEqual({
      name: "ctx7-mcp",
      config: { type: "local", command: ["npx", "ctx7", "setup"] },
    })
  })

  test("accepts agent-corrected Context7 MCP endpoint", () => {
    expect(
      McpStarter.parseAgentOutput(
        `{"name":"context7","config":{"type":"remote","url":"https://mcp.context7.com/mcp"}}`,
      ),
    ).toEqual({
      name: "context7",
      config: { type: "remote", url: "https://mcp.context7.com/mcp" },
    })
    expect(McpStarter.agentPrompt("https://context7.com/")).toContain("https://mcp.context7.com/mcp")
  })

  test("routes documentation/blog URLs to the agent instead of adding a broken remote server", () => {
    expect(McpStarter.parseInput("https://serpapi.com/blog/introducing-serpapis-mcp-server/")).toBeUndefined()
    expect(McpStarter.parseInput("https://docs.example.com/guides/getting-started")).toBeUndefined()
    expect(McpStarter.parseInput("https://example.com/news/launch")).toBeUndefined()
  })

  test("accepts real MCP endpoint URLs directly", () => {
    expect(McpStarter.parseInput("https://mcp.serpapi.com/abc123/mcp")).toEqual({
      name: "serpapi",
      config: { type: "remote", url: "https://mcp.serpapi.com/abc123/mcp" },
    })
    expect(McpStarter.parseInput("https://mcp.context7.com/mcp")).toEqual({
      name: "context7",
      config: { type: "remote", url: "https://mcp.context7.com/mcp" },
    })
    expect(McpStarter.parseInput("https://example.com/sse")).toEqual({
      name: "example",
      config: { type: "remote", url: "https://example.com/sse" },
    })
  })
})
