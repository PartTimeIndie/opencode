import fs from "fs/promises"
import path from "path"
import { execFile } from "node:child_process"
import { pathToFileURL } from "url"
import { describe, expect, setDefaultTimeout } from "bun:test"
import { Effect, Equal, Hash, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Tool } from "@opencode-ai/core/public"
import { Catalog } from "@opencode-ai/core/catalog"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionSafetyReview } from "@opencode-ai/core/permission/safety-review"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionPlanDocument } from "@opencode-ai/core/session/plan-document"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolDefinitions } from "./lib/tool"
import { FSUtil } from "../src/fs-util"
import { Credential } from "../src/credential"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { ModelsDev } from "../src/models-dev"
import { Npm } from "../src/npm"
import { Project } from "../src/project"
import { Reference } from "../src/reference"
import { ToolRegistry } from "../src/tool/registry"
import { ApplicationTools } from "../src/tool/application-tools"

const applicationTools = ApplicationTools.layer
setDefaultTimeout(15_000)
const pluginToolSpecifier = pathToFileURL(path.join(import.meta.dir, "..", "..", "plugin", "src", "tool.ts")).href
const it = testEffect(
  Layer.merge(
    Layer.mergeAll(applicationTools, Database.defaultLayer, EventV2.defaultLayer),
    LocationServiceMap.layer.pipe(
      Layer.provide(applicationTools),
      Layer.provide(
        Layer.mergeAll(
          Project.defaultLayer,
          EventV2.defaultLayer,
          Credential.defaultLayer,
          Credential.layer.pipe(Layer.provide(Database.layerFromPath(":memory:").pipe(Layer.fresh))),
          Npm.defaultLayer,
          ModelsDev.defaultLayer,
          FSUtil.defaultLayer,
          Global.defaultLayer,
        ),
      ),
    ),
  ),
)

describe("LocationServiceMap", () => {
  it.effect("compares equivalent location refs by value", () =>
    Effect.sync(() => {
      const directory = AbsolutePath.make("/project")
      expect(Equal.equals(Location.Ref.make({ directory }), Location.Ref.make({ directory }))).toBe(true)
      expect(Hash.hash(Location.Ref.make({ directory }))).toBe(
        Hash.hash(Location.Ref.make({ directory, workspaceID: undefined })),
      )
    }),
  )
  ;(process.platform === "win32" ? it.live : it.live.skip)(
    "dedupes case and separator variants while preserving the first display directory",
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((directory) =>
        Effect.gen(function* () {
          const ref = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
          const variant = Location.Ref.make({
            directory: AbsolutePath.make(directory.path.replaceAll("\\", "/").toUpperCase() as typeof ref.directory),
          })
          const first = yield* Location.Service.pipe(Effect.provide(LocationServiceMap.get(ref)))
          const second = yield* Location.Service.pipe(Effect.provide(LocationServiceMap.get(variant)))

          expect(second).toBe(first)
          expect(first.directory).toBe(directory.path as typeof first.directory)
        }).pipe(Effect.scoped),
      ),
    ),
  )

  it.live(
    "materializes core services while MCP prompt command discovery is blocked",
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((directory) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(directory.path, "opencode.json"),
              JSON.stringify({
                mcp: {
                  servers: {
                    blocked: {
                      type: "local",
                      command: [
                        process.execPath,
                        "--eval",
                        "await new Promise((resolve) => setTimeout(resolve, 30_000))",
                      ],
                      timeout: 30_000,
                    },
                  },
                },
              }),
            ),
          )
          const ref = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
          const locations = yield* LocationServiceMap
          const mcpCommands = yield* Effect.gen(function* () {
            const boot = yield* PluginBoot.Service
            yield* boot.wait()
            yield* AgentV2.Service
            yield* PermissionV2.Service
            yield* QuestionV2.Service
            return yield* boot.wait({ mcpCommands: true }).pipe(Effect.timeoutOption("100 millis"))
          }).pipe(
            Effect.provide(locations.get(ref)),
            Effect.timeout("6 seconds"),
            Effect.scoped,
            Effect.ensuring(locations.invalidate(ref)),
          )

          expect(mcpCommands._tag).toBe("None")
        }),
      ),
    ),
    15_000,
  )

  it.live(
    "exposes session plan documents and action invocations to project local tools",
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((directory) =>
        Effect.gen(function* () {
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) =>
                execFile("git", ["init", "--quiet", directory.path], (error) => (error ? reject(error) : resolve())),
              ),
          )
          yield* Effect.promise(() =>
            fs.mkdir(path.join(directory.path, ".opencode", "tools"), { recursive: true }),
          )
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(directory.path, ".opencode", "tools", "plan_probe.ts"),
              `import { tool } from ${JSON.stringify(pluginToolSpecifier)}

export default tool({
  description: "Probe session plan document and action invocation visibility",
  args: {},
  async execute(_args, context) {
    const plan = await context.sessionContext.planDocument()
    const invocations = await context.sessionContext.actionInvocations()
    return JSON.stringify({ plan, invocations })
  },
})
`,
            ),
          )

          const sessionID = SessionV2.ID.make("ses_local_tool_context")
          const ref = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
          const locations = yield* LocationServiceMap
          const observed = yield* Effect.gen(function* () {
            yield* (yield* PluginBoot.Service).wait()
            const db = (yield* Database.Service).db
            const now = Date.now()
            yield* db
              .insert(ProjectTable)
              .values({
                id: ProjectV2.ID.make("project_local_tool_context"),
                worktree: AbsolutePath.make(directory.path),
                sandboxes: [],
                time_created: now,
                time_updated: now,
              })
              .run()
              .pipe(Effect.orDie)
            yield* db
              .insert(SessionTable)
              .values({
                id: sessionID,
                project_id: ProjectV2.ID.make("project_local_tool_context"),
                slug: "local-tool-context",
                directory: directory.path,
                title: "Local tool context probe",
                version: "1",
                time_created: now,
                time_updated: now,
              })
              .run()
              .pipe(Effect.orDie)

            yield* (yield* SessionPlanDocument.Service).replace({
              sessionID,
              markdown: "# Daily Review plan\n\nrunId: morning-2026-09-08-1788877963652-94780",
            })

            const questions = yield* QuestionV2.Service
            const request = yield* questions.present({
              sessionID,
              mode: "interactive",
              surface: {
                version: 1,
                controlID: "local-tool-context-probe",
                controls: [],
                actions: [
                  {
                    id: "handoff",
                    trigger: { event: "click" },
                    steps: [{ type: "command", command: "echo", arguments: ["confirmed"] }],
                  },
                ],
              },
            })
            const input: QuestionV2.BeginActionInvocationInput = {
              id: "inv_local_tool_context",
              target: { kind: "request", id: request.id, revision: request.revision },
              actionID: "handoff",
              values: {},
            }
            yield* questions.beginActionInvocation(input)
            const completed = yield* questions.completeActionInvocation(input.id, { ok: true })
            expect(completed.state).toBe("completed")

            const registry = yield* ToolRegistry.Service
            const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
            if (!names.includes("plan_probe")) throw new Error(`plan_probe not registered: ${JSON.stringify(names)}`)
            const result = yield* settleTool(registry, {
              sessionID,
              agent: AgentV2.ID.make("build"),
              assistantMessageID: SessionMessage.ID.make("msg_local_tool_context"),
              call: { type: "tool-call", id: "call-local-tool-context", name: "plan_probe", input: {} },
            })
            const raw = result.result
            const text =
              typeof raw === "string"
                ? raw
                : raw.type === "text"
                  ? typeof raw.value === "string"
                    ? raw.value
                    : undefined
                  : raw.type === "content"
                    ? raw.value.find((part): part is { type: "text"; text: string } => part.type === "text")?.text
                    : undefined
            if (typeof text !== "string")
              throw new Error(`Expected text local tool output: ${JSON.stringify(result.result)}`)
            return JSON.parse(text) as {
              plan: { revision: number; markdown: string } | undefined
              invocations: ReadonlyArray<{ invocation: { state: string }; request: { id: string } }>
            }
          }).pipe(
            Effect.scoped,
            Effect.provide(locations.get(ref)),
            Effect.ensuring(locations.invalidate(ref)),
          )

          expect(observed.plan).toMatchObject({ revision: 1 })
          expect(observed.plan?.markdown).toContain("morning-2026-09-08-1788877963652-94780")
          expect(observed.invocations).toHaveLength(1)
          expect(observed.invocations[0]?.invocation.state).toBe("completed")
        }),
      ),
    ),
    30_000,
  )

  it.live("isolates location state while sharing location policy with catalog", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([blocked, allowed]) =>
        Effect.gen(function* () {
          yield* (yield* ApplicationTools.Service).register({
            application_context: Tool.make({
              description: "Read application context",
              input: Schema.Struct({}),
              output: Schema.Struct({ ok: Schema.Boolean }),
              execute: () => Effect.succeed({ ok: true }),
            }),
          })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(blocked.path, "opencode.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "test" }] },
              }),
            ),
          )

          const update = (directory: string) =>
            Effect.gen(function* () {
              yield* PluginBoot.Service.use((boot) => boot.wait())
              yield* Reference.Service
              const catalog = yield* Catalog.Service
              const transform = yield* catalog.transform()
              yield* transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))
              return {
                providers: yield* catalog.provider.all(),
                tools: yield* toolDefinitions(yield* ToolRegistry.Service),
              }
            }).pipe(
              Effect.scoped,
              Effect.provide(LocationServiceMap.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
            )

          const blockedState = yield* update(blocked.path)
          expect(blockedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(false)
          expect(blockedState.tools.map((tool) => tool.name).sort()).toEqual([
            "application_context",
            "apply_patch",
            "bash",
            "edit",
            "git_status",
            "glob",
            "grep",
            "image_generate",
            "multi_agent_fanout",
            "plan_document",
            "read",
            "session_read",
            "session_send",
            "skill",
            "surface",
            "switch_agent",
            "task",
            "task_cancel",
            "task_result",
            "task_wait",
            "todowrite",
            "webfetch",
            "websearch",
            "write",
          ])
          const allowedState = yield* update(allowed.path)
          expect(allowedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(true)
          expect(allowedState.tools.map((tool) => tool.name).sort()).toEqual([
            "application_context",
            "apply_patch",
            "bash",
            "edit",
            "git_status",
            "glob",
            "grep",
            "image_generate",
            "multi_agent_fanout",
            "plan_document",
            "read",
            "session_read",
            "session_send",
            "skill",
            "surface",
            "switch_agent",
            "task",
            "task_cancel",
            "task_result",
            "task_wait",
            "todowrite",
            "webfetch",
            "websearch",
            "write",
          ])
        }).pipe(
          Effect.ensuring(
            LocationServiceMap.pipe(
              Effect.flatMap((locations) =>
                Effect.all(
                  [
                    locations.invalidate(Location.Ref.make({ directory: AbsolutePath.make(blocked.path) })),
                    locations.invalidate(Location.Ref.make({ directory: AbsolutePath.make(allowed.path) })),
                  ],
                  { discard: true },
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    40_000,
  )

  it.effect("runs the real permission safety review with the location LLM client", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const directory = await tmpdir()
        const requests: string[] = []
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: async (request) => {
            requests.push(await request.text())
            const response =
              'data: {"id":"chatcmpl_review","choices":[{"delta":{"role":"assistant","content":"{\\"decision\\":\\"safe\\",\\"reason\\":\\"test\\"}"},"finish_reason":null}],"usage":null}\n\n' +
              'data: {"id":"chatcmpl_review","choices":[{"delta":{},"finish_reason":"stop"}],"usage":null}\n\n' +
              "data: [DONE]\n\n"
            return new Response(response, { headers: { "content-type": "text/event-stream" } })
          },
        })
        return { directory, requests, server }
      }),
      ({ directory, requests, server }) =>
        Effect.gen(function* () {
          const decision = yield* Effect.gen(function* () {
            yield* PluginBoot.Service.use((boot) => boot.wait())
            const catalog = yield* Catalog.Service
            const providerID = ProviderV2.ID.make("test")
            const modelID = ModelV2.ID.make("model")
            const transform = yield* catalog.transform()
            yield* transform((editor) => {
              editor.provider.update(providerID, (provider) => {
                provider.api = {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: `http://127.0.0.1:${server.port}/v1`,
                }
              })
              editor.model.update(providerID, modelID, (model) => {
                model.api = {
                  id: modelID,
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: `http://127.0.0.1:${server.port}/v1`,
                }
                model.capabilities.tools = true
                model.capabilities.input = ["text/plain"]
                model.capabilities.output = ["text/plain"]
                model.limit.context = 8_192
                model.limit.output = 1_024
              })
            })
            return yield* (yield* PermissionSafetyReview.Service).review({
              safety: { model: "test/model" },
              sessionID: "ses_location_safety_review",
              workspace: { directory: directory.path },
              action: "read",
              resources: ["outside/project.txt"],
              intent: {
                anchor: { role: "user", text: "Read outside/project.txt" },
                recent: [],
                truncated: false,
              },
            })
          }).pipe(
            Effect.scoped,
            Effect.provide(LocationServiceMap.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
          )

          expect(requests).toHaveLength(1)
          expect(requests[0]).toContain("Return ONLY a raw JSON object")
          expect(decision).toMatchObject({ approved: true, cause: "primary_safe" })
        }),
      ({ directory, server }) =>
        Effect.promise(async () => {
          await server.stop(true)
          await directory[Symbol.asyncDispose]()
        }),
    ),
  )
})
