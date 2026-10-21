export * as McpStarter from "./starter"

import { ConfigMCPV1 } from "../v1/config/mcp"
import { Schema } from "effect"
import * as Option from "effect/Option"
import { parse, type ParseError } from "jsonc-parser"

const StarterResult = Schema.Struct({
  name: Schema.String,
  config: ConfigMCPV1.Info,
})
export type StarterResult = typeof StarterResult.Type

const decodeStarterResult = Schema.decodeUnknownOption(StarterResult, {
  errors: "all",
  propertyOrder: "original",
})

export function parseInput(input: string) {
  const value = input.trim()
  if (!value) return

  const url = parseUrl(value)
  if (url) {
    // Documentation/blog/marketing pages are not MCP endpoints. Routing them straight
    // into a remote server config would add a broken server that can never connect.
    // Return undefined so the starter agent can infer the real MCP endpoint instead.
    if (looksLikeDocumentation(url)) return
    return {
      name: slug(url.hostname.replace(/^mcp\./, "") || "mcp"),
      config: { type: "remote", url: url.toString() } satisfies ConfigMCPV1.Remote,
    }
  }

  const command = splitCommand(value)
  if (!isLocalStartCommand(command)) return
  return {
    name: slug(localServerName(command)),
    config: { type: "local", command } satisfies ConfigMCPV1.Local,
  }
}

export function parseAgentOutput(output: string) {
  const text = extractJson(output)
  if (!text) return

  const errors: ParseError[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true }) as unknown
  if (errors.length) return
  const result = Option.getOrUndefined(decodeStarterResult(parsed))
  if (!result) return
  return normalizeResult(result)
}

export function normalizeResult(result: StarterResult) {
  const name = slug(result.name)
  if (result.config.type === "local" && result.config.command.length === 0) return
  return { name, config: result.config } satisfies StarterResult
}

export function agentPrompt(input: string) {
  return `You are an OpenCode MCP starter agent. Convert the user's MCP request into a validated OpenCode MCP server config.

Return only JSON. Do not use markdown. The JSON shape must be:
{"name":"short-lowercase-name","config":{"type":"local","command":["cmd","arg"]}}
or:
{"name":"short-lowercase-name","config":{"type":"remote","url":"https://example.com/mcp"}}

Rules:
- Always reason about the user's input before choosing the config, but return only the final JSON.
- For URLs, decide whether the URL is an actual MCP endpoint or a product/project/documentation page.
- If a URL is a product/project/documentation page, infer the official MCP endpoint when it is well-known. Do not blindly preserve landing page URLs.
- For Context7 pages such as https://context7.com/, use the remote MCP endpoint https://mcp.context7.com/mcp.
- For explicit local commands, preserve the command and arguments exactly as an array.
- If a local command is provided, it must be a command that can be executed to start an MCP server.
- For natural-language requests, infer a known MCP server only when you are confident. Otherwise choose the closest local start command.
- Do not include secrets. Prefer environment placeholders when a secret is required.
- Use only OpenCode's current MCP shape: servers are stored directly under mcp.<name>, not under mcp.servers.
- Use enabled only if the user explicitly asks to enable or disable the server.

User input:
${input}`
}

function extractJson(output: string) {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim()
  if (fenced) return fenced

  const start = output.indexOf("{")
  const end = output.lastIndexOf("}")
  if (start === -1 || end <= start) return
  return output.slice(start, end + 1)
}

function parseUrl(value: string) {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") return
  return url
}

const DOCUMENTATION_SEGMENTS = new Set([
  "blog",
  "blogs",
  "docs",
  "documentation",
  "news",
  "articles",
  "article",
  "posts",
  "post",
  "changelog",
  "introducing",
  "announcing",
  "guides",
  "guide",
  "tutorials",
  "tutorial",
  "learn",
  "reference",
])

function looksLikeDocumentation(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  if (host.startsWith("docs.") || host.startsWith("blog.") || host.startsWith("dev.") || host.startsWith("learn.")) return true
  return url.pathname
    .toLowerCase()
    .split("/")
    .some((segment) => DOCUMENTATION_SEGMENTS.has(segment))
}

function splitCommand(value: string) {
  return Array.from(value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)).map((match) => match[1] ?? match[2] ?? match[3] ?? "")
}

function isLocalStartCommand(command: string[]) {
  const launcher = command[0]?.toLowerCase()
  return !!launcher && ["bun", "bunx", "deno", "docker", "node", "npx", "pnpm", "pnpx", "python", "python3", "uvx"].includes(launcher)
}

function localServerName(command: string[]) {
  const launcher = command[0]?.toLowerCase()
  const named =
    launcher === "pnpm" && command[1] === "dlx"
      ? command.slice(2)
      : ["npx", "bunx", "pnpx", "uvx"].includes(launcher)
        ? command.slice(1)
        : command
  return named.find((part) => !part.startsWith("-")) ?? command.find((part) => !part.startsWith("-")) ?? "local-mcp"
}

function slug(value: string) {
  return (
    value
      .replace(/^@/, "")
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "mcp"
  )
}
