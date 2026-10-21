import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionPluginContext } from "@opencode-ai/core/session/plugin-context"
import { Config } from "../../src/config/config"
import { AppPluginAssets } from "../../src/plugin/app/assets"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { markPluginDependenciesReady } from "../fixture/plugin"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

const state = Layer.effectDiscard(Effect.gen(function* () {
  yield* Effect.promise(() => resetDatabase())
  yield* Effect.addFinalizer(() => Effect.promise(async () => { await disposeAllInstances(); await resetDatabase(); AppPluginAssets.resetForTesting() }))
}))
const it = testEffect(Layer.mergeAll(state, httpApiLayer, Config.defaultLayer))

function setup() {
  return Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const config = yield* Config.Service
    const previous = Global.Path.config
    Global.Path.config = directory
    yield* Effect.addFinalizer(() => Effect.gen(function* () { Global.Path.config = previous; yield* config.invalidate() }))
    yield* Effect.promise(async () => {
      const names = ["neutral-alpha", "neutral-beta", "neutral-denied"]
      await Bun.write(path.join(directory, "opencode.json"), JSON.stringify({ plugin: [] }))
      await Bun.write(path.join(directory, ".opencode/app.jsonc"), JSON.stringify({ plugin: names.map((name) => `./plugins/${name}`) }))
      await Promise.all(names.map(async (name) => {
        const folder = path.join(directory, ".opencode/plugins", name)
        await mkdir(folder, { recursive: true })
        await Bun.write(path.join(folder, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", exports: { "./app": "./index.js" }, opencode: { api: { app: 2 }, app: { capabilities: name === "neutral-denied" ? ["host:sessions"] : ["host:session-context"] } } }))
        await Bun.write(path.join(folder, "index.js"), `export default { id: ${JSON.stringify(name)}, app() {} }`)
      }))
      await markPluginDependenciesReady(directory)
      await markPluginDependenciesReady(path.join(directory, ".opencode"))
    })
    yield* config.invalidate()
    AppPluginAssets.resetForTesting()
    const manifest = yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))
    const created = yield* HttpClientRequest.post("/api/session").pipe(HttpClientRequest.bodyJson({ location: { directory } }), Effect.flatMap(HttpClient.execute))
    expect(created.status).toBe(200)
    const parsed = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ id: SessionSchema.ID }) }))(yield* created.json)
    return { directory, plugins: manifest.plugins, sessionID: parsed.data.id }
  })
}

function read(fixture: Effect.Success<ReturnType<typeof setup>>, name: string, overrides: Record<string, unknown> = {}, directory = fixture.directory) {
  const plugin = fixture.plugins.find((item) => item.id === name)
  if (!plugin) throw new Error(`Fixture plugin ${name} missing`)
  return HttpClientRequest.post(`/app/host/session-context?directory=${encodeURIComponent(directory)}`).pipe(
    HttpClientRequest.bodyJson({ caller: { id: name, version: plugin.version, hash: plugin.hash }, sessionID: fixture.sessionID, ...overrides }),
    Effect.flatMap(HttpClient.execute),
  )
}

describe("public plugin session context", () => {
  it.live("serves two unrelated plugin identities with read-only capability and no-store", () => Effect.gen(function* () {
    const fixture = yield* setup()
    for (const name of ["neutral-alpha", "neutral-beta"]) {
      const response = yield* read(fixture, name)
      expect(response.status).toBe(200)
      expect(response.headers["cache-control"]).toBe("no-store")
      const body = Schema.decodeUnknownSync(Schema.Struct({ ok: Schema.Literal(true), context: SessionPluginContext.Info }))(yield* response.json)
      expect(body.context.session.id).toBe(fixture.sessionID)
      expect(body.context.messages).toEqual([])
      expect(body.context.pending.questions).toEqual([])
    }
  }), 60_000)
  it.live("denies missing capability, forged hash, foreign project, unknown session and oversized reads", () => Effect.gen(function* () {
    const fixture = yield* setup()
    expect((yield* read(fixture, "neutral-denied")).status).toBe(403)
    expect((yield* read(fixture, "neutral-alpha", { caller: { id: "neutral-alpha", version: "1.0.0", hash: "forged" } })).status).toBe(403)
    expect((yield* read(fixture, "neutral-alpha", { sessionID: "ses_missing" })).status).toBe(400)
    expect((yield* read(fixture, "neutral-alpha", { limit: 201 })).status).toBe(400)
    expect((yield* read(fixture, "neutral-alpha", { maxTextChars: 48_001 })).status).toBe(400)
    const foreign = yield* tmpdirScoped({ git: true })
    expect((yield* read(fixture, "neutral-alpha", {}, foreign)).status).toBe(403)
  }), 60_000)
})
