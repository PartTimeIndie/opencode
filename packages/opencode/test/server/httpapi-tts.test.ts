import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Global } from "@opencode-ai/core/global"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Config } from "../../src/config/config"
import { AppPluginAssets } from "../../src/plugin/app/assets"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

const stateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await disposeAllInstances()
        await resetDatabase()
        AppPluginAssets.resetForTesting()
      }),
    )
  }),
)
const it = testEffect(Layer.mergeAll(stateLayer, httpApiLayer, Config.defaultLayer))

describe("app host text to speech", () => {
  it.live(
    "skips stale models, recovers a provider 400, and streams MP3 with the serving model voice",
    () =>
      Effect.gen(function* () {
        const requests: Array<Record<string, unknown>> = []
        const upstream = Bun.serve({
          port: 0,
          async fetch(request) {
            if (request.method === "GET") return speechCatalog(request)
            const body = (await request.json()) as Record<string, unknown>
            requests.push(body)
            if (body.model === "mistralai/voxtral-mini-tts-2603")
              return Response.json({ error: "upstream unavailable" }, { status: 400 })
            return new Response(new Uint8Array([73, 68, 51, 1, 2]), { headers: { "content-type": "audio/mpeg" } })
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => upstream.stop(true)))
        const plugin = yield* setup(`${upstream.url}api/v1`)
        const response = yield* request(plugin, {
          voice: "alloy",
          chain: {
            steps: [
              { providerID: "openrouter", modelID: "openai/removed-tts" },
              { providerID: "openrouter", modelID: "mistralai/voxtral-mini-tts-2603" },
              { providerID: "openrouter", modelID: "microsoft/mai-voice-2" },
            ],
          },
        })
        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toBe("audio/mpeg")
        expect(response.headers["x-opencode-tts-format"]).toBe("mp3")
        expect(response.headers["x-opencode-tts-model"]).toBe("openrouter/microsoft/mai-voice-2")
        expect(response.headers["x-opencode-tts-step"]).toBe("2")
        expect(decodeURIComponent(response.headers["x-opencode-tts-voice"]!)).toBe("en-US-Harper:MAI-Voice-2")
        expect([...new Uint8Array(yield* response.arrayBuffer)]).toEqual([73, 68, 51, 1, 2])
        expect(
          requests.map((item) => ({ model: item.model, voice: item.voice, format: item.response_format })),
        ).toEqual([
          { model: "mistralai/voxtral-mini-tts-2603", voice: "en_paul_sad", format: "mp3" },
          { model: "microsoft/mai-voice-2", voice: "en-US-Harper:MAI-Voice-2", format: "mp3" },
        ])
      }),
    20_000,
  )

  it.live("accepts automatic voices and rejects unauthorized plugins before dispatch", () =>
    Effect.gen(function* () {
      const plugin = yield* setup("http://127.0.0.1:1/api/v1", [])
      const response = yield* request(plugin, { model: "openrouter/microsoft/mai-voice-2" })
      expect(response.status).toBe(403)
      expect(yield* response.json).toEqual({ ok: false, error: "Missing host:tts capability" })
    }),
  )

  it.live("advances to the next speech model when the first never starts", () =>
    Effect.gen(function* () {
      const requests: string[] = []
      const upstream = Bun.serve({
        port: 0,
        async fetch(request) {
          if (request.method === "GET") return speechCatalog(request)
          const model = ((await request.json()) as { model: string }).model
          requests.push(model)
          if (model === "mistralai/voxtral-mini-tts-2603") {
            await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }))
            return new Response(null, { status: 503 })
          }
          return new Response(new Uint8Array([73, 68, 51]), { headers: { "content-type": "audio/mpeg" } })
        },
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => upstream.stop(true)))
      const plugin = yield* setup(`${upstream.url}api/v1`)
      const response = yield* request(plugin, { chain: { steps: [
        { providerID: "openrouter", modelID: "mistralai/voxtral-mini-tts-2603" },
        { providerID: "openrouter", modelID: "microsoft/mai-voice-2" },
      ] } })
      expect(response.status).toBe(200)
      expect(response.headers["x-opencode-tts-step"]).toBe("1")
      expect([...new Uint8Array(yield* response.arrayBuffer)]).toEqual([73, 68, 51])
      expect(requests).toEqual(["mistralai/voxtral-mini-tts-2603", "microsoft/mai-voice-2"])
    }), 20_000)

  it.live(
    "does not replay through a fallback after audio bytes have started",
    () =>
      Effect.gen(function* () {
        const requests: string[] = []
        const source = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
        const upstream = Bun.serve({
          port: 0,
          async fetch(request) {
            if (request.method === "GET") return speechCatalog(request)
            requests.push(((await request.json()) as { model: string }).model)
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array([73, 68, 51]))
                  source.resolve(controller)
                },
              }),
              { headers: { "content-type": "audio/mpeg" } },
            )
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => upstream.stop(true)))
        const plugin = yield* setup(`${upstream.url}api/v1`)
        const response = yield* request(plugin, {
          chain: {
            steps: [
              { providerID: "openrouter", modelID: "mistralai/voxtral-mini-tts-2603" },
              { providerID: "openrouter", modelID: "microsoft/mai-voice-2" },
            ],
          },
        })
        expect(response.status).toBe(200)
        ;(yield* Effect.promise(() => source.promise)).error(new Error("upstream stream broke"))
        // Chunked HTTP cannot signal an incomplete body without a length/trailer.
        // Crucially, the host must not append a second model's speech to it.
        expect([...new Uint8Array(yield* response.arrayBuffer)]).toEqual([73, 68, 51])
        expect(requests).toEqual(["mistralai/voxtral-mini-tts-2603"])
      }),
    20_000,
  )
})

function request(plugin: { directory: string; version: string; hash: string }, input: Record<string, unknown>) {
  return HttpClientRequest.post(`/app/host/tts/speech?directory=${encodeURIComponent(plugin.directory)}`).pipe(
    HttpClientRequest.bodyJson({
      pluginID: "test-tts",
      pluginVersion: plugin.version,
      pluginHash: plugin.hash,
      text: "Hallo Welt",
      ...input,
    }),
    Effect.flatMap(HttpClient.execute),
  )
}

function setup(baseURL: string, capabilities = ["host:tts"]) {
  return Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const config = yield* Config.Service
    const previous = Global.Path.config
    ;(Global.Path as { config: string }).config = directory
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        ;(Global.Path as { config: string }).config = previous
        yield* config.invalidate()
      }),
    )
    yield* Effect.promise(async () => {
      await mkdir(path.join(directory, ".opencode/plugins/test-tts"), { recursive: true })
      await Bun.write(path.join(directory, ".opencode/app.jsonc"), JSON.stringify({ plugin: ["./plugins/test-tts"] }))
      await Bun.write(
        path.join(directory, ".opencode/plugins/test-tts/package.json"),
        JSON.stringify({
          name: "test-tts",
          version: "1.0.0",
          type: "module",
          exports: { "./app": "./index.js" },
          opencode: { app: { capabilities } },
        }),
      )
      await Bun.write(
        path.join(directory, ".opencode/plugins/test-tts/index.js"),
        "export default { id: 'test-tts', app() {} }",
      )
      await Bun.write(
        path.join(directory, "opencode.json"),
        JSON.stringify({
          plugin: [new URL("../../../../../opencode-openrouter-media/",import.meta.url).href],
          provider: {
            openrouter: {
              options: { apiKey: "test-only", baseURL },
              models: {
                "mistralai/voxtral-mini-tts-2603": {
                  modalities: { input: ["text"], output: ["speech"] },
                },
                "microsoft/mai-voice-2": {
                  modalities: { input: ["text"], output: ["speech"] },
                },
                "openai/removed-tts": {
                  modalities: { input: ["text"], output: ["speech"] },
                },
              },
            },
          },
        }),
      )
    })
    yield* config.invalidate()
    AppPluginAssets.resetForTesting()
    const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]!
    return { directory, version: plugin.version, hash: plugin.hash }
  })
}

// Installed configuration contains speech placeholders without voice metadata.
// Voices are available only in OpenRouter's purpose-filtered catalogue response.
function speechCatalog(request: Request) {
  expect(new URL(request.url).searchParams.get("output_modalities")).toBe("speech")
  return Response.json({ data: [
    { id: "mistralai/voxtral-mini-tts-2603", name: "Voxtral Mini TTS", supported_voices: ["en_paul_sad", "en_paul_neutral"] },
    { id: "microsoft/mai-voice-2", name: "MAI Voice 2", supported_voices: ["en-US-Harper:MAI-Voice-2", "de-DE-Klaus:MAI-Voice-2"] },
  ] })
}
