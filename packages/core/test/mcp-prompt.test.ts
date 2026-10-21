import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { CommandV2 } from "@opencode-ai/core/command"
import { Config } from "@opencode-ai/core/config"
import { Location } from "@opencode-ai/core/location"
import { McpPrompt } from "@opencode-ai/core/mcp/prompt"
import { McpClient } from "@opencode-ai/core/mcp/client"
import { McpCommandPlugin } from "@opencode-ai/core/plugin/mcp-command"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const decode = Schema.decodeUnknownSync(Config.Info)

function serverScript(input: { attempts: string; failures: number; delay?: number }) {
  return `import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { GetPromptRequestSchema, ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { appendFileSync, readFileSync } from "node:fs"

const attemptsPath = ${JSON.stringify(input.attempts)}
appendFileSync(attemptsPath, "attempt\\n")
const attempts = readFileSync(attemptsPath, "utf8").trim().split(/\\r?\\n/).length
if (attempts <= ${input.failures}) process.exit(1)
if (attempts > ${input.failures + 1}) process.exit(2)
if (${input.delay ?? 0} > 0) await new Promise((resolve) => setTimeout(resolve, ${input.delay ?? 0}))

const server = new Server({ name: "demo", version: "1.0.0" }, { capabilities: { prompts: {} } })
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{ name: "brief", description: "Create a brief", arguments: [{ name: "topic" }] }],
}))
server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
  messages: [{ role: "user", content: { type: "text", text: "brief " + request.params.arguments?.topic } }],
}))
await server.connect(new StdioServerTransport())`
}

function mcpLayer(input: { directory: string; server: string }) {
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: decode({
              mcp: {
                servers: {
                  demo: {
                    type: "local",
                    command: [process.execPath, "--eval", input.server],
                    cwd: process.cwd(),
                    timeout: 2_000,
                  },
                },
              },
            }),
          }),
        ]),
    }),
  )
  const dependencies = Layer.merge(
    config,
    Layer.succeed(
      Location.Service,
      Location.Service.of(location({ directory: AbsolutePath.make(input.directory) })),
    ),
  )
  const client = McpClient.layer.pipe(Layer.provide(dependencies))
  return McpPrompt.layer.pipe(Layer.provide(client))
}

const attemptCount = (file: string) =>
  Effect.promise(() => Bun.file(file).text()).pipe(Effect.map((text) => text.trim().split(/\r?\n/).length))

describe("McpPrompt", () => {
  it.live(
    "connects lazily and reuses a healthy connection",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          const attempts = path.join(tmp.path, "healthy-attempts.txt")
          const server = serverScript({ attempts, failures: 0 })
          return Effect.gen(function* () {
            const mcp = yield* McpPrompt.Service

            expect(yield* Effect.promise(() => Bun.file(attempts).exists())).toBe(false)
            expect(Object.keys(yield* mcp.prompts())).toEqual(["demo:brief"])
            expect(Object.keys(yield* mcp.prompts())).toEqual(["demo:brief"])
            expect(yield* attemptCount(attempts)).toBe(1)
          }).pipe(Effect.provide(mcpLayer({ directory: tmp.path, server })))
        }),
      ),
    10_000,
  )

  it.live(
    "terminates a Windows stdio MCP process tree when the client scope closes",
    () => {
      if (process.platform !== "win32") return Effect.void
      return Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          const attempts = path.join(tmp.path, "tree-attempts.txt")
          const descendant = path.join(tmp.path, "descendant-pid.txt")
          const server = `await new Promise((resolve) => process.stderr.write("x".repeat(1024 * 1024), resolve))
${serverScript({ attempts, failures: 0 })}
const child = Bun.spawn([process.execPath, "--eval", "setInterval(() => {}, 30000)"], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
})
await Bun.write(${JSON.stringify(descendant)}, String(child.pid))`
          return Effect.gen(function* () {
            const pid = yield* Effect.gen(function* () {
              const mcp = yield* McpPrompt.Service
              expect(Object.keys(yield* mcp.prompts())).toEqual(["demo:brief"])
              return Number(yield* Effect.promise(() => Bun.file(descendant).text()))
            }).pipe(Effect.provide(mcpLayer({ directory: tmp.path, server })))

            yield* Effect.sleep("100 millis")
            expect(isProcessRunning(pid)).toBe(false)
          })
        }),
      )
    },
    10_000,
  )

  it.live(
    "connects lazily when a prompt is resolved before discovery",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          const attempts = path.join(tmp.path, "get-prompt-attempts.txt")
          const server = serverScript({ attempts, failures: 0 })
          return Effect.gen(function* () {
            const mcp = yield* McpPrompt.Service

            expect(yield* Effect.promise(() => Bun.file(attempts).exists())).toBe(false)
            const result = yield* mcp.getPrompt("demo", "brief", { topic: "migration" })
            expect(result?.messages[0]?.content).toEqual({ type: "text", text: "brief migration" })
            expect(yield* attemptCount(attempts)).toBe(1)
          }).pipe(Effect.provide(mcpLayer({ directory: tmp.path, server })))
        }),
      ),
    10_000,
  )

  it.live(
    "reconnects once after initial connect failure and registers the prompt command",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          const attempts = path.join(tmp.path, "connect-attempts.txt")
          const server = serverScript({ attempts, failures: 1 })
          return Effect.gen(function* () {
            const command = yield* CommandV2.Service
            const mcp = yield* McpPrompt.Service
            yield* McpCommandPlugin.Plugin.effect.pipe(
              Effect.provideService(CommandV2.Service, command),
              Effect.provideService(McpPrompt.Service, mcp),
            )

            expect(yield* command.get("demo:brief")).toMatchObject({ source: "mcp", description: "Create a brief" })
            expect(yield* command.resolve({ name: "demo:brief", arguments: "migration" })).toBe("brief migration")
            expect(yield* attemptCount(attempts)).toBe(2)

            expect(Object.keys(yield* mcp.prompts())).toEqual(["demo:brief"])
            expect(yield* attemptCount(attempts)).toBe(2)
          }).pipe(Effect.provide(Layer.mergeAll(CommandV2.locationLayer, mcpLayer({ directory: tmp.path, server }))))
        }),
      ),
    10_000,
  )

  it.live(
    "backs off after reconnect failure and retries when the cooldown expires",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          const attempts = path.join(tmp.path, "retry-attempts.txt")
          const server = serverScript({ attempts, failures: 2 })
          return Effect.gen(function* () {
            const mcp = yield* McpPrompt.Service

            expect(yield* mcp.prompts()).toEqual({})
            expect(yield* attemptCount(attempts)).toBe(2)
            expect(yield* Effect.all([mcp.prompts(), mcp.prompts()], { concurrency: "unbounded" })).toEqual([{}, {}])
            expect(yield* attemptCount(attempts)).toBe(2)
            // Exercise the real cooldown without changing the process-wide clock used by stdio and SDK timers.
            yield* Effect.sleep("30 seconds")
            expect(Object.keys(yield* mcp.prompts())).toEqual(["demo:brief"])
            expect(yield* attemptCount(attempts)).toBe(3)
            expect(Object.keys(yield* mcp.prompts())).toEqual(["demo:brief"])
            expect(yield* attemptCount(attempts)).toBe(3)
          }).pipe(Effect.provide(mcpLayer({ directory: tmp.path, server })))
        }),
      ),
    45_000,
  )

  it.live(
    "shares one in-flight reconnect across concurrent callers",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          const attempts = path.join(tmp.path, "concurrent-attempts.txt")
          const server = serverScript({ attempts, failures: 1, delay: 250 })
          return Effect.gen(function* () {
            const mcp = yield* McpPrompt.Service
            const results = yield* Effect.all([mcp.prompts(), mcp.prompts(), mcp.prompts()], {
              concurrency: "unbounded",
            })

            expect(results.map((result) => Object.keys(result))).toEqual([
              ["demo:brief"],
              ["demo:brief"],
              ["demo:brief"],
            ])
            expect(yield* attemptCount(attempts)).toBe(2)
          }).pipe(Effect.provide(mcpLayer({ directory: tmp.path, server })))
        }),
      ),
    10_000,
  )
})

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
