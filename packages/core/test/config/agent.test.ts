import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigAgentPlugin } from "@opencode-ai/core/config/plugin/agent"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AgentPlugin } from "@opencode-ai/core/plugin/agent"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(AgentV2.locationLayer, FSUtil.defaultLayer))
const decode = Schema.decodeUnknownSync(Config.Info)

test("decodes and migrates a V1 agent tool budget", () => {
  const info = Schema.decodeUnknownSync(ConfigAgentV1.Info)({
    tool_budget: { read: 4, grep: 2, glob: 1 },
  })

  expect(ConfigMigrateV1.migrateAgent(info).tool_budget).toEqual({ read: 4, grep: 2, glob: 1 })
  expect(info.options).toEqual({})
})

describe("ConfigAgentPlugin.Plugin", () => {
  test("built-in base guidance routes coordination requests to session_send", () => {
    expect(AgentPlugin.BUILD_SYSTEM).toContain("session_send")
    expect(AgentPlugin.BUILD_SYSTEM).toContain("never guess IDs")
    expect(AgentPlugin.BUILD_SYSTEM).toContain("session_read")
  })

  test("only scoped config, agent markdown, and referenced prompt changes invalidate agent policy", () => {
    const projectConfig = path.resolve(process.cwd(), ".opencode")
    const globalConfig = path.resolve(process.cwd(), "user-config")
    const promptDirectory = path.resolve(process.cwd(), "external-prompts")
    const configFile = path.join(projectConfig, "opencode.json")
    const promptFile = path.join(promptDirectory, "build.md")
    const pathKey = (value: string) =>
      process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
    const watched = {
      configFiles: new Set([pathKey(configFile)]),
      configDirectories: new Set([pathKey(projectConfig), pathKey(globalConfig)]),
      agentDirectories: new Set([pathKey(projectConfig), pathKey(globalConfig)]),
      promptFiles: new Set([pathKey(promptFile)]),
    }
    const change = (directory: string, filename: string | null) =>
      ConfigAgentPlugin.shouldInvalidateAgent({ ...watched, directory, filename })

    expect(change(projectConfig, "opencode.json")).toBe(true)
    expect(change(projectConfig, path.join("agents", "reviewer.md"))).toBe(true)
    expect(change(promptDirectory, "build.md")).toBe(true)
    expect(change(promptDirectory, "unused.md")).toBe(false)
    expect(change(globalConfig, path.join("node_modules", "package", "config.json"))).toBe(false)
    expect(change(path.parse(process.cwd()).root, "unrelated.log")).toBe(false)
    expect(change(path.parse(process.cwd()).root, null)).toBe(false)
  })

  it.effect("applies all global permissions before agent-specific permissions", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const build = AgentV2.ID.make("build")
      const defaults = yield* agents.transform()

      yield* defaults((editor) =>
        editor.update(build, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "bash", resource: "*", effect: "allow" })
        }),
      )

      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                permissions: [{ action: "bash", resource: "*", effect: "ask" }],
                agents: {
                  build: {
                    permissions: [{ action: "bash", resource: "git *", effect: "allow" }],
                  },
                  reviewer: {
                    model: "openrouter/openai/gpt-5",
                    description: "Review changes",
                    mode: "subagent",
                    permissions: [
                      { action: "edit", resource: "*", effect: "deny" },
                      { action: "read", resource: "*", effect: "deny" },
                    ],
                  },
                  removed: { description: "Removed later" },
                },
              }),
            }),
            new Config.Document({
              type: "document",
              info: decode({
                permissions: [{ action: "read", resource: "*", effect: "allow" }],
                agents: {
                  reviewer: { variant: "high", hidden: true },
                  removed: { disabled: true },
                  late: {
                    permissions: [{ action: "edit", resource: "*", effect: "allow" }],
                  },
                },
              }),
            }),
          ]),
      })

      yield* ConfigAgentPlugin.Plugin.effect.pipe(
        Effect.provideService(Config.Service, config),
        Effect.provideService(AgentV2.Service, agents),
      )

      const buildAgent = yield* agents.get(build)
      if (!buildAgent) throw new Error("expected configured build agent")
      expect(buildAgent.permissions).toEqual([
        { action: "bash", resource: "*", effect: "allow" },
        { action: "bash", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "bash", resource: "git *", effect: "allow" },
      ])
      expect(PermissionV2.evaluate("bash", "git status", buildAgent.permissions).effect).toBe("allow")
      expect(PermissionV2.evaluate("bash", "bun test", buildAgent.permissions).effect).toBe("ask")

      const reviewer = yield* agents.get(AgentV2.ID.make("reviewer"))
      if (!reviewer) throw new Error("expected configured reviewer agent")
      expect(reviewer).toMatchObject({
        description: "Review changes",
        mode: "subagent",
        hidden: true,
        model: { providerID: "openrouter", id: "openai/gpt-5", variant: "high" },
      })
      expect(reviewer.permissions).toEqual([
        { action: "bash", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "deny" },
      ])
      expect(PermissionV2.evaluate("read", "README.md", reviewer.permissions).effect).toBe("deny")
      expect((yield* agents.get(AgentV2.ID.make("late")))?.permissions).toEqual([
        { action: "bash", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "allow" },
      ])
      expect(yield* agents.get(AgentV2.ID.make("removed"))).toBeUndefined()
    }),
  )

  it.effect("refreshes configured tool policy for the next selection without mutating an active selection", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const build = AgentV2.ID.make("build")
      let changed: "allow" | "deny" | "omitted" = "allow"
      let refreshLoads = 0
      let rebuilds = 0
      const baseline = yield* agents.transform()
      yield* baseline(() => {
        rebuilds++
      })
      const document = (permission: "allow" | "deny" | "omitted") =>
        new Config.Document({
          type: "document",
          info: decode({
            agents: {
              build: {
                tools: {
                  mode: "explicit",
                  entries: {
                    read: { visible: true, permission: "allow" },
                    ...(permission === "omitted"
                      ? {}
                      : { "computer-use_computer": { visible: permission === "allow", permission } }),
                  },
                },
              },
            },
          }),
        })
      const config = Config.Service.of({
        entries: (input) => {
          if (input?.refresh) refreshLoads++
          return Effect.succeed([document(input?.refresh ? changed : "allow")])
        },
      })

      yield* ConfigAgentPlugin.Plugin.effect.pipe(
        Effect.provideService(Config.Service, config),
        Effect.provideService(AgentV2.Service, agents),
      )

      const activeRound = yield* agents.select(build)
      expect(activeRound.info?.tools?.entries["computer-use_computer"]).toEqual({
        visible: true,
        permission: "allow",
      })

      const beforeReads = rebuilds
      yield* agents.get(build)
      yield* agents.resolve(build)
      yield* agents.default()
      yield* agents.select(build)
      yield* agents.all()
      expect(refreshLoads).toBe(0)
      expect(rebuilds).toBe(beforeReads)

      changed = "deny"
      agents.invalidate?.()
      const nextRound = yield* agents.select(build)
      expect(nextRound.info?.tools?.entries["computer-use_computer"]).toEqual({
        visible: false,
        permission: "deny",
      })
      expect(refreshLoads).toBe(1)
      expect(activeRound.info?.tools?.entries["computer-use_computer"]).toEqual({
        visible: true,
        permission: "allow",
      })

      changed = "omitted"
      agents.invalidate?.()
      const nextRoundWithoutTool = yield* agents.select(build)
      expect(nextRoundWithoutTool.info?.tools?.entries).not.toHaveProperty("computer-use_computer")
      expect(nextRoundWithoutTool.info?.tools?.entries.read).toEqual({ visible: true, permission: "allow" })
      expect(refreshLoads).toBe(2)
      expect(activeRound.info?.tools?.entries["computer-use_computer"]).toEqual({
        visible: true,
        permission: "allow",
      })

      const afterRefresh = rebuilds
      yield* agents.resolve(build)
      yield* agents.get(build)
      yield* agents.select(build)
      yield* agents.all()
      expect(refreshLoads).toBe(2)
      expect(rebuilds).toBe(afterRefresh)
    }),
  )

  it.effect("a later project document replaces an earlier explicit tool allowlist wholesale", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const build = AgentV2.ID.make("build")
      const tool = (permission: "allow" | "deny", visible = true) => ({ visible, permission })
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                agents: {
                  build: {
                    tools: {
                      mode: "explicit",
                      entries: {
                        read: tool("allow"),
                        surface: tool("allow"),
                        switch_agent: tool("allow"),
                        multi_agent_fanout: tool("allow"),
                      },
                    },
                  },
                },
              }),
            }),
            new Config.Document({
              type: "document",
              info: decode({
                agents: {
                  build: {
                    tools: {
                      mode: "explicit",
                      entries: {
                        read: tool("allow"),
                        surface: tool("allow"),
                        task: tool("deny", false),
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* ConfigAgentPlugin.Plugin.effect.pipe(
        Effect.provideService(Config.Service, config),
        Effect.provideService(AgentV2.Service, agents),
      )

      const buildAgent = yield* agents.get(build)
      if (!buildAgent?.tools) throw new Error("expected configured build agent tools")
      expect(buildAgent.tools.mode).toBe("explicit")
      expect(Object.keys(buildAgent.tools.entries).toSorted()).toEqual(["read", "surface", "task"])
      expect(buildAgent.tools.entries.switch_agent).toBeUndefined()
      expect(buildAgent.tools.entries.multi_agent_fanout).toBeUndefined()
      expect(buildAgent.tools.entries.surface).toEqual({ visible: true, permission: "allow" })
    }),
  )

  it.effect("materializes session communication tools from an explicit allowlist with ask permissions", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const build = AgentV2.ID.make("build")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                agents: {
                  build: {
                    tools: {
                      mode: "explicit",
                      entries: {
                        read: { visible: true, permission: "allow" },
                        session_send: { visible: true, permission: "ask" },
                        session_read: { visible: true, permission: "ask" },
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* ConfigAgentPlugin.Plugin.effect.pipe(
        Effect.provideService(Config.Service, config),
        Effect.provideService(AgentV2.Service, agents),
      )

      const buildAgent = yield* agents.get(build)
      if (!buildAgent?.tools) throw new Error("expected configured build agent tools")
      expect(buildAgent.tools.mode).toBe("explicit")
      expect(buildAgent.tools.entries.session_send).toEqual({ visible: true, permission: "ask" })
      expect(buildAgent.tools.entries.session_read).toEqual({ visible: true, permission: "ask" })
      const effects = new Map(buildAgent.permissions.map((rule) => [rule.action, rule.effect] as const))
      expect(effects.get("session_send")).toBe("ask")
      expect(effects.get("session_read")).toBe("ask")
    }),
  )

  it.effect("maps configured agent fields and preserves an unspecified model variant", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                agents: {
                  reviewer: {
                    model: "anthropic/claude-sonnet",
                    system: { mode: "replace", prompt: "Review carefully." },
                    instructions: { mode: "manual", files: ["AGENTS.md"] },
                    tools: {
                      mode: "explicit",
                      entries: {
                        read: { visible: true, permission: "allow" },
                        write: { visible: true, permission: "allow" },
                        bash: { visible: false },
                      },
                    },
                    permissions: [{ action: "edit", resource: "*", effect: "deny" }],
                    completion: { mode: "custom", prompt: "Return DONE or INCOMPLETE." },
                    description: "Reviews changes",
                    mode: "subagent",
                    hidden: true,
                    color: "warning",
                    steps: 12,
                    tool_budget: { read: 6, grep: 2, glob: 2 },
                    request: {
                      headers: { first: "one", shared: "first" },
                      body: { enabled: true, profile: "review", effort: "medium" },
                    },
                  },
                },
              }),
            }),
            new Config.Document({
              type: "document",
              info: decode({
                agents: {
                  reviewer: {
                    request: {
                      headers: { shared: "last", second: "two" },
                      body: { retries: 2, effort: "high" },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* ConfigAgentPlugin.Plugin.effect.pipe(
        Effect.provideService(Config.Service, config),
        Effect.provideService(AgentV2.Service, agents),
      )

      const reviewer = yield* agents.get(AgentV2.ID.make("reviewer"))
      if (!reviewer) throw new Error("expected configured reviewer agent")
      expect(reviewer).toMatchObject({
        system: "Review carefully.",
        systemMode: "replace",
        instructions: { mode: "manual", files: ["AGENTS.md"] },
        tools: {
          mode: "explicit",
            entries: {
              read: { visible: true, permission: "allow" },
              write: { visible: true, permission: "allow" },
              bash: { visible: false, permission: "allow" },
            },
        },
        completion: { mode: "custom", prompt: "Return DONE or INCOMPLETE." },
        description: "Reviews changes",
        mode: "subagent",
        hidden: true,
        color: "warning",
        steps: 12,
        toolBudget: { read: 6, grep: 2, glob: 2 },
        model: { providerID: "anthropic", id: "claude-sonnet", variant: undefined },
      })
      expect(reviewer.request).toEqual({
        headers: { first: "one", shared: "last", second: "two" },
        body: { enabled: true, profile: "review", retries: 2, effort: "high" },
      })
      expect(reviewer.permissions).toEqual([
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "allow" },
        { action: "bash", resource: "*", effect: "deny" },
        { action: "edit", resource: "*", effect: "deny" },
      ])
    }),
  )

  it.effect("restores the normal base guidance when a later config inherits", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({ agents: { helper: { system: { mode: "replace", prompt: "Temporary prompt." } } } }),
            }),
            new Config.Document({
              type: "document",
              info: decode({ agents: { helper: { system: { mode: "inherit" }, mode: "primary" } } }),
            }),
          ]),
      })

      yield* ConfigAgentPlugin.Plugin.effect.pipe(
        Effect.provideService(Config.Service, config),
        Effect.provideService(AgentV2.Service, agents),
      )

      expect(yield* agents.get(AgentV2.ID.make("helper"))).toMatchObject({
        system: AgentPlugin.BUILD_SYSTEM,
        systemMode: "inherit",
      })
    }),
  )

  it.effect("removes a built-in agent disabled by configuration", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const build = AgentV2.ID.make("build")
      const defaults = yield* agents.transform()
      yield* defaults((editor) => editor.update(build, () => {}))

      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({ agents: { build: { disabled: true } } }),
            }),
          ]),
      })

      yield* ConfigAgentPlugin.Plugin.effect.pipe(
        Effect.provideService(Config.Service, config),
        Effect.provideService(AgentV2.Service, agents),
      )

      expect(yield* agents.get(build)).toBeUndefined()
    }),
  )

  it.live("loads legacy file-based agents from config directories", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "agents", "team"), { recursive: true })
            await fs.mkdir(path.join(tmp.path, "modes"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "agents", "reviewer.md"),
              `---
model: openrouter/openai/gpt-5
description: Markdown description
temperature: 0.5
tools:
  write: false
---
Review carefully.`,
            )
            await fs.writeFile(path.join(tmp.path, "agents", "team", "helper.md"), "Help the team.")
            await fs.writeFile(
              path.join(tmp.path, "agents", "native.md"),
              `---
request:
  headers:
    x-agent: native
  body:
    effort: high
permissions:
  - action: edit
    resource: "*"
    effect: deny
---
Use native v2 fields.`,
            )
            await fs.writeFile(path.join(tmp.path, "agents", "disabled.md"), "---\ndisabled: true\n---\nDisabled")
            await fs.writeFile(path.join(tmp.path, "modes", "plan.md"), "Make a plan.")
            await fs.writeFile(
              path.join(tmp.path, "agents", "policy.md"),
              `---\nsystem:\n  mode: append\n  prompt: Frontmatter policy.\n---\nBody policy.`,
            )
            await fs.writeFile(
              path.join(tmp.path, "agents", "legacy-tools.md"),
              `---\nmodel: openrouter/openai/gpt-5\ntools:\n  write: false\n---\nLegacy tools.`,
            )
            await fs.writeFile(
              path.join(tmp.path, "agents", "legacy-options.md"),
              `---\nmodel: openrouter/openai/gpt-5\ntemperature: 0.25\n---\nLegacy options.`,
            )
          })
          const agents = yield* AgentV2.Service
          const config = Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: decode({ agents: { reviewer: { description: "JSON description" } } }),
                }),
                new Config.Directory({ type: "directory", path: AbsolutePath.make(tmp.path) }),
              ]),
          })

          yield* ConfigAgentPlugin.Plugin.effect.pipe(
            Effect.provideService(Config.Service, config),
            Effect.provideService(AgentV2.Service, agents),
          )

          expect(yield* agents.get(AgentV2.ID.make("reviewer"))).toMatchObject({
            model: { providerID: "openrouter", id: "openai/gpt-5" },
            system: "Review carefully.",
            description: "Markdown description",
            request: { body: { temperature: 0.5 } },
            permissions: [{ action: "edit", resource: "*", effect: "deny" }],
          })
          expect(yield* agents.get(AgentV2.ID.make("team/helper"))).toMatchObject({ system: "Help the team." })
          expect(yield* agents.get(AgentV2.ID.make("native"))).toMatchObject({
            system: "Use native v2 fields.",
            request: { headers: { "x-agent": "native" }, body: { effort: "high" } },
            permissions: [{ action: "edit", resource: "*", effect: "deny" }],
          })
          expect(yield* agents.get(AgentV2.ID.make("disabled"))).toBeUndefined()
          expect(yield* agents.get(AgentV2.ID.make("plan"))).toMatchObject({ system: "Make a plan.", mode: "primary" })
          expect(yield* agents.get(AgentV2.ID.make("policy"))).toMatchObject({
            system: `${AgentPlugin.BUILD_SYSTEM}\n\nFrontmatter policy.\n\nBody policy.`,
            systemMode: "append",
          })
          expect(yield* agents.get(AgentV2.ID.make("legacy-tools"))).toMatchObject({
            model: { providerID: "openrouter", id: "openai/gpt-5" },
            system: "Legacy tools.",
            permissions: [{ action: "edit", resource: "*", effect: "deny" }],
          })
          expect(yield* agents.get(AgentV2.ID.make("legacy-options"))).toMatchObject({
            model: { providerID: "openrouter", id: "openai/gpt-5" },
            system: "Legacy options.",
            request: { body: { temperature: 0.25 } },
          })
        }),
      ),
    ),
  )

  it.live("loads system and completion prompt files from project-relative and absolute paths", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const projectPrompt = path.join(tmp.path, "prompts", "system.md")
          const sharedPrompt = path.join(tmp.path, "shared", "completion.prompt")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.dirname(projectPrompt), { recursive: true })
            await fs.mkdir(path.dirname(sharedPrompt), { recursive: true })
            await fs.writeFile(projectPrompt, "System prompt from project.")
            await fs.writeFile(sharedPrompt, "Completion prompt from shared path.")
          })
          const agents = yield* AgentV2.Service
          const config = Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  path: path.join(tmp.path, ".opencode", "opencode.json"),
                  info: decode({
                    agents: {
                      fileAgent: {
                        mode: "primary",
                        system: {
                          mode: "replace",
                          prompt: "Inline system.",
                          files: ["prompts/system.md"],
                        },
                        completion: {
                          mode: "custom",
                          prompt: "Inline completion.",
                          files: [sharedPrompt],
                        },
                      },
                    },
                  }),
                }),
              ]),
          })

          yield* ConfigAgentPlugin.Plugin.effect.pipe(
            Effect.provideService(Config.Service, config),
            Effect.provideService(AgentV2.Service, agents),
          )

          expect(yield* agents.get(AgentV2.ID.make("fileAgent"))).toMatchObject({
            system: "Inline system.\n\nSystem prompt from project.",
            systemMode: "replace",
            completion: {
              mode: "custom",
              prompt: "Inline completion.\n\nCompletion prompt from shared path.",
            },
          })
        }),
      ),
    ),
  )
})
