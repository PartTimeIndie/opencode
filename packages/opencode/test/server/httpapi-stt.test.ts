import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"
import { AppPluginAssets } from "../../src/plugin/app/assets"
import { Global } from "@opencode-ai/core/global"
import { mediaRegistry } from "../../src/plugin/media"

const stateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await disposeAllInstances()
        await resetDatabase()
      }),
    )
  }),
)

const it = testEffect(Layer.mergeAll(stateLayer, httpApiLayer))

describe("app host speech transcription", () => {
  it.live("rejects plugins without host:stt before provider dispatch", () =>
    Effect.gen(function* () {
      const directory = yield* pluginDirectory([])
      AppPluginAssets.resetForTesting()
      yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
      const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]
      expect(plugin).toBeDefined()

      const response = yield* request(directory, plugin!.version, plugin!.hash)
      expect(response.status).toBe(403)
      expect(response.headers["cache-control"]).toBe("no-store")
      expect(yield* response.json).toEqual({ ok: false, error: "Missing host:stt capability" })
    }),
  )

  it.live("rejects an unknown frozen plugin hash", () =>
    Effect.gen(function* () {
      const directory = yield* pluginDirectory(["host:stt"])
      AppPluginAssets.resetForTesting()
      yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
      const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]
      expect(plugin).toBeDefined()

      const response = yield* request(directory, plugin!.version, `${plugin!.hash}-invalid`)
      expect(response.status).toBe(404)
      expect(response.headers["cache-control"]).toBe("no-store")
      expect(yield* response.json).toEqual({ ok: false, error: "Unknown app plugin" })
    }),
  )

  it.live("rejects unsupported audio before provider dispatch", () =>
    Effect.gen(function* () {
      const directory = yield* pluginDirectory(["host:stt"])
      AppPluginAssets.resetForTesting()
      yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
      const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]
      expect(plugin).toBeDefined()

      const response = yield* request(directory, plugin!.version, plugin!.hash, "text/plain")
      expect(response.status).toBe(415)
      expect(response.headers["cache-control"]).toBe("no-store")
      expect(yield* response.json).toEqual({ ok: false, error: "Unsupported audio type text/plain" })
    }),
  )

  it.live("admits global dictation models in the resolved adapter scope", () =>
    Effect.gen(function* () {
      const directory = yield* pluginDirectory(["host:stt"])
      AppPluginAssets.resetForTesting()
      yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
      const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]!
      const authentication = yield* HttpClientRequest.put("/auth/openrouter").pipe(
        HttpClientRequest.bodyJson({ type: "api", key: "isolated-global-stt-key" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(authentication.status).toBe(200)
      yield* Effect.addFinalizer(() => HttpClientRequest.delete("/auth/openrouter").pipe(HttpClient.execute, Effect.orDie, Effect.asVoid))
      const dispatched: string[] = []
      const release = mediaRegistry.register(path.join(Global.Path.data, "desktop-global"), {
        providerID: "openrouter",
        transcription: {
          supports: (modelID) => modelID === "openai/gpt-4o-mini-transcribe",
          transcribe: async (input) => {
            dispatched.push(input.modelID)
            return { providerID: input.provider.id, modelID: input.modelID, text: "Global dictation works." }
          },
        },
      })
      yield* Effect.addFinalizer(() => Effect.sync(release))

      const response = yield* requestJson("global", plugin.version, plugin.hash, "openrouter/openai/gpt-4o-mini-transcribe")
      expect({ status: response.status, body: yield* response.json }).toEqual({
        status: 200,
        body: { ok: true, text: "Global dictation works.", providerID: "openrouter", modelID: "openai/gpt-4o-mini-transcribe" },
      })
      const unsupported = yield* requestJson("global", plugin.version, plugin.hash, "openrouter/openai/gpt-audio")
      expect(unsupported.status).toBe(400)
      expect(dispatched).toEqual(["openai/gpt-4o-mini-transcribe"])
    }),
    20_000,
  )

  it.live(
    "uses a lightweight global provider for transcription",
    () =>
      Effect.gen(function* () {
        const requests: Array<{ pathname: string; body: Record<string, unknown> }> = []
        const server = Bun.serve({
          port: 0,
          async fetch(request) {
            requests.push({
              pathname: new URL(request.url).pathname,
              body: (await request.json()) as Record<string, unknown>,
            })
            return Response.json({ text: "Transcribed through the host route." })
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
        const directory = yield* pluginDirectory(["host:stt"])
        const previousKey = process.env["OPENROUTER_API_KEY"]
        process.env["OPENROUTER_API_KEY"] = "server-secret"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousKey === undefined) delete process.env["OPENROUTER_API_KEY"]
            else process.env["OPENROUTER_API_KEY"] = previousKey
          }),
        )
        const originalFetch = globalThis.fetch
        globalThis.fetch = ((input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
          if (!url.endsWith("/api/v1/audio/transcriptions")) return originalFetch(input, init)
          return originalFetch(new URL("api/v1/audio/transcriptions", server.url), init)
        }) as typeof fetch
        yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = originalFetch)))
        AppPluginAssets.resetForTesting()
        yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
        const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]
        expect(plugin).toBeDefined()

        const response = yield* request(directory, plugin!.version, plugin!.hash)
        expect({ status: response.status, body: yield* response.json }).toEqual({
          status: 200,
          body: {
            ok: true,
            text: "Transcribed through the host route.",
            providerID: "openrouter",
            modelID: "qwen/qwen3-asr-flash-2026-02-10",
          },
        })
        expect(requests).toEqual([
          {
            pathname: "/api/v1/audio/transcriptions",
            body: {
              model: "qwen/qwen3-asr-flash-2026-02-10",
              input_audio: { data: "AQID", format: "webm" },
            },
          },
        ])
        // Structured diagnostics must stay free of request content: the sent
        // audio payload, the configured credential, and the resulting
        // transcript may never appear in attempt or job events.
        const diagnostics = diagnosticLines(yield* TestConsole.logLines)
        const serialized = diagnostics.join("\n")
        expect(serialized).toContain('"event":"stt_attempt"')
        expect(serialized).toContain('"outcome":"succeeded"')
        expect(serialized).toContain('"event":"stt_job"')
        expect(serialized).not.toContain("AQID")
        expect(serialized).not.toContain("server-secret")
        expect(serialized).not.toContain("Transcribed through the host route.")
        expect(new Set(correlationIDs(diagnostics)).size).toBe(1)
      }),
    20_000,
  )

  it.live(
    "reports invalid project plugin configuration before transcription",
    () =>
      Effect.gen(function* () {
        const server = Bun.serve({
          port: 0,
          fetch() {
            return Response.json({ text: "Transcribed without project bootstrap." })
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
        const directory = yield* pluginDirectory(["host:stt"], `${server.url}api/v1`)
        yield* Effect.promise(() => writeFile(path.join(directory, "opencode.json"), "{"))
        const previousKey = process.env["OPENROUTER_API_KEY"]
        process.env["OPENROUTER_API_KEY"] = "server-secret"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousKey === undefined) delete process.env["OPENROUTER_API_KEY"]
            else process.env["OPENROUTER_API_KEY"] = previousKey
          }),
        )
        const originalFetch = globalThis.fetch
        globalThis.fetch = ((input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
          if (!url.endsWith("/api/v1/audio/transcriptions")) return originalFetch(input, init)
          return originalFetch(new URL("api/v1/audio/transcriptions", server.url), init)
        }) as typeof fetch
        yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = originalFetch)))
        AppPluginAssets.resetForTesting()
        yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
        const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]
        expect(plugin).toBeDefined()

        const response = yield* requestJson(directory, plugin!.version, plugin!.hash)
        expect(response.status).toBe(400)
        expect(yield* response.json).toMatchObject({name:"ConfigJsonError",data:{path:path.join(directory,"opencode.json")}})
      }),
    20_000,
  )

  it.live(
    "transcribes through a dedicated chain and reports the serving provider",
    () =>
      Effect.gen(function* () {
        const server = Bun.serve({
          port: 0,
          fetch() {
            return Response.json({ text: "Chained transcription." })
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
        const directory = yield* pluginDirectory(["host:stt"])
        const previousKey = process.env["OPENROUTER_API_KEY"]
        process.env["OPENROUTER_API_KEY"] = "server-secret"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousKey === undefined) delete process.env["OPENROUTER_API_KEY"]
            else process.env["OPENROUTER_API_KEY"] = previousKey
          }),
        )
        const originalFetch = globalThis.fetch
        globalThis.fetch = ((input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
          if (!url.endsWith("/api/v1/audio/transcriptions")) return originalFetch(input, init)
          return originalFetch(new URL("api/v1/audio/transcriptions", server.url), init)
        }) as typeof fetch
        yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = originalFetch)))
        AppPluginAssets.resetForTesting()
        yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
        const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]
        expect(plugin).toBeDefined()

        const response = yield* requestJson(directory, plugin!.version, plugin!.hash, undefined, {
          steps: [
            { providerID: "github-copilot", modelID: "cluster" },
            { providerID: "openrouter", modelID: "qwen/qwen3-asr-flash-2026-02-10" },
          ],
        })
        expect({ status: response.status, body: yield* response.json }).toEqual({
          status: 200,
          body: {
            ok: true,
            text: "Chained transcription.",
            providerID: "openrouter",
            modelID: "qwen/qwen3-asr-flash-2026-02-10",
          },
        })
      }),
    20_000,
  )

  it.live(
    "surfaces exhausted OpenRouter credits after one attempt per transcription chain step",
    () =>
      Effect.gen(function* () {
        const models: string[] = []
        const server = Bun.serve({
          port: 0,
          async fetch(request) {
            const body = (await request.json()) as { model?: string }
            if (body.model) models.push(body.model)
            return Response.json({ error: { message: "Insufficient credits" } }, { status: 402 })
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
        const directory = yield* pluginDirectory(["host:stt"])
        const previousKey = process.env["OPENROUTER_API_KEY"]
        process.env["OPENROUTER_API_KEY"] = "server-secret"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousKey === undefined) delete process.env["OPENROUTER_API_KEY"]
            else process.env["OPENROUTER_API_KEY"] = previousKey
          }),
        )
        const originalFetch = globalThis.fetch
        globalThis.fetch = ((input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
          if (!url.endsWith("/api/v1/audio/transcriptions")) return originalFetch(input, init)
          return originalFetch(new URL("api/v1/audio/transcriptions", server.url), init)
        }) as typeof fetch
        yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = originalFetch)))
        AppPluginAssets.resetForTesting()
        yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
        const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]
        expect(plugin).toBeDefined()

        const response = yield* requestJson(directory, plugin!.version, plugin!.hash, undefined, {
          steps: [
            { providerID: "openrouter", modelID: "qwen/qwen3-asr-0.6b" },
            { providerID: "openrouter", modelID: "qwen/qwen3-asr-1.7b" },
            { providerID: "openrouter", modelID: "mistralai/voxtral-small-24b-2507-stt" },
          ],
        })

        expect({ status: response.status, body: yield* response.json }).toEqual({
          status: 502,
          body: {
            ok: false,
            error:
              "OpenRouter rejected transcription because the account has insufficient credits. Add OpenRouter credits or choose a transcription model from another connected provider.",
          },
        })
        expect(models).toEqual(["qwen/qwen3-asr-0.6b", "qwen/qwen3-asr-1.7b", "mistralai/voxtral-small-24b-2507-stt"])
      }),
    20_000,
  )

  it.live(
    "reaches the fallback before the client deadline when the first transcription stalls",
    () =>
      Effect.gen(function* () {
        const models: string[] = []
        const server = Bun.serve({
          port: 0,
          idleTimeout: 120,
          async fetch(request) {
            const body = (await request.json()) as { model: string }
            models.push(body.model)
            if (models.length === 1) return new Promise<Response>(() => {})
            return Response.json({ text: "Recovered through the configured fallback." })
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
        const directory = yield* pluginDirectory(["host:stt"])
        const previousKey = process.env["OPENROUTER_API_KEY"]
        process.env["OPENROUTER_API_KEY"] = "server-secret"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousKey === undefined) delete process.env["OPENROUTER_API_KEY"]
            else process.env["OPENROUTER_API_KEY"] = previousKey
          }),
        )
        const originalFetch = globalThis.fetch
        const signals: Array<AbortSignal | null | undefined> = []
        globalThis.fetch = ((input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
          if (!url.endsWith("/api/v1/audio/transcriptions")) return originalFetch(input, init)
          signals.push(init?.signal)
          return originalFetch(new URL("api/v1/audio/transcriptions", server.url), init)
        }) as typeof fetch
        yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = originalFetch)))
        AppPluginAssets.resetForTesting()
        yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
        const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]!
        const started = Date.now()
        const response = yield* requestJson(directory, plugin.version, plugin.hash, undefined, {
          steps: [
            { providerID: "openrouter", modelID: "qwen/qwen3-asr-0.6b" },
            { providerID: "openrouter", modelID: "qwen/qwen3-asr-1.7b" },
          ],
        })
        expect({ status: response.status, body: yield* response.json }).toEqual({
          status: 200,
          body: {
            ok: true,
            text: "Recovered through the configured fallback.",
            providerID: "openrouter",
            modelID: "qwen/qwen3-asr-1.7b",
          },
        })
        expect(models).toEqual(["qwen/qwen3-asr-0.6b", "qwen/qwen3-asr-1.7b"])
        expect(signals[0]?.aborted).toBe(true)
        expect(Date.now() - started).toBeLessThan(65_000)
        // The stall is a provider timeout that must be visible as a fallback
        // transition; the second attempt serves the job.
        const diagnostics = diagnosticLines(yield* TestConsole.logLines)
        expect(
          diagnostics.some((line) => line.includes('"outcome":"fallback"') && line.includes('"errorCode":"timeout"')),
        ).toBe(true)
        expect(diagnostics.some((line) => line.includes('"outcome":"succeeded"'))).toBe(true)
        expect(diagnostics.some((line) => line.includes('"event":"stt_job"') && line.includes('"outcome":"succeeded"'))).toBe(
          true,
        )
        expect(new Set(correlationIDs(diagnostics)).size).toBe(1)
      }),
    75_000,
  )

  it.live(
    "marks the job aborted when the client cancels mid-transcription",
    () =>
      Effect.gen(function* () {
        const server = Bun.serve({
          port: 0,
          fetch() {
            return new Promise<Response>(() => {})
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
        const directory = yield* pluginDirectory(["host:stt"], `${server.url}api/v1`)
        const previousKey = process.env["OPENROUTER_API_KEY"]
        process.env["OPENROUTER_API_KEY"] = "server-secret"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousKey === undefined) delete process.env["OPENROUTER_API_KEY"]
            else process.env["OPENROUTER_API_KEY"] = previousKey
          }),
        )
        const originalFetch = globalThis.fetch
        let resolveUpstream: () => void
        const upstreamReached = new Promise<void>((resolve) => {
          resolveUpstream = resolve
        })
        globalThis.fetch = ((input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
          if (!url.endsWith("/api/v1/audio/transcriptions")) return originalFetch(input, init)
          resolveUpstream()
          return originalFetch(new URL("api/v1/audio/transcriptions", server.url), init)
        }) as typeof fetch
        yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = originalFetch)))
        AppPluginAssets.resetForTesting()
        yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
        const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]!

        const requestFiber = yield* requestJson(directory, plugin.version, plugin.hash, undefined, {
          steps: [
            { providerID: "openrouter", modelID: "qwen/qwen3-asr-0.6b" },
            { providerID: "openrouter", modelID: "qwen/qwen3-asr-1.7b" },
          ],
        }).pipe(Effect.forkChild)
        // Cancel only once the route is provably stalled inside the first
        // provider attempt: exactly how an aborted plugin request behaves.
        yield* Effect.promise(() => upstreamReached)
        yield* Effect.sleep("150 millis")
        yield* Fiber.interrupt(requestFiber)
        // The client disconnect must reach the route: the in-flight attempt is
        // cancelled and the job ends aborted, not as a chain failure.
        let jobLine: string | undefined
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline && !jobLine) {
          jobLine = diagnosticLines(yield* TestConsole.logLines).find((line) => line.includes('"event":"stt_job"'))
          if (!jobLine) yield* Effect.sleep("200 millis")
        }
        expect(jobLine).toBeDefined()
        expect(jobLine).toContain('"outcome":"aborted"')
        expect(jobLine).toContain('"errorCode":"cancelled"')
      }),
    30_000,
  )

  it.live(
    "parses a JSON-encoded chain field from multipart forms",
    () =>
      Effect.gen(function* () {
        const server = Bun.serve({
          port: 0,
          fetch() {
            return Response.json({ text: "Multipart chained transcription." })
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
        const directory = yield* pluginDirectory(["host:stt"])
        const previousKey = process.env["OPENROUTER_API_KEY"]
        process.env["OPENROUTER_API_KEY"] = "server-secret"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousKey === undefined) delete process.env["OPENROUTER_API_KEY"]
            else process.env["OPENROUTER_API_KEY"] = previousKey
          }),
        )
        const originalFetch = globalThis.fetch
        globalThis.fetch = ((input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
          if (!url.endsWith("/api/v1/audio/transcriptions")) return originalFetch(input, init)
          return originalFetch(new URL("api/v1/audio/transcriptions", server.url), init)
        }) as typeof fetch
        yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = originalFetch)))
        AppPluginAssets.resetForTesting()
        yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
        const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]
        expect(plugin).toBeDefined()

        const response = yield* request(directory, plugin!.version, plugin!.hash, "audio/webm", "", {
          steps: [
            { providerID: "chain-stt-first", modelID: "model" },
            { providerID: "openrouter", modelID: "qwen/qwen3-asr-flash-2026-02-10" },
          ],
        })
        expect({ status: response.status, body: yield* response.json }).toEqual({
          status: 200,
          body: {
            ok: true,
            text: "Multipart chained transcription.",
            providerID: "openrouter",
            modelID: "qwen/qwen3-asr-flash-2026-02-10",
          },
        })
      }),
    20_000,
  )

  it.live("rejects invalid chains and model-chain conflicts", () =>
    Effect.gen(function* () {
      const directory = yield* pluginDirectory(["host:stt"])
      AppPluginAssets.resetForTesting()
      yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
      const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]
      expect(plugin).toBeDefined()

      const empty = yield* requestJson(directory, plugin!.version, plugin!.hash, undefined, { steps: [] })
      expect({ status: empty.status, body: yield* empty.json }).toEqual({
        status: 400,
        body: { ok: false, error: "Invalid model chain: chain must contain at least one step" },
      })

      const both = yield* Effect.succeed(
        HttpClientRequest.post(`/app/host/stt/transcribe?directory=${encodeURIComponent(directory)}`),
      ).pipe(
        Effect.flatMap(
          HttpClientRequest.bodyJson({
            pluginID: "test-stt",
            pluginVersion: plugin!.version,
            pluginHash: plugin!.hash,
            model: "openrouter/qwen/qwen3-asr-flash-2026-02-10",
            mimeType: "audio/webm",
            audio: Buffer.from([1, 2, 3]).toString("base64"),
            chain: { steps: [{ providerID: "openrouter", modelID: "qwen/qwen3-asr-flash-2026-02-10" }] },
          }),
        ),
        Effect.flatMap(HttpClient.execute),
      )
      expect({ status: both.status, body: yield* both.json }).toEqual({
        status: 400,
        body: { ok: false, error: "Expected either model or chain, not both" },
      })
    }),
  )

  it.live("advances through unsupported chain steps and reports the last failure", () =>
    Effect.gen(function* () {
      const directory = yield* pluginDirectory(["host:stt"])
      AppPluginAssets.resetForTesting()
      yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
      const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]
      expect(plugin).toBeDefined()

      const response = yield* requestJson(directory, plugin!.version, plugin!.hash, undefined, {
        steps: [
          { providerID: "chain-stt-first", modelID: "model" },
          { providerID: "chain-stt-second", modelID: "model" },
        ],
      })
      expect({ status: response.status, body: yield* response.json }).toEqual({
        status: 400,
        body: { ok: false, error: "Unknown transcription model chain-stt-second/model" },
      })
    }),
  )

  it.live("exhausts invalid general-audio OpenRouter models without provider dispatch", () =>
    Effect.gen(function* () {
      const directory = yield* pluginDirectory(["host:stt"])
      AppPluginAssets.resetForTesting()
      yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
      const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]
      expect(plugin).toBeDefined()

      const response = yield* requestJson(directory, plugin!.version, plugin!.hash, undefined, {
        steps: [
          { providerID: "openrouter", modelID: "openai/gpt-audio" },
          { providerID: "openrouter", modelID: "openai/gpt-audio-mini" },
        ],
      })
      expect({ status: response.status, body: yield* response.json }).toEqual({
        status: 400,
        body: {
          ok: false,
          error: "Unknown transcription model openrouter/openai/gpt-audio-mini",
        },
      })
    }),
    30_000,
  )
})

function diagnosticLines(lines: ReadonlyArray<unknown>) {
  return lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .filter((line) => line.includes('"event":"stt_attempt"') || line.includes('"event":"stt_job"'))
}

function correlationIDs(lines: ReadonlyArray<string>) {
  return lines.flatMap((line) => [...line.matchAll(/"correlationID":"([0-9a-f-]{36})"/g)].map((match) => match[1]!))
}

function request(
  directory: string,
  version: string,
  hash: string,
  mimeType = "audio/webm",
  model = "openrouter/qwen/qwen3-asr-flash-2026-02-10",
  chain?: { steps: Array<{ providerID: string; modelID: string }> },
) {
  const form = new FormData()
  form.set("pluginID", "test-stt")
  form.set("pluginVersion", version)
  form.set("pluginHash", hash)
  if (model) form.set("model", model)
  if (chain) form.set("chain", JSON.stringify(chain))
  form.set("audio", new File([new Uint8Array([1, 2, 3])], "recording.webm", { type: mimeType }))
  return Effect.succeed(
    HttpClientRequest.post(`/app/host/stt/transcribe?directory=${encodeURIComponent(directory)}`).pipe(
      HttpClientRequest.bodyFormData(form),
    ),
  ).pipe(Effect.flatMap(HttpClient.execute))
}

function requestJson(
  directory: string,
  version: string,
  hash: string,
  model?: string,
  chain?: { steps: Array<{ providerID: string; modelID: string }> },
) {
  return Effect.succeed(
    HttpClientRequest.post(`/app/host/stt/transcribe?directory=${encodeURIComponent(directory)}`),
  ).pipe(
    Effect.flatMap(
      HttpClientRequest.bodyJson({
        pluginID: "test-stt",
        pluginVersion: version,
        pluginHash: hash,
        model: chain ? undefined : (model ?? "openrouter/qwen/qwen3-asr-flash-2026-02-10"),
        mimeType: "audio/webm",
        audio: Buffer.from([1, 2, 3]).toString("base64"),
        ...(chain ? { chain } : {}),
      }),
    ),
    Effect.flatMap(HttpClient.execute),
  )
}

function pluginDirectory(capabilities: string[], baseURL?: string) {
  return tmpdirScoped({
    git: true,
    init: (directory) =>
      Effect.promise(async () => {
        await mkdir(path.join(directory, ".opencode", "plugins", "test-stt"), { recursive: true })
        await writeFile(path.join(directory,".opencode","opencode.json"),JSON.stringify({
          plugin:[new URL("../../../../../opencode-openrouter-media/",import.meta.url).href],
          provider:{openrouter:{env:["OPENROUTER_API_KEY"]}},
        }))
        await writeFile(
          path.join(directory, ".opencode", "app.jsonc"),
          JSON.stringify({ plugin: ["./plugins/test-stt"] }),
        )
        if (baseURL)
          await writeFile(
            path.join(directory, "opencode.json"),
            JSON.stringify({ provider: { openrouter: { options: { apiKey: "server-secret", baseURL } } } }),
          )
        await writeFile(
          path.join(directory, ".opencode", "plugins", "test-stt", "package.json"),
          JSON.stringify({
            name: "test-stt",
            version: "1.0.0",
            type: "module",
            exports: { "./app": "./index.js" },
            opencode: { app: { capabilities } },
          }),
        )
        await writeFile(
          path.join(directory, ".opencode", "plugins", "test-stt", "index.js"),
          "export default { id: 'test-stt', app() {} }",
        )
      }),
  })
}
