import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigAgentPlugin } from "@opencode-ai/core/config/plugin/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(AgentV2.locationLayer, FSUtil.defaultLayer))
const decode = Schema.decodeUnknownSync(Config.Info)

describe("central agent project availability", () => {
  it.effect("enforces global tool allowlists even when a project agent lists the tool", () => Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const config = Config.Service.of({ entries: () => Effect.succeed([
      new Config.Document({ type: "document", info: decode({ agents: {
        build: { tools: { mode: "explicit", entries: { read: { visible: true, permission: "ask", scope: { mode: "projects", projects: ["C:/Projects/PU"] }, projectPermissions: { "C:/Projects/PU": "allow" } } } } },
      } }) }),
      new Config.Directory({ type: "directory", path: AbsolutePath.make("C:/Projects/Other/.opencode") }),
      new Config.Document({ type: "document", info: decode({ agents: { build: { tools: { mode: "explicit", entries: { "*": { visible: true, permission: "allow" }, "read*": { visible: true, permission: "allow" } } } } } }) }),
    ]) })
    yield* ConfigAgentPlugin.Plugin.effect.pipe(
      Effect.provideService(Config.Service, config),
      Effect.provideService(AgentV2.Service, agents),
      Effect.provideService(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("C:/Projects/Other") }))),
    )
    const agent = yield* agents.get(AgentV2.ID.make("build"))
    expect(agent?.tools?.entries.read?.visible).toBe(false)
    expect(agent?.tools?.entries.read?.scope?.mode).toBe("projects")
    expect(PermissionV2.evaluate("read", "*", agent?.permissions ?? []).effect).toBe("deny")
  }))
})
