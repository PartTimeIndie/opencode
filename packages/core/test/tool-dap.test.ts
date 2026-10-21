import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigCapabilities } from "@opencode-ai/core/config/capabilities"
import { DebugAdapter } from "@opencode-ai/core/debug-adapter"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { DAPTool } from "@opencode-ai/core/tool/dap"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_dap_tool_test")
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const locationValue = location({ directory: AbsolutePath.make(process.cwd()) })
const activeLocation = Layer.succeed(Location.Service, Location.Service.of(locationValue))
const mutation = LocationMutation.layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(activeLocation))
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const debug = Layer.succeed(
  DebugAdapter.Service,
  DebugAdapter.Service.of({
    start: (input) => Effect.succeed({ session: "debug-1", capabilities: { mode: input.mode } }),
    request: (input) => Effect.succeed({ command: input.command, arguments: input.arguments }),
    events: () => Effect.succeed([{ type: "event", event: "stopped" }]),
    disconnect: () => Effect.void,
  }),
)

function config(enabled: boolean) {
  return Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({ capabilities: new ConfigCapabilities.Info({ dap: enabled }) }),
          }),
        ]),
    }),
  )
}

const it = testEffect(Layer.empty)

describe("DAPTool", () => {
  it.effect("does not register when the capability is disabled", () =>
    Effect.gen(function* () {
      const configured = config(false)
      const tools = DAPTool.layer.pipe(
        Layer.provide(registry),
        Layer.provide(configured),
        Layer.provide(debug),
        Layer.provide(mutation),
        Layer.provide(permission),
      )
      const service = yield* ToolRegistry.Service
      expect(yield* toolDefinitions(service)).toEqual([])
    }).pipe(Effect.provide(Layer.mergeAll(config(false), debug, mutation, registry, permission, activeLocation))),
  )

  it.effect("registers bounded lifecycle and inspection operations when enabled", () => {
    const configured = config(true)
    const tools = DAPTool.layer.pipe(
      Layer.provide(registry),
      Layer.provide(configured),
      Layer.provide(debug),
      Layer.provide(mutation),
      Layer.provide(permission),
    )
    return Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["dap"])
      expect(
        yield* executeTool(service, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-launch", name: "dap", input: { operation: "launch", adapter: "node" } },
        }),
      ).toMatchObject({ type: "text", value: expect.stringContaining('"session":"debug-1"') })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-stack",
            name: "dap",
            input: { operation: "stack_trace", session: "debug-1", thread_id: 1, limit: 2 },
          },
        }),
      ).toMatchObject({ type: "text", value: expect.stringContaining('"command":"stackTrace"') })
    }).pipe(Effect.provide(Layer.mergeAll(configured, debug, mutation, registry, permission, activeLocation, tools)))
  })
})
