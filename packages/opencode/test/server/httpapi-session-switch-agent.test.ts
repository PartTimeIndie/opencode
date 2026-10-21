import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { Workspace } from "../../src/control-plane/workspace"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

// Mirrors the httpapi-session.test.ts assembly (its in-flight scenarios run
// green on this harness, most recently "accepts an explicit v2 resume before
// provider work settles" with ~5.9s of real provider work).
const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(
      InstanceBootstrapService.Service,
      InstanceBootstrapService.Service.of({
        run: InstanceRef.pipe(Effect.asVoid),
      }),
    ),
  ),
)
const workspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(HttpApiApp.routes, {
  disableListenLog: true,
  disableLogger: false,
})
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    workspaceLayer,
    Database.defaultLayer,
    httpApiLayer,
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

const jsonHeaders = (directory: string) => ({ "x-opencode-directory": directory, "content-type": "application/json" })

const createdSession = (headers: Record<string, string>, directory: string) =>
  request("/api/session", {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: "build",
      // The stored selection is the resolved Settings chain: active step
      // test/test-model (variant normalized to default). The switch requests
      // below re-affirm it with the bare active model.
      model: {
        providerID: "test",
        id: "test-model",
        chain: {
          id: "settings-chain",
          name: "Settings chain",
          active: 0,
          steps: [{ providerID: "test", id: "test-model" }],
        },
      },
      location: { directory },
    }),
  }).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map((value) => value as { data: { id: string } }),
  )

const sessionEvents = (forwarded: GlobalEvent[], sessionID: string, type: string) =>
  forwarded.filter(
    (event) =>
      event.payload.type === type &&
      (event.payload.properties as { sessionID?: string } | undefined)?.sessionID === sessionID,
  )

const inFlightSession = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const gate = Promise.withResolvers<void>()
  yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
  yield* llm.hold("held response", gate.promise)

  const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
  const headers = jsonHeaders(directory)
  const created = yield* createdSession(headers, directory)

  const forwarded: GlobalEvent[] = []
  const listener = (event: GlobalEvent) => forwarded.push(event)
  GlobalBus.on("event", listener)
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

  const prompted = yield* request(`/api/session/${created.data.id}/prompt`, {
    method: "POST",
    headers,
    // Normal prompt: the runner auto-resumes, so provider work actually starts
    // (a resume:false prompt alone never reaches the provider).
    body: JSON.stringify({ prompt: { text: "held turn" } }),
  })
  expect(prompted.status).toBe(200)
  // Real provider gate BEFORE the switch: the run is provably inside provider work.
  yield* llm.wait(1)

  return { llm, gate, created, forwarded, headers }
})

describe("POST /api/session/:id/agent against a live provider turn", () => {
  it.live(
    "re-affirming the stored settings chain with the bare active model does not abort provider work",
    () =>
      Effect.gen(function* () {
        const { llm, gate, created, forwarded, headers } = yield* inFlightSession
        // Provider turn turns only: title generation fires as its own request.
        const turnCalls = () =>
          Effect.map(llm.inputs, (bodies) => bodies.filter((body) => !JSON.stringify(body).includes("Generate a title")).length)
        const callsBefore = yield* turnCalls()

        const reaffirmed = yield* request(`/api/session/${created.data.id}/agent`, {
          method: "POST",
          headers,
          body: JSON.stringify({ agent: "build", model: { providerID: "test", id: "test-model" } }),
        })
        expect([reaffirmed.status, yield* reaffirmed.text]).toEqual([204, ""])

        // No interrupt, no hold, and the provider never saw a second request.
        expect(sessionEvents(forwarded, created.data.id, "session.next.prompt.held")).toEqual([])
        expect(sessionEvents(forwarded, created.data.id, "session.next.agent.switched")).toEqual([])
        expect(yield* turnCalls()).toBe(callsBefore)

        gate.resolve()
        expect((yield* request(`/api/session/${created.data.id}/wait`, { method: "POST", headers })).status).toBe(204)
        expect(yield* turnCalls()).toBe(callsBefore)
        expect(sessionEvents(forwarded, created.data.id, "session.next.agent.switched")).toEqual([])
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    20_000,
  )

  it.live(
    "switching to a different agent interrupts the live turn and answers with the declared contract",
    () =>
      Effect.gen(function* () {
        const { llm, gate, created, forwarded, headers } = yield* inFlightSession

        const switched = yield* request(`/api/session/${created.data.id}/agent`, {
          method: "POST",
          headers,
          body: JSON.stringify({ agent: "plan" }),
        })
        // Declared contract: 204 No Content. Any failure must carry a
        // structured body, never the historical empty 503.
        expect(switched.status).toBe(204)
        expect(yield* switched.text).toBe("")

        const switches = sessionEvents(forwarded, created.data.id, "session.next.agent.switched")
        expect(switches.length).toBe(1)
        expect((switches[0]?.payload.properties as { agent?: string } | undefined)?.agent).toBe("plan")

        gate.resolve()
        expect((yield* request(`/api/session/${created.data.id}/wait`, { method: "POST", headers })).status).toBe(204)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    20_000,
  )
})
