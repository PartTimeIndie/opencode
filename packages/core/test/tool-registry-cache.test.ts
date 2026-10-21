import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigOptimization } from "@opencode-ai/core/config/optimization"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { testEffect } from "./lib/effect"

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

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            optimization: new ConfigOptimization.Info({
              features: new ConfigOptimization.Features({ tool_materialization_cache: true }),
            }),
          }),
        }),
      ]),
  }),
)

const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission), Layer.provide(config))
const it = testEffect(Layer.mergeAll(registry, permission, config))

describe("ToolRegistry materialization cache", () => {
  it.effect("reuses filtered definitions when the registry and permissions are unchanged", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        cached: Tool.make({
          description: "Cached test tool",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.succeed({ ok: true }),
        }),
      })

      const first = yield* registry.materialize()
      const second = yield* registry.materialize()

      expect(second.definitions).toBe(first.definitions)
    }),
  )

  it.effect("invalidates cached definitions when permission rules change", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        cached: Tool.make({
          description: "Cached test tool",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.succeed({ ok: true }),
        }),
      })

      const allowed = yield* registry.materialize()
      const denied = yield* registry.materialize([{ action: "cached", resource: "*", effect: "deny" }])
      const allowedAgain = yield* registry.materialize()

      expect(allowed.definitions.map((definition) => definition.name)).toEqual(["cached"])
      expect(denied.definitions).toEqual([])
      expect(allowedAgain.definitions).toBe(allowed.definitions)
    }),
  )

  it.effect("keeps permission rule order in the cache key", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        cached: Tool.make({
          description: "Cached test tool",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.succeed({ ok: true }),
        }),
      })

      const allowAfterDeny = yield* registry.materialize([
        { action: "*", resource: "*", effect: "deny" },
        { action: "cached", resource: "private", effect: "allow" },
      ])
      const denyAfterAllow = yield* registry.materialize([
        { action: "cached", resource: "private", effect: "allow" },
        { action: "*", resource: "*", effect: "deny" },
      ])

      expect(allowAfterDeny.definitions.map((definition) => definition.name)).toEqual(["cached"])
      expect(denyAfterAllow.definitions).toEqual([])
    }),
  )

})
