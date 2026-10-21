import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { State } from "@opencode-ai/core/state"
import { it } from "./lib/effect"

const events = Layer.mock(EventV2.Service)({
  publish: (definition, data) =>
    Effect.succeed({
      id: EventV2.ID.make("evt_plugin_test"),
      type: definition.type,
      data,
    }),
})
const plugins = PluginV2.layer.pipe(Layer.provide(events))

function state() {
  return State.create({
    initial: () => ({ values: [] as string[] }),
    editor: (draft) => ({
      add: (value: string) => draft.values.push(value),
    }),
  })
}

describe("PluginV2", () => {
  it.effect("owns immutable neutral request profiles per location and removes them with the plugin", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const first = Context.get(yield* Layer.buildWithScope(Layer.fresh(plugins), scope), PluginV2.Service)
      const second = Context.get(yield* Layer.buildWithScope(Layer.fresh(plugins), scope), PluginV2.Service)
      const profile = { neutral: { namespace: "first", semantics: { wire: "option" } } }
      const native = { resolve: () => undefined, smallModels: () => ["small"] }
      yield* first.add({ id: PluginV2.ID.make("one"), requestProfiles: profile, nativeModels: { neutral: native }, effect: Effect.void })
      yield* first.add({ id: PluginV2.ID.make("two"), requestProfiles: { another: { namespace: "second", semantics: {} } }, effect: Effect.void })
      yield* second.add({ id: PluginV2.ID.make("one"), requestProfiles: { neutral: { namespace: "isolated", semantics: {} } }, effect: Effect.void })
      profile.neutral.namespace = "mutated"
      profile.neutral.semantics.wire = "mutated"
      expect(first.requestProfiles().neutral).toEqual({ namespace: "first", semantics: { wire: "option" } })
      expect(second.requestProfiles().neutral.namespace).toBe("isolated")
      expect(Object.isFrozen(first.requestProfiles().neutral.semantics)).toBe(true)
      expect(first.nativeModels().neutral.smallModels?.({} as never)).toEqual(["small"])
      expect(second.nativeModels()).toEqual({})
      const effects: string[] = []
      const generation = yield* first.generation()
      const conflict = yield* first.add({ id: PluginV2.ID.make("three"), requestProfiles: profile, effect: Effect.sync(() => { effects.push("must not initialize") }) }).pipe(Effect.exit)
      expect(Exit.isFailure(conflict)).toBe(true)
      const nativeConflict = yield* first.add({ id: PluginV2.ID.make("four"), nativeModels: { neutral: native }, effect: Effect.sync(() => { effects.push("must not initialize") }) }).pipe(Effect.exit)
      expect(Exit.isFailure(nativeConflict)).toBe(true)
      expect(effects).toEqual([])
      expect(yield* first.generation()).toBe(generation)
      yield* first.remove(PluginV2.ID.make("one"))
      expect(first.requestProfiles()).toEqual({ another: { namespace: "second", semantics: {} } })
      expect(first.nativeModels()).toEqual({})
      expect(second.requestProfiles().neutral.namespace).toBe("isolated")
      yield* Scope.close(scope, Exit.void)
      expect(first.requestProfiles()).toEqual({})
      expect(second.requestProfiles()).toEqual({})
      expect(second.nativeModels()).toEqual({})
    }),
  )

  it.effect("closes plugin-owned scopes when the registry layer finalizes", () =>
    Effect.gen(function* () {
      const values = state()
      const layerScope = yield* Scope.fork(yield* Scope.Scope)
      const plugin = Context.get(yield* Layer.buildWithScope(Layer.fresh(plugins), layerScope), PluginV2.Service)

      yield* plugin.add({
        id: PluginV2.ID.make("scoped"),
        effect: Effect.gen(function* () {
          const transform = yield* values.transform()
          yield* transform((editor) => editor.add("scoped"))
        }),
      })
      expect(values.get().values).toEqual(["scoped"])

      yield* Scope.close(layerScope, Exit.void)
      expect(values.get().values).toEqual([])
    }),
  )

  it.effect("serializes same-ID additions and leaves one removable attachment", () =>
    Effect.gen(function* () {
      const values = state()
      const layerScope = yield* Scope.fork(yield* Scope.Scope)
      const plugin = Context.get(yield* Layer.buildWithScope(Layer.fresh(plugins), layerScope), PluginV2.Service)
      const id = PluginV2.ID.make("shared")
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()

      const first = yield* plugin
        .add({
          id,
          effect: Effect.gen(function* () {
            const transform = yield* values.transform()
            yield* transform((editor) => editor.add("first"))
            yield* Deferred.succeed(firstStarted, undefined)
            yield* Deferred.await(releaseFirst)
          }),
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)

      const second = yield* plugin
        .add({
          id,
          effect: Effect.gen(function* () {
            const transform = yield* values.transform()
            yield* transform((editor) => editor.add("second"))
          }),
        })
        .pipe(Effect.forkChild({ startImmediately: true }))
      expect(values.get().values).toEqual(["first"])

      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(values.get().values).toEqual(["second"])

      yield* plugin.remove(id)
      expect(values.get().values).toEqual([])
    }),
  )

  it.effect("removes a mounted hook without disturbing the registry", () =>
    Effect.gen(function* () {
      const layerScope = yield* Scope.fork(yield* Scope.Scope)
      const plugin = Context.get(yield* Layer.buildWithScope(Layer.fresh(plugins), layerScope), PluginV2.Service)
      const id = PluginV2.ID.make("definition-hook")

      yield* plugin.add({
        id,
        effect: Effect.succeed({
          "tool.definition": Effect.fn(function* (evt) {
            evt.description = "Mounted"
          }),
        }),
      })
      expect(
        (yield* plugin.trigger("tool.definition", { toolID: "echo" }, { description: "Base", parameters: {} })).description,
      ).toBe("Mounted")

      yield* plugin.remove(id)
      expect(
        (yield* plugin.trigger("tool.definition", { toolID: "echo" }, { description: "Base", parameters: {} })).description,
      ).toBe("Base")
      yield* Scope.close(layerScope, Exit.void)
    }),
  )

  it.effect("isolates failing hooks and still runs later hooks", () =>
    Effect.gen(function* () {
      const layerScope = yield* Scope.fork(yield* Scope.Scope)
      const plugin = Context.get(yield* Layer.buildWithScope(Layer.fresh(plugins), layerScope), PluginV2.Service)

      yield* plugin.add({
        id: PluginV2.ID.make("broken"),
        effect: Effect.succeed({
          "tool.definition": Effect.fn(function* () {
            return yield* Effect.die("broken hook")
          }),
        }),
      })
      yield* plugin.add({
        id: PluginV2.ID.make("healthy"),
        effect: Effect.succeed({
          "tool.definition": Effect.fn(function* (evt) {
            evt.description = "Healthy"
          }),
        }),
      })

      expect(
        (yield* plugin.trigger("tool.definition", { toolID: "echo" }, { description: "Base", parameters: {} })).description,
      ).toBe("Healthy")
      yield* Scope.close(layerScope, Exit.void)
    }),
  )

  it.effect("keeps the existing hook active when replacement load fails", () =>
    Effect.gen(function* () {
      const layerScope = yield* Scope.fork(yield* Scope.Scope)
      const plugin = Context.get(yield* Layer.buildWithScope(Layer.fresh(plugins), layerScope), PluginV2.Service)
      const id = PluginV2.ID.make("replace-failure")

      yield* plugin.add({
        id,
        effect: Effect.succeed({
          "tool.definition": Effect.fn(function* (evt) {
            evt.description = "Existing"
          }),
        }),
      })
      const before = yield* plugin.generation()
      yield* plugin
        .add({
          id,
          effect: Effect.die("replacement failed"),
        })
        .pipe(Effect.catchDefect(() => Effect.void))

      expect(yield* plugin.generation()).toBe(before)
      expect(
        (yield* plugin.trigger("tool.definition", { toolID: "echo" }, { description: "Base", parameters: {} })).description,
      ).toBe("Existing")
      yield* Scope.close(layerScope, Exit.void)
    }),
  )

  it.effect("does not commit output mutations from failing hooks", () =>
    Effect.gen(function* () {
      const layerScope = yield* Scope.fork(yield* Scope.Scope)
      const plugin = Context.get(yield* Layer.buildWithScope(Layer.fresh(plugins), layerScope), PluginV2.Service)

      yield* plugin.add({
        id: PluginV2.ID.make("mutates-then-fails"),
        effect: Effect.succeed({
          "tool.definition": Effect.fn(function* (evt) {
            evt.description = "Partial"
            return yield* Effect.die("failed after mutation")
          }),
        }),
      })
      yield* plugin.add({
        id: PluginV2.ID.make("observes-clean-output"),
        effect: Effect.succeed({
          "tool.definition": Effect.fn(function* (evt) {
            expect(evt.description).toBe("Base")
            evt.description = "Committed"
          }),
        }),
      })

      expect(
        (yield* plugin.trigger("tool.definition", { toolID: "echo" }, { description: "Base", parameters: {} })).description,
      ).toBe("Committed")
      yield* Scope.close(layerScope, Exit.void)
    }),
  )
})
