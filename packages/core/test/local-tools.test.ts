import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Schema } from "effect"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { LocalTool } from "@opencode-ai/core/tool/local"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { settleTool, toolDefinitions } from "./lib/tool"

const pluginToolSpecifier = pathToFileURL(path.join(import.meta.dir, "..", "..", "plugin", "src", "tool.ts")).href

const layer = (directory: string, config = path.join(directory, "global-config")) => {
  const applications = ApplicationTools.layer
  const services = Layer.mergeAll(
    ToolRegistry.layer.pipe(Layer.provideMerge(applications), Layer.provide(ToolOutputStore.defaultLayer)),
    FSUtil.defaultLayer,
    Global.layerWith({ config }),
    Npm.defaultLayer,
    Layer.succeed(
      Location.Service,
      Location.Service.of({
        directory: AbsolutePath.make(directory),
        project: { id: Project.ID.global, directory: AbsolutePath.make(directory) },
      }),
    ),
  )
  return Layer.merge(services, LocalTool.locationLayer.pipe(Layer.provide(services)))
}

describe("LocalTool", () => {
  it.effect("blocks project tools that collide with an application tool ID", () =>
    Effect.gen(function* () {
      const definition = (description: string) =>
        Tool.make({
          description,
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.succeed("ok"),
        })
      const applications = yield* ApplicationTools.Service
      yield* applications.register({ read: definition("Built-in read") })
      const project = Tool.withCatalog(definition("Project collision"), {
        scope: "location",
        project: "Fixture",
        source: "Fixture/.opencode/tools/read.ts",
      })
      const registry = yield* ToolRegistry.Service
      const error = yield* registry.register({ read: project }).pipe(Effect.flip)
      expect(error.message).toContain("already registered outside this project")
      expect((yield* toolDefinitions(registry)).find((entry) => entry.name === "read")?.description).toBe(
        "Built-in read",
      )
    }).pipe(Effect.provide(layer(process.cwd()))),
  )

  it.effect("keeps a later application registration authoritative over an earlier project tool", () =>
    Effect.gen(function* () {
      const definition = (description: string) =>
        Tool.make({
          description,
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.succeed("ok"),
        })
      const project = Tool.withCatalog(definition("Project collision"), {
        scope: "location",
        project: "Fixture",
        source: "Fixture/.opencode/tools/dynamic.ts",
      })
      const registry = yield* ToolRegistry.Service
      yield* registry.register({ dynamic: project })
      const applications = yield* ApplicationTools.Service
      yield* applications.register({ dynamic: definition("Application dynamic") })

      const entries = yield* registry.catalog()
      expect(entries.filter((entry) => entry.id === "dynamic")).toEqual([
        expect.objectContaining({ description: "Application dynamic", scope: "application" }),
      ])
    }).pipe(Effect.provide(layer(process.cwd()))),
  )


  it.effect("requires and exposes the versioned project tool manifest contract", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, ".opencode", "tools")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(directory, "manifest_tool.ts"),
              `import { tool } from ${JSON.stringify(pluginToolSpecifier)}
export default tool({ description: "Module description", args: {}, async execute() { return "ok" } })
`,
            ),
          )
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(directory, "manifest.json"),
              JSON.stringify({
                schema: "opencode.tools/v1",
                version: 1,
                project: "Fixture",
                tools: [
                  {
                    id: "manifest_tool",
                    version: "1.2.3",
                    description: "Manifest description",
                    entry: "./manifest_tool.ts",
                  },
                ],
              }),
            ),
          )

          return tmp.path
        }).pipe(
          Effect.flatMap((directory) =>
            Effect.gen(function* () {
              const catalog = yield* (yield* ToolRegistry.Service).catalog()
              expect(catalog).toContainEqual({
                id: "manifest_tool",
                description: "Manifest description",
                parameters: expect.objectContaining({ type: "object" }),
                scope: "location",
                project: "Fixture",
                source: path.join(directory, ".opencode", "tools", "manifest_tool.ts"),
                version: "1.2.3",
                visible: true,
              })
            }).pipe(Effect.provide(layer(directory))),
          ),
        ),
      ),
    ),
  )

  it.effect("blocks an incomplete project tool manifest", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, ".opencode", "tools")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "blocked.ts"), "export default {}"))
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(directory, "manifest.json"),
              JSON.stringify({
                schema: "opencode.tools/v1",
                version: 1,
                project: "Fixture",
                tools: [{ id: "blocked", entry: "./blocked.ts" }],
              }),
            ),
          )
          return tmp.path
        }).pipe(
          Effect.flatMap((directory) =>
            Effect.gen(function* () {
              expect((yield* toolDefinitions(yield* ToolRegistry.Service)).map((tool) => tool.name)).not.toContain(
                "blocked",
              )
            }).pipe(Effect.provide(layer(directory))),
          ),
        ),
      ),
    ),
  )

  it.effect("loads valid project local tools while skipping broken imports", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".opencode", "tool"), { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, ".opencode", "tool", "broken.ts"), `import "@does/not-exist"\n`),
          )
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, ".opencode", "tool", "echo_tool.ts"),
              `import { tool } from ${JSON.stringify(pluginToolSpecifier)}

export default tool({
  description: "Echo a local tool value",
  args: {
    value: tool.schema.string().describe("Value to echo"),
  },
  async execute(args, context) {
    context.metadata({ title: "Echoed", metadata: { source: "local" } })
    return {
      output: context.worktree + ":" + args.value,
      attachments: [{ type: "file", mime: "text/plain", url: "data:text/plain;base64,aGVsbG8=", filename: "hello.txt" }],
    }
  },
})
`,
            ),
          )
          return tmp.path
        }).pipe(
          Effect.flatMap((directory) =>
            Effect.gen(function* () {
              const registry = yield* ToolRegistry.Service
              expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("echo_tool")
              expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).not.toContain("broken")
              const result = yield* settleTool(registry, {
                sessionID: SessionV2.ID.make("ses_local_tool"),
                agent: AgentV2.ID.make("build"),
                assistantMessageID: SessionMessage.ID.make("msg_local_tool"),
                call: { type: "tool-call", id: "call-local", name: "echo_tool", input: { value: "hello" } },
              })
              expect(result).toMatchObject({
                result: {
                  type: "content",
                  value: [
                    { type: "text", text: `${tmp.path}:hello` },
                    { type: "file", mime: "text/plain", name: "hello.txt" },
                  ],
                },
                output: {
                  structured: {
                    title: "Echoed",
                    output: `${tmp.path}:hello`,
                    metadata: { source: "local" },
                  },
                },
              })
              if (result.result.type !== "content") throw new Error("Expected multipart local tool output")
              expect(result.result.value[1]).toMatchObject({
                type: "file",
                uri: expect.stringMatching(/^attachment:\/\//),
              })
            }).pipe(Effect.provide(layer(directory))),
          ),
        ),
      ),
    ),
  )

  it.effect("loads global tools and blocks colliding project tool IDs", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const config = path.join(tmp.path, "global-config")
          yield* Effect.promise(() =>
            Promise.all([
              fs.mkdir(path.join(config, "tool"), { recursive: true }),
              fs.mkdir(path.join(tmp.path, ".opencode", "tool"), { recursive: true }),
            ]),
          )
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(
                path.join(config, "tool", "global_tool.ts"),
                `import { tool } from ${JSON.stringify(pluginToolSpecifier)}

export default tool({
  description: "Global tool",
  args: {},
  async execute() {
    return "global"
  },
})
`,
              ),
              fs.writeFile(
                path.join(config, "tool", "shared_tool.ts"),
                `import { tool } from ${JSON.stringify(pluginToolSpecifier)}

export default tool({
  description: "Global shared tool",
  args: {},
  async execute() {
    return "global shared"
  },
})
`,
              ),
              fs.writeFile(
                path.join(tmp.path, ".opencode", "tool", "shared_tool.ts"),
                `import { tool } from ${JSON.stringify(pluginToolSpecifier)}

export default tool({
  description: "Project shared tool",
  args: {},
  async execute() {
    return "project shared"
  },
})
`,
              ),
            ]),
          )
          return { config, directory: tmp.path }
        }).pipe(
          Effect.flatMap((input) =>
            Effect.gen(function* () {
              const registry = yield* ToolRegistry.Service
              expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(
                expect.arrayContaining(["global_tool", "shared_tool"]),
              )
              expect(
                yield* settleTool(registry, {
                  sessionID: SessionV2.ID.make("ses_global_local_tool"),
                  agent: AgentV2.ID.make("build"),
                  assistantMessageID: SessionMessage.ID.make("msg_global_local_tool"),
                  call: { type: "tool-call", id: "call-global", name: "global_tool", input: {} },
                }),
              ).toMatchObject({
                result: { type: "text", value: "global" },
              })
              expect(
                yield* settleTool(registry, {
                  sessionID: SessionV2.ID.make("ses_project_local_tool"),
                  agent: AgentV2.ID.make("build"),
                  assistantMessageID: SessionMessage.ID.make("msg_project_local_tool"),
                  call: { type: "tool-call", id: "call-project", name: "shared_tool", input: {} },
                }),
              ).toMatchObject({
                result: { type: "text", value: "global shared" },
              })
            }).pipe(Effect.provide(layer(input.directory, input.config))),
          ),
        ),
      ),
    ),
  )

  it.effect("resolves global tool dependencies from the global config node_modules", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const config = path.join(tmp.path, "global-config")
          const dependency = path.join(config, "node_modules", "local-tool-fixture")
          yield* Effect.promise(() =>
            Promise.all([
              fs.mkdir(path.join(config, "tool"), { recursive: true }),
              fs.mkdir(dependency, { recursive: true }),
            ]),
          )
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(
                path.join(dependency, "package.json"),
                JSON.stringify({ name: "local-tool-fixture", type: "module", exports: "./index.js" }),
              ),
              fs.writeFile(path.join(dependency, "index.js"), `export const value = "global dependency"\n`),
              fs.writeFile(
                path.join(config, "tool", "dependency_tool.ts"),
                `import { tool } from ${JSON.stringify(pluginToolSpecifier)}
import { value } from "local-tool-fixture"

export default tool({
  description: "Global dependency tool",
  args: {},
  async execute() {
    return value
  },
})
`,
              ),
            ]),
          )
          return { config, directory: tmp.path }
        }).pipe(
          Effect.flatMap((input) =>
            Effect.gen(function* () {
              const registry = yield* ToolRegistry.Service
              expect(
                yield* settleTool(registry, {
                  sessionID: SessionV2.ID.make("ses_global_dependency_tool"),
                  agent: AgentV2.ID.make("build"),
                  assistantMessageID: SessionMessage.ID.make("msg_global_dependency_tool"),
                  call: { type: "tool-call", id: "call-global-dependency", name: "dependency_tool", input: {} },
                }),
              ).toMatchObject({ result: { type: "text", value: "global dependency" } })
            }).pipe(Effect.provide(layer(input.directory, input.config))),
          ),
        ),
      ),
    ),
  )

  it.effect("installs declared project tool dependencies before importing local tools", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const config = path.join(tmp.path, ".opencode")
          const dependency = path.join(config, "local-tool-fixture")
          yield* Effect.promise(() =>
            Promise.all([
              fs.mkdir(path.join(config, "tool"), { recursive: true }),
              fs.mkdir(dependency, { recursive: true }),
            ]),
          )
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(
                path.join(config, "package.json"),
                JSON.stringify({
                  type: "module",
                  dependencies: { "local-tool-fixture": "file:./local-tool-fixture" },
                }),
              ),
              fs.writeFile(
                path.join(dependency, "package.json"),
                JSON.stringify({ name: "local-tool-fixture", version: "1.0.0", type: "module", exports: "./index.js" }),
              ),
              fs.writeFile(path.join(dependency, "index.js"), `export const value = "installed dependency"\n`),
              fs.writeFile(
                path.join(config, "tool", "dependency_tool.ts"),
                `import { tool } from ${JSON.stringify(pluginToolSpecifier)}
import { value } from "local-tool-fixture"

export default tool({
  description: "Installed project dependency tool",
  args: {},
  async execute() {
    return value
  },
})
`,
              ),
            ]),
          )
          return tmp.path
        }).pipe(
          Effect.flatMap((directory) =>
            Effect.gen(function* () {
              const registry = yield* ToolRegistry.Service
              expect(
                yield* settleTool(registry, {
                  sessionID: SessionV2.ID.make("ses_project_dependency_tool"),
                  agent: AgentV2.ID.make("build"),
                  assistantMessageID: SessionMessage.ID.make("msg_project_dependency_tool"),
                  call: { type: "tool-call", id: "call-project-dependency", name: "dependency_tool", input: {} },
                }),
              ).toMatchObject({ result: { type: "text", value: "installed dependency" } })
            }).pipe(Effect.provide(layer(directory))),
          ),
        ),
      ),
    ),
    { timeout: 20_000 },
  )

  it.effect("uses deterministic precedence and falls back from a broken higher-priority override", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const config = path.join(tmp.path, "global-config")
          yield* Effect.promise(() =>
            Promise.all([
              fs.mkdir(path.join(config, "tool"), { recursive: true }),
              fs.mkdir(path.join(config, "tools"), { recursive: true }),
              fs.mkdir(path.join(tmp.path, ".opencode", "tools"), { recursive: true }),
            ]),
          )
          const source = (value: string) => `import { tool } from ${JSON.stringify(pluginToolSpecifier)}

export default tool({
  description: "Precedence fixture",
  args: {},
  async execute() {
    return ${JSON.stringify(value)}
  },
})
`
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(config, "tool", "extension_tool.js"), source("javascript")),
              fs.writeFile(path.join(config, "tool", "extension_tool.ts"), source("typescript")),
              fs.writeFile(path.join(config, "tool", "directory_tool.ts"), source("global tool")),
              fs.writeFile(path.join(config, "tools", "directory_tool.ts"), source("global tools")),
              fs.writeFile(path.join(config, "tool", "broken_override.ts"), source("global fallback")),
              fs.writeFile(path.join(tmp.path, ".opencode", "tools", "directory_tool.ts"), source("project tools")),
              fs.writeFile(
                path.join(tmp.path, ".opencode", "tools", "broken_override.ts"),
                `import "@does/not-exist"\n`,
              ),
            ]),
          )
          return { config, directory: tmp.path }
        }).pipe(
          Effect.flatMap((input) =>
            Effect.gen(function* () {
              const registry = yield* ToolRegistry.Service
              expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("broken_override")
              expect(
                yield* settleTool(registry, {
                  sessionID: SessionV2.ID.make("ses_extension_precedence"),
                  agent: AgentV2.ID.make("build"),
                  assistantMessageID: SessionMessage.ID.make("msg_extension_precedence"),
                  call: { type: "tool-call", id: "call-extension", name: "extension_tool", input: {} },
                }),
              ).toMatchObject({ result: { type: "text", value: "typescript" } })
              expect(
                yield* settleTool(registry, {
                  sessionID: SessionV2.ID.make("ses_directory_precedence"),
                  agent: AgentV2.ID.make("build"),
                  assistantMessageID: SessionMessage.ID.make("msg_directory_precedence"),
                  call: { type: "tool-call", id: "call-directory", name: "directory_tool", input: {} },
                }),
              ).toMatchObject({ result: { type: "text", value: "global tools" } })
              expect(
                yield* settleTool(registry, {
                  sessionID: SessionV2.ID.make("ses_broken_override_fallback"),
                  agent: AgentV2.ID.make("build"),
                  assistantMessageID: SessionMessage.ID.make("msg_broken_override_fallback"),
                  call: { type: "tool-call", id: "call-fallback", name: "broken_override", input: {} },
                }),
              ).toMatchObject({ result: { type: "text", value: "global fallback" } })
            }).pipe(Effect.provide(layer(input.directory, input.config))),
          ),
        ),
      ),
    ),
  )

  it.effect("aborts a local tool when its execution fiber is interrupted", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, ".opencode", "tool")
          const started = path.join(tmp.path, "started.txt")
          const aborted = path.join(tmp.path, "aborted.txt")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(directory, "abort_tool.ts"),
              `import { tool } from ${JSON.stringify(pluginToolSpecifier)}
import fs from "node:fs"

export default tool({
  description: "Abort fixture",
  args: {},
  async execute(args, context) {
    fs.writeFileSync(${JSON.stringify(started)}, String(context.abort.aborted))
    return new Promise((resolve, reject) => {
      context.abort.addEventListener("abort", () => {
        fs.writeFileSync(${JSON.stringify(aborted)}, String(context.abort.aborted))
        reject(new Error("aborted"))
      }, { once: true })
    })
  },
})
`,
            ),
          )
          return { aborted, directory: tmp.path, started }
        }).pipe(
          Effect.flatMap((input) =>
            Effect.gen(function* () {
              const registry = yield* ToolRegistry.Service
              const fiber = yield* settleTool(registry, {
                sessionID: SessionV2.ID.make("ses_abort_local_tool"),
                agent: AgentV2.ID.make("build"),
                assistantMessageID: SessionMessage.ID.make("msg_abort_local_tool"),
                call: { type: "tool-call", id: "call-abort", name: "abort_tool", input: {} },
              }).pipe(Effect.forkChild)
              yield* Effect.promise(() => waitForFile(input.started))
              expect(yield* Effect.promise(() => fs.readFile(input.started, "utf8"))).toBe("false")
              yield* Fiber.interrupt(fiber)
              expect(yield* Effect.promise(() => fs.readFile(input.aborted, "utf8"))).toBe("true")
            }).pipe(Effect.provide(layer(input.directory))),
          ),
        ),
      ),
    ),
  )
})

async function waitForFile(file: string, attempts = 200): Promise<void> {
  if (await Bun.file(file).exists()) return
  if (attempts === 0) throw new Error(`Timed out waiting for ${file}`)
  await Bun.sleep(10)
  return waitForFile(file, attempts - 1)
}
