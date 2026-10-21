import path from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer, Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { Location } from "@opencode-ai/core/location"
import { McpClient } from "@opencode-ai/core/mcp/client"
import { McpTool } from "@opencode-ai/core/mcp/tool"
import { McpNaming } from "@opencode-ai/core/mcp/naming"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const decode = Schema.decodeUnknownSync(Config.Info)

function serverScript(
  failOnceFile?: string,
  startedFile?: string,
  discoveriesFile?: string,
  listDelay = 0,
  listReleaseFile?: string,
) {
  return `import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
const failOnceFile = ${JSON.stringify(failOnceFile)}
const startedFile = ${JSON.stringify(startedFile)}
const discoveriesFile = ${JSON.stringify(discoveriesFile)}
const listReleaseFile = ${JSON.stringify(listReleaseFile)}
if (startedFile) writeFileSync(startedFile, "started")
const server = new Server({ name: "tools", version: "1.0.0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (discoveriesFile) appendFileSync(discoveriesFile, "x")
  await new Promise((resolve) => setTimeout(resolve, ${listDelay}))
  while (listReleaseFile && !existsSync(listReleaseFile)) await new Promise((resolve) => setTimeout(resolve, 5))
  return { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }
})
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (failOnceFile && !existsSync(failOnceFile)) {
    writeFileSync(failOnceFile, "failed")
    process.exit(1)
  }
  return { content: [{ type: "text", text: "echo:" + request.params.arguments?.text }], structuredContent: { echoed: request.params.arguments?.text, localPath: "C:/secret", nested: { absolute_path: "/secret" } } }
})
await server.connect(new StdioServerTransport())`
}

describe("McpTool", () => {
  it.live(
    "registers default-disabled namespaced tools and executes them through Permission V2",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
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
                            command: [process.execPath, "--eval", serverScript()],
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
          const place = Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
          )
          const assertions: PermissionV2.AssertInput[] = []
          const permission = Layer.mock(PermissionV2.Service, {
            assert: (input) => Effect.sync(() => assertions.push(input)),
            materializationRules: () => Effect.succeed([]),
          })
          const client = McpClient.layer.pipe(Layer.provide(Layer.merge(config, place)))
          const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
          const mcp = McpTool.layer.pipe(Layer.provide(client), Layer.provide(registry), Layer.provide(permission))
          const layer = Layer.mergeAll(config, place, permission, client, registry, mcp)

          return Effect.gen(function* () {
            const tools = yield* ToolRegistry.Service
            expect(
              (yield* tools.materialize([{ action: "*", resource: "*", effect: "allow" }])).definitions.map(
                (tool) => tool.name,
              ),
            ).not.toContain("demo_echo")
            expect(
              (yield* tools.materialize([{ action: "demo_*", resource: "*", effect: "allow" }])).definitions.map(
                (tool) => tool.name,
              ),
            ).toContain("demo_echo")

            const result = yield* tools
              .materialize([{ action: "demo_*", resource: "*", effect: "allow" }])
              .pipe(
                Effect.flatMap((materialized) =>
                  materialized.settle({
                    sessionID: SessionV2.ID.make("ses_mcp_tool"),
                    ...toolIdentity,
                    call: { type: "tool-call", id: "call-mcp", name: "demo_echo", input: { text: "hello" } },
                  }),
                ),
              )
            expect(result.result).toEqual({ type: "text", value: "echo:hello" })
            expect(JSON.stringify(result.output?.structured)).not.toContain("localPath")
            expect(JSON.stringify(result.output?.structured)).not.toContain("absolute_path")
            expect(assertions).toMatchObject([{ action: "demo_echo", resources: ["*"] }])
          }).pipe(Effect.provide(layer))
        }),
      ),
    10_000,
  )

  it.live(
    "does not replay a failed call and reconnects only for the next distinct call",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          const marker = path.join(tmp.path, "failed-once")
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
                            command: [process.execPath, "--eval", serverScript(marker)],
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
          const place = Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
          )
          const permission = Layer.mock(PermissionV2.Service, {
            assert: () => Effect.void,
            materializationRules: () => Effect.succeed([]),
          })
          const client = McpClient.layer.pipe(Layer.provide(Layer.merge(config, place)))
          const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
          const mcp = McpTool.layer.pipe(Layer.provide(client), Layer.provide(registry), Layer.provide(permission))
          const layer = Layer.mergeAll(config, place, permission, client, registry, mcp)

          return Effect.gen(function* () {
            const tools = yield* ToolRegistry.Service
            const materialized = yield* tools.materialize([{ action: "demo_echo", resource: "*", effect: "allow" }])
            const first = yield* materialized.settle({
              sessionID: SessionV2.ID.make("ses_mcp_no_replay"),
              ...toolIdentity,
              call: { type: "tool-call", id: "call-mcp-first", name: "demo_echo", input: { text: "first" } },
            })
            expect(first.result.type).toBe("error")
            expect(existsSync(marker)).toBe(true)

            const second = yield* materialized.settle({
              sessionID: SessionV2.ID.make("ses_mcp_no_replay"),
              ...toolIdentity,
              call: { type: "tool-call", id: "call-mcp-second", name: "demo_echo", input: { text: "second" } },
            })
            expect(second.result).toEqual({ type: "text", value: "echo:second" })
          }).pipe(Effect.provide(layer))
        }),
      ),
    15_000,
  )

  it.live(
    "keeps on-demand servers stopped for location refresh and unrelated explicit policies",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          const started = path.join(tmp.path, "started")
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
                            startup: "on_demand",
                            command: [process.execPath, "--eval", serverScript(undefined, started)],
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
          const place = Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
          )
          const permission = Layer.mock(PermissionV2.Service, {
            assert: () => Effect.void,
            materializationRules: () => Effect.succeed([]),
          })
          const client = McpClient.layer.pipe(Layer.provide(Layer.merge(config, place)))
          const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
          const mcp = McpTool.locationLayer.pipe(Layer.provide(client), Layer.provide(registry), Layer.provide(permission))
          const layer = Layer.mergeAll(config, place, permission, client, registry, mcp)

          return Effect.gen(function* () {
            const mcp = yield* McpTool.Service
            const clients = yield* McpClient.Service
            expect(clients.servers()).toMatchObject([{ name: "demo", startup: "on_demand" }])
            yield* Effect.sleep("100 millis")
            expect(existsSync(started)).toBe(false)

            yield* mcp.ensurePolicy({ mode: "explicit", entries: { "other_*": { permission: "allow" } } })
            expect(existsSync(started)).toBe(false)
            yield* mcp.ensurePolicy({ mode: "explicit", entries: { "demo_*": { permission: "deny" } } })
            expect(existsSync(started)).toBe(false)

            yield* mcp.refresh()
            expect(existsSync(started)).toBe(true)
            const tools = yield* ToolRegistry.Service
            const materialized = yield* tools.materialize([{ action: "demo_echo", resource: "*", effect: "allow" }])
            const result = yield* materialized.settle({
              sessionID: SessionV2.ID.make("ses_mcp_manual_refresh"),
              ...toolIdentity,
              call: { type: "tool-call", id: "call-mcp-manual", name: "demo_echo", input: { text: "manual" } },
            })
            expect(result.result).toEqual({ type: "text", value: "echo:manual" })
          }).pipe(Effect.provide(layer))
        }),
      ),
    15_000,
  )

  it.live(
    "starts and registers an on-demand server for a matching namespaced prefix wildcard",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          const started = path.join(tmp.path, "started")
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
                            startup: "on_demand",
                            command: [process.execPath, "--eval", serverScript(undefined, started)],
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
          const place = Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
          )
          const permission = Layer.mock(PermissionV2.Service, {
            assert: () => Effect.void,
            materializationRules: () => Effect.succeed([]),
          })
          const client = McpClient.layer.pipe(Layer.provide(Layer.merge(config, place)))
          const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
          const mcp = McpTool.layer.pipe(Layer.provide(client), Layer.provide(registry), Layer.provide(permission))
          const layer = Layer.mergeAll(config, place, permission, client, registry, mcp)

          return Effect.gen(function* () {
            const mcp = yield* McpTool.Service
            expect(existsSync(started)).toBe(false)
            yield* mcp.refresh({ mode: "explicit", entries: { "demo_*": { permission: "allow" } } })
            expect(existsSync(started)).toBe(true)

            const tools = yield* ToolRegistry.Service
            const materialized = yield* tools.materialize([{ action: "demo_echo", resource: "*", effect: "allow" }])
            const result = yield* materialized.settle({
              sessionID: SessionV2.ID.make("ses_mcp_prefix_wildcard"),
              ...toolIdentity,
              call: { type: "tool-call", id: "call-mcp-prefix", name: "demo_echo", input: { text: "prefix" } },
            })
            expect(result.result).toEqual({ type: "text", value: "echo:prefix" })
          }).pipe(Effect.provide(layer))
        }),
      ),
    15_000,
  )

  it.live(
    "reconciles MCP config after layer materialization and deduplicates parallel discovery",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          const started = path.join(tmp.path, "started")
          const discoveries = path.join(tmp.path, "discoveries")
          const entries: Array<Config.Document> = []
          const config = Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () => Effect.succeed(entries),
            }),
          )
          const place = Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
          )
          const permission = Layer.mock(PermissionV2.Service, {
            assert: () => Effect.void,
            materializationRules: () => Effect.succeed([]),
          })
          const client = McpClient.layer.pipe(Layer.provide(Layer.merge(config, place)))
          const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
          const mcp = McpTool.layer.pipe(Layer.provide(client), Layer.provide(registry), Layer.provide(permission))
          const layer = Layer.mergeAll(config, place, permission, client, registry, mcp)

          return Effect.gen(function* () {
            const mcp = yield* McpTool.Service
            const clients = yield* McpClient.Service
            expect(clients.servers()).toEqual([])
            expect(existsSync(started)).toBe(false)

            entries.push(
              new Config.Document({
                type: "document",
                info: decode({
                  mcp: {
                    servers: {
                      demo: {
                        type: "local",
                        startup: "on_demand",
                        command: [process.execPath, "--eval", serverScript(undefined, started, discoveries, 100)],
                        cwd: process.cwd(),
                        timeout: 2_000,
                      },
                    },
                  },
                }),
              }),
            )

            yield* Effect.all(
              [
                mcp.refresh({ mode: "explicit", entries: { "demo_*": { permission: "allow" } } }),
                mcp.refresh({ mode: "explicit", entries: { "demo_*": { permission: "allow" } } }),
              ],
              { concurrency: "unbounded" },
            )

            expect(existsSync(started)).toBe(true)
            expect(readFileSync(discoveries, "utf8")).toBe("x")
            const tools = yield* ToolRegistry.Service
            const materialized = yield* tools.materialize([{ action: "demo_echo", resource: "*", effect: "allow" }])
            expect(materialized.definitions.map((tool) => tool.name)).toContain("demo_echo")
          }).pipe(Effect.provide(layer))
        }),
      ),
    15_000,
  )

  it.live(
    "shares failures across parallel refreshes and backs off sequential reconnects",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          const attempts = path.join(tmp.path, "attempts")
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
                          catalog: {
                            type: "local",
                            startup: "on_demand",
                            command: [process.execPath, "--eval", serverScript()],
                            cwd: process.cwd(),
                            timeout: 2_000,
                          },
                          demo: {
                            type: "local",
                            startup: "on_demand",
                            command: [
                              process.execPath,
                              "--eval",
                              `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(attempts)}, "x"); process.exit(1)`,
                            ],
                            cwd: process.cwd(),
                            timeout: 500,
                          },
                        },
                      },
                    }),
                  }),
                ]),
            }),
          )
          const place = Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
          )
          const permission = Layer.mock(PermissionV2.Service, {
            assert: () => Effect.void,
            materializationRules: () => Effect.succeed([]),
          })
          const client = McpClient.layer.pipe(Layer.provide(Layer.merge(config, place)))
          const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
          const mcp = McpTool.locationLayer.pipe(
            Layer.provide(client),
            Layer.provide(registry),
            Layer.provide(permission),
          )
          const layer = Layer.mergeAll(config, place, permission, client, registry, mcp)
          const policy = {
            mode: "explicit" as const,
            entries: {
              "catalog_*": { permission: "allow" as const },
              "demo_*": { permission: "allow" as const },
            },
          }

          return Effect.gen(function* () {
            const service = yield* McpTool.Service
            const results = yield* Effect.all(
              [service.refresh(policy).pipe(Effect.exit), service.refresh(policy).pipe(Effect.exit)],
              { concurrency: "unbounded" },
            )
            expect(results.every(Exit.isSuccess)).toBe(true)
            expect(readFileSync(attempts, "utf8")).toBe("xx")
            yield* service.refresh(policy)
            yield* service.refresh(policy)
            expect(readFileSync(attempts, "utf8")).toBe("xx")
            const tools = yield* ToolRegistry.Service
            const materialized = yield* tools.materialize([
              { action: "catalog_*", resource: "*", effect: "allow" },
              { action: "demo_*", resource: "*", effect: "allow" },
            ])
            expect(materialized.definitions.map((tool) => tool.name)).toContain("catalog_echo")
          }).pipe(Effect.provide(layer))
        }),
      ),
    15_000,
  )

  it.live(
    "does not join a blocking background discovery from provider-turn ensures",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          const started = path.join(tmp.path, "started")
          const discoveries = path.join(tmp.path, "discoveries")
          const release = path.join(tmp.path, "release")
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
                          serpapi: {
                            type: "local",
                            command: [
                              process.execPath,
                              "--eval",
                              serverScript(undefined, started, discoveries, 0, release),
                            ],
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
          const place = Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
          )
          const permission = Layer.mock(PermissionV2.Service, {
            assert: () => Effect.void,
            materializationRules: () => Effect.succeed([]),
          })
          const client = McpClient.layer.pipe(Layer.provide(Layer.merge(config, place)))
          const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
          const mcp = McpTool.locationLayer.pipe(Layer.provide(client), Layer.provide(registry), Layer.provide(permission))
          const layer = Layer.mergeAll(config, place, permission, client, registry, mcp)
          const policy = { mode: "explicit" as const, entries: { "serpapi_*": { permission: "allow" as const } } }

          return Effect.gen(function* () {
            const service = yield* McpTool.Service
            const tools = yield* ToolRegistry.Service

            const ensure = service.ensurePolicy(policy).pipe(Effect.as("ensure" as const))
            const timeout = Effect.sleep("200 millis").pipe(Effect.as("timeout" as const))
            expect(yield* Effect.raceFirst(ensure, timeout)).toBe("ensure")
            const available = service.ensureAvailable().pipe(Effect.as("available" as const))
            expect(yield* Effect.raceFirst(available, timeout)).toBe("available")
            for (let attempt = 0; attempt < 100 && !existsSync(discoveries); attempt++) yield* Effect.sleep("10 millis")
            expect(existsSync(discoveries)).toBe(true)
            expect(readFileSync(discoveries, "utf8")).toBe("x")

            yield* Effect.promise(() => Bun.write(release, "released").then(() => undefined))
            for (let attempt = 0; attempt < 100; attempt++) {
              const materialized = yield* tools.materialize([{ action: "serpapi_*", resource: "*", effect: "allow" }])
              if (materialized.definitions.some((tool) => tool.name === "serpapi_echo")) break
              yield* Effect.sleep("10 millis")
            }
            expect(
              (yield* tools.materialize([{ action: "serpapi_*", resource: "*", effect: "allow" }])).definitions.map(
                (tool) => tool.name,
              ),
            ).toContain("serpapi_echo")

            yield* service.ensurePolicy(policy)
          }).pipe(Effect.provide(layer))
        }),
      ),
    10_000,
  )

  it.live(
    "waits for a newly enabled on-demand server only once",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          const discoveries = path.join(tmp.path, "discoveries")
          const release = path.join(tmp.path, "release")
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
                          serpapi: {
                            type: "local",
                            startup: "on_demand",
                            command: [process.execPath, "--eval", serverScript(undefined, undefined, discoveries, 0, release)],
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
          const place = Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
          )
          const permission = Layer.mock(PermissionV2.Service, {
            assert: () => Effect.void,
            materializationRules: () => Effect.succeed([]),
          })
          const client = McpClient.layer.pipe(Layer.provide(Layer.merge(config, place)))
          const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
          const mcp = McpTool.locationLayer.pipe(Layer.provide(client), Layer.provide(registry), Layer.provide(permission))
          const layer = Layer.mergeAll(config, place, permission, client, registry, mcp)
          const policy = { mode: "explicit" as const, entries: { "serpapi_*": { permission: "allow" as const } } }

          return Effect.gen(function* () {
            const service = yield* McpTool.Service
            const first = yield* service.ensurePolicy(policy).pipe(Effect.forkScoped)
            for (let attempt = 0; attempt < 100 && !existsSync(discoveries); attempt++) yield* Effect.sleep("10 millis")
            expect(existsSync(discoveries)).toBe(true)

            const later = Effect.raceFirst(
              service.ensurePolicy(policy).pipe(Effect.as("ensure" as const)),
              Effect.sleep("200 millis").pipe(Effect.as("timeout" as const)),
            )
            expect(yield* later).toBe("ensure")
            yield* Effect.promise(() => Bun.write(release, "released").then(() => undefined))
            yield* Fiber.join(first)
            yield* service.ensurePolicy(policy)
            expect(readFileSync(discoveries, "utf8")).toBe("x")
          }).pipe(Effect.provide(layer))
        }),
      ),
    10_000,
  )

  it.live(
    "does not retry a failed SerpAPI discovery on every provider turn",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          const attempts = path.join(tmp.path, "attempts")
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
                          serpapi: {
                            type: "local",
                            startup: "on_demand",
                            command: [process.execPath, "--eval", serverScript(undefined, undefined, attempts, 1_000)],
                            cwd: process.cwd(),
                            timeout: 500,
                          },
                        },
                      },
                    }),
                  }),
                ]),
            }),
          )
          const place = Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
          )
          const permission = Layer.mock(PermissionV2.Service, {
            assert: () => Effect.void,
            materializationRules: () => Effect.succeed([]),
          })
          const client = McpClient.layer.pipe(Layer.provide(Layer.merge(config, place)))
          const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
          const mcp = McpTool.locationLayer.pipe(Layer.provide(client), Layer.provide(registry), Layer.provide(permission))
          const layer = Layer.mergeAll(config, place, permission, client, registry, mcp)
          const policy = { mode: "explicit" as const, entries: { "serpapi_*": { permission: "allow" as const } } }

          return Effect.gen(function* () {
            const service = yield* McpTool.Service
            yield* service.ensurePolicy({ mode: "explicit", entries: { "other_*": { permission: "allow" } } })
            yield* service.ensurePolicy(policy)
            for (let attempt = 0; attempt < 100 && !existsSync(attempts); attempt++) yield* Effect.sleep("10 millis")
            const firstAttempts = readFileSync(attempts, "utf8")
            expect(firstAttempts.length).toBeGreaterThan(0)

            // This represents the next provider turn. The prior timeout is
            // remembered, so it must not synchronously enter listTools again.
            yield* service.ensurePolicy(policy)
            expect(readFileSync(attempts, "utf8")).toBe(firstAttempts)
          }).pipe(Effect.provide(layer))
        }),
      ),
    10_000,
  )
})

describe("McpNaming", () => {
  test("preserves V1-compatible safe names and hashes sanitization ambiguities", () => {
    expect(McpNaming.tool("crng", "crng_game_query")).toBe("crng_crng_game_query")
    expect(McpNaming.tool("a.b", "echo")).not.toBe(McpNaming.tool("a_b", "echo"))
    expect(McpNaming.tool("a", "x.y")).not.toBe(McpNaming.tool("a", "x_y"))
  })
})
