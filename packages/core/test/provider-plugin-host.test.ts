import { expect } from "bun:test"
import type { ProviderHost } from "@opencode-ai/plugin/provider"
import { DateTime, Effect, Layer } from "effect"
import { Catalog } from "../src/catalog"
import { Credential } from "../src/credential"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { Integration } from "../src/integration"
import { Location } from "../src/location"
import { ModelV2 } from "../src/model"
import { Npm } from "../src/npm"
import { PluginV2 } from "../src/plugin"
import { providerRegistration } from "../src/plugin/provider-host"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { location } from "./fixture/location"
import { neutralProvider } from "./fixture/neutral-provider"
import { testEffect } from "./lib/effect"

const credentials = Layer.mock(Credential.Service)({
  all: () => Effect.succeed([]),
  list: () => Effect.succeed([]),
})
const it = testEffect(Catalog.locationLayer.pipe(
  Layer.provideMerge(EventV2.defaultLayer),
  Layer.provideMerge(Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(process.cwd()) }))),
  Layer.provideMerge(credentials),
  Layer.provideMerge(Global.layer),
  Layer.provideMerge(Layer.mock(Npm.Service)({})),
))

it.effect("neutral public provider uses scoped catalog, schemas, credential boundaries and transport hooks", () => Effect.gen(function* () {
  const catalog = yield* Catalog.Service
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  const global = yield* Global.Service
  const npm = yield* Npm.Service
  const plugins = yield* PluginV2.Service
  const state: { api?: ProviderHost; disposed: number } = { disposed: 0 }
  const registration = providerRegistration(neutralProvider((api) => {
    state.api = api
    api.lifecycle.onDispose(() => { state.disposed++ })
  }))
  yield* plugins.add({
    id: registration.id,
    effect: registration.effect.pipe(
      Effect.provideService(Catalog.Service, catalog),
      Effect.provideService(Integration.Service, integrations),
      Effect.provideService(Credential.Service, credentials),
      Effect.provideService(Global.Service, global),
      Effect.provideService(Npm.Service, npm),
    ),
  })
  const api = state.api!
  const model = yield* catalog.model.get(ProviderV2.ID.make("neutral"), ModelV2.ID.make("speech"))
  expect(DateTime.toEpochMillis(model.time.released)).toBe(1234)
  expect(model.capabilities.output).toEqual(["audio"])
  expect((yield* catalog.provider.get(ProviderV2.ID.make("neutral"))).request.headers["X-Neutral"]).toBe("yes")
  const transport = yield* plugins.trigger("aisdk.sdk", { model, package: "neutral-sdk", options: { retry: false } }, {})
  expect(transport.sdk).toEqual({ name: "neutral-sdk", options: { retry: false } })
  expect(() => api.credentials.list("foreign")).toThrow("cannot access integration foreign")
  yield* integrations.update((editor) => editor.update(Integration.ID.make("foreign"), (integration) => {
    integration.name = "Public integration metadata"
  }))
  expect(yield* Effect.promise(() => api.integrations.get("foreign"))).toEqual({
    id: "foreign", name: "Public integration metadata", connections: [],
  })
  expect(() => api.integrations.connection.forIntegration("foreign")).toThrow("cannot access integration foreign")
  expect((yield* Effect.promise(() => api.integrations.get("neutral")))?.id).toBe("neutral")
  expect(() => api.cache.readJSON("../foreign.json")).toThrow("Invalid provider cache name")
  const errors: string[] = []
  const transportFetch = async () => new Response("audio")
  yield* Effect.promise(() => api.catalog.transform((editor) => {
    editor.provider.update("neutral", (provider) => { provider.request.body.fetch = transportFetch })
    const snapshot = editor.provider.get("neutral")!
    expect(snapshot.provider.request.body.fetch).toBe(transportFetch)
    snapshot.provider.name = "Changed outside update"
    expect(editor.provider.get("neutral")!.provider.name).toBe("Neutral")
    try { editor.model.update("neutral", "speech", (model) => { model.providerID = "foreign" }) }
    catch (error) { errors.push(String(error)) }
  }))
  expect(errors[0]).toContain("cannot change identity")
  yield* plugins.remove(registration.id)
  yield* plugins.remove(registration.id)
  expect(state.disposed).toBe(1)
  expect(api.lifecycle.signal.aborted).toBe(true)
  expect((yield* integrations.get(Integration.ID.make("neutral")))).toBeUndefined()
  expect((yield* catalog.provider.all()).some((provider) => provider.id === "neutral")).toBe(false)
  expect(() => api.credentials.list("neutral")).toThrow()
}))
