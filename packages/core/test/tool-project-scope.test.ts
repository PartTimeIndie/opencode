import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { testEffect } from "./lib/effect"

const permission = Layer.succeed(PermissionV2.Service, PermissionV2.Service.of({
  assert: () => Effect.void, ask: () => Effect.die("unused"), reply: () => Effect.die("unused"),
  materializationRules: () => Effect.succeed([]), get: () => Effect.die("unused"),
  forSession: () => Effect.die("unused"), list: () => Effect.die("unused"),
}))
const location = Layer.succeed(Location.Service, Location.Service.of({
  directory: AbsolutePath.make("C:/Projects/Other"),
  project: { id: Project.ID.make("other"), directory: AbsolutePath.make("C:/Projects/Other") },
}))
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission), Layer.provide(location))
const it = testEffect(Layer.mergeAll(registry, permission, location))

describe("ToolRegistry project availability", () => {
  it.effect("advertises a scoped tool in its selected project", () => Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    yield* registry.register({ scoped: Tool.make({
      description: "Scoped", input: Schema.Struct({}), output: Schema.Struct({ ok: Schema.Boolean }),
      execute: () => Effect.succeed({ ok: true }),
    }) })
    const tools = yield* registry.materialize(
      [{ action: "scoped", resource: "*", effect: "allow" }],
      { mode: "explicit", entries: { scoped: { visible: true, permission: "allow", scope: { mode: "projects", projects: ["C:/Projects/Other"] } } } },
    )
    expect(tools.definitions.map((item) => item.name)).toContain("scoped")
  }))
  it.effect("does not advertise a tool in an unselected project even with allow permission", () => Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    yield* registry.register({ scoped: Tool.make({
      description: "Scoped", input: Schema.Struct({}), output: Schema.Struct({ ok: Schema.Boolean }),
      execute: () => Effect.succeed({ ok: true }),
    }) })
    const tools = yield* registry.materialize(
      [{ action: "scoped", resource: "*", effect: "allow" }],
      { mode: "explicit", entries: { scoped: { visible: true, permission: "allow", scope: { mode: "projects", projects: ["C:/Projects/PU"] } } } },
    )
    expect(tools.definitions.map((item) => item.name)).not.toContain("scoped")
  }))
})
