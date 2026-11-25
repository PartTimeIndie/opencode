import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigAgentPlugin } from "@opencode-ai/core/config/plugin/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { testEffect } from "./lib/effect"

const decode = Schema.decodeUnknownSync(Config.Info)
const make = () =>
  Tool.make({
    description: "Policy test tool",
    input: Schema.Struct({}),
    output: Schema.Struct({}),
    execute: () => Effect.succeed({}),
  })

for (const directory of ["/workspace/allowed", "/workspace/other"]) {
  const location = Layer.succeed(
    Location.Service,
    Location.Service.of({
      directory: AbsolutePath.make(directory),
      project: { id: Project.ID.make("policy-test"), directory: AbsolutePath.make(directory) },
    }),
  )
  const it = testEffect(
    Layer.mergeAll(
      AgentV2.locationLayer,
      FSUtil.defaultLayer,
      ToolRegistry.defaultLayer.pipe(Layer.provide(location)),
      location,
    ),
  )

  describe(`agent tool policy in ${directory}`, () => {
    it.effect("inherits newly registered tools while keeping targeted and bounded-agent denies", () =>
      Effect.gen(function* () {
        const config = Config.Service.of({ entries: () => Effect.succeed([
          new Config.Document({ type: "document", info: decode({ agents: {
            build: { tools: { mode: "inherit", entries: {
              read: { visible: true, permission: "allow" }, bash: { visible: false, permission: "deny" },
            } } },
            bounded: { tools: { mode: "inherit", entries: {
              "*": { visible: false, permission: "deny" }, read: { visible: true, permission: "allow" },
            } } },
          } }) }),
          new Config.Document({ type: "document", info: decode({ agents: {
            build: { tools: { mode: "inherit", entries: { read: { permission: "ask" } } } },
          } }) }),
        ]) })
        yield* ConfigAgentPlugin.Plugin.effect.pipe(Effect.provideService(Config.Service, config))
        const agents = yield* AgentV2.Service
        const registry = yield* ToolRegistry.Service
        yield* registry.register({ read: make(), bash: make(), future_tool: make() })
        const build = yield* agents.get(AgentV2.ID.make("build"))
        const bounded = yield* agents.get(AgentV2.ID.make("bounded"))
        if (!build || !bounded) throw new Error("Expected inherited agents")
        const request = yield* registry.materialize(build.permissions, build.tools)
        expect(request.definitions.map((tool) => tool.name)).toEqual(["read", "future_tool"])
        const restricted = yield* registry.materialize(bounded.permissions, bounded.tools)
        expect(restricted.definitions.map((tool) => tool.name)).toEqual(["read"])
      }),
    )
    it.effect("filters host tools through the project allowlist without bypassing central project restrictions", () =>
      Effect.gen(function* () {
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
                          surface: { visible: true, permission: "allow", scope: { mode: "global" } },
                          switch_agent: { visible: true, permission: "allow" },
                          multi_agent_fanout: { visible: true, permission: "allow" },
                          daily_review_implementation: { visible: true, permission: "allow" },
                          scheduled_job_result: { visible: true, permission: "allow" },
                          project_only: {
                            visible: true,
                            permission: "allow",
                            scope: { mode: "projects", projects: ["/workspace/allowed"] },
                          },
                          project_denied: {
                            visible: true,
                            permission: "allow",
                            projectPermissions: { "/workspace/allowed": "deny", "/workspace/other": "deny" },
                          },
                        },
                      },
                    },
                  },
                }),
              }),
              new Config.Directory({ type: "directory", path: AbsolutePath.make("/no-agent-files") }),
              new Config.Document({
                type: "document",
                info: decode({
                  agents: {
                    build: {
                      tools: {
                        mode: "explicit",
                        entries: {
                          read: { visible: true, permission: "allow" },
                          surface: { visible: true, permission: "allow" },
                          project_only: { visible: true, permission: "allow" },
                          project_denied: { visible: true, permission: "allow" },
                          hidden: { visible: false, permission: "allow" },
                        },
                      },
                    },
                  },
                }),
              }),
            ]),
        })
        yield* ConfigAgentPlugin.Plugin.effect.pipe(Effect.provideService(Config.Service, config))
        const agent = yield* (yield* AgentV2.Service).get(AgentV2.ID.make("build"))
        if (!agent?.tools) throw new Error("Expected configured build tool policy")
        const registry = yield* ToolRegistry.Service
        yield* registry.register({
          read: make(),
          surface: make(),
          switch_agent: Tool.withDefaultDisabled(make()),
          multi_agent_fanout: make(),
          daily_review_implementation: make(),
          scheduled_job_result: Tool.withAlwaysVisible(make()),
          project_only: make(),
          project_denied: make(),
          hidden: make(),
        })
        const request = yield* registry.materialize(agent.permissions, agent.tools)
        expect(request.definitions.map((tool) => tool.name)).toEqual(
          directory === "/workspace/allowed" ? ["read", "surface", "project_only"] : ["read", "surface"],
        )
      }),
    )
  })
}
