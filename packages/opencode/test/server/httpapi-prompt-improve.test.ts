import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer } from "./httpapi-layer"
import { AppPluginAssets } from "../../src/plugin/app/assets"

const testStateLayer = Layer.effectDiscard(
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

const it = testEffect(Layer.mergeAll(testStateLayer, httpApiLayer))

function promptImprove(path: string, body: unknown) {
  return HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJson(body), Effect.flatMap(HttpClient.execute))
}

function hostAIRun(path: string, body: unknown) {
  return HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJson(body), Effect.flatMap(HttpClient.execute))
}

function jsonChatServer(output: string | string[]) {
  return Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ url: string; requests: unknown[]; close: () => Promise<void> }>((resolve, reject) => {
          const requests: unknown[] = []
          const outputs = Array.isArray(output) ? output : [output]
          const server = createServer((request, response) => {
            if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
              response.writeHead(404).end()
              return
            }
            const chunks: Buffer[] = []
            request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
            request.on("end", () => {
              requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"))
              const text = outputs[Math.min(requests.length - 1, outputs.length - 1)] ?? ""
              response.writeHead(200, { "content-type": "text/event-stream" })
              response.end(
                [
                  sse({
                    id: "chatcmpl-test",
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: "test-model",
                    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
                  }),
                  sse({
                    id: "chatcmpl-test",
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: "test-model",
                    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                  }),
                  sse({
                    id: "chatcmpl-test",
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: "test-model",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                  }),
                  "data: [DONE]\n\n",
                ].join(""),
              )
            })
          })
          server.once("error", reject)
          server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            if (!address || typeof address === "string") {
              reject(new Error("JSON chat server did not bind to TCP"))
              return
            }
            resolve({
              url: `http://127.0.0.1:${address.port}/v1`,
              requests,
              close: () => new Promise((done) => server.close(() => done())),
            })
          })
        }),
    ),
    (server) => Effect.promise(() => server.close()).pipe(Effect.ignore),
  )
}

function sse(input: unknown) {
  return `data: ${JSON.stringify(input)}\n\n`
}

describe("app host prompt improve", () => {
  it.live("returns timing metrics for text-only plugin AI runs", () =>
    Effect.gen(function* () {
      const llm = yield* jsonChatServer("Rewrite the failing checkout report. Ignore this second sentence.")
      const directory = yield* tmpdirScoped({
        git: true,
        config: () => ({ ...testProviderConfig(llm.url), model: "test/test-model" }),
        init: (dir) =>
          Effect.promise(async () => {
            await mkdir(path.join(dir, ".opencode", "plugins", "test-ai"), { recursive: true })
            await writeFile(
              path.join(dir, ".opencode", "app.jsonc"),
              JSON.stringify({ plugin: ["./plugins/test-ai"] }),
            )
            await writeFile(
              path.join(dir, ".opencode", "plugins", "test-ai", "package.json"),
              JSON.stringify({
                name: "test-ai",
                version: "1.0.0",
                type: "module",
                exports: { "./app": "./index.js" },
                opencode: { app: { capabilities: ["host:ai"], ai: { tools: [] } } },
              }),
            )
            await writeFile(path.join(dir, ".opencode", "plugins", "test-ai", "index.js"), "export default { id: 'test-ai', app() {} }")
          }),
      })
      AppPluginAssets.resetForTesting()
      yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
      const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins.find(
        (item) => item.id === "test-ai",
      )
      expect(plugin).toBeDefined()

      const response = yield* hostAIRun(`/app/host/ai/run?directory=${encodeURIComponent(directory)}`, {
        pluginID: "test-ai",
        pluginVersion: plugin!.version,
        pluginHash: plugin!.hash,
        prompt: "checkout fails",
        model: "test/test-model",
        returnAfter: "sentence",
        tools: [],
        generation: { maxTokens: 64 },
      })

      const body = yield* response.json
      expect({ status: response.status, body }).toMatchObject({
        status: 200,
        body: {
          ok: true,
          text: "Rewrite the failing checkout report.",
          model: "test/test-model",
          timing: {
            totalMs: expect.any(Number),
            parseMs: expect.any(Number),
            policyMs: expect.any(Number),
            instanceMs: expect.any(Number),
            generationMs: expect.any(Number),
          },
        },
      })
      expect(llm.requests).toHaveLength(1)
      expect(llm.requests[0]).not.toHaveProperty("tools")
      // An explicit generation.maxTokens must reach the provider unchanged.
      expect((llm.requests[0] as { max_tokens?: number }).max_tokens).toBe(64)
    }),
    30_000,
  )

  it.live("applies the reasoning-aware default budget when a plugin run omits generation", () =>
    Effect.gen(function* () {
      const llm = yield* jsonChatServer("Report ready.")
      const directory = yield* tmpdirScoped({
        git: true,
        config: () => ({ ...testProviderConfig(llm.url), model: "test/test-model" }),
        init: (dir) =>
          Effect.promise(async () => {
            await mkdir(path.join(dir, ".opencode", "plugins", "test-ai"), { recursive: true })
            await writeFile(
              path.join(dir, ".opencode", "app.jsonc"),
              JSON.stringify({ plugin: ["./plugins/test-ai"] }),
            )
            await writeFile(
              path.join(dir, ".opencode", "plugins", "test-ai", "package.json"),
              JSON.stringify({
                name: "test-ai",
                version: "1.0.0",
                type: "module",
                exports: { "./app": "./index.js" },
                opencode: { app: { capabilities: ["host:ai"], ai: { tools: [] } } },
              }),
            )
            await writeFile(path.join(dir, ".opencode", "plugins", "test-ai", "index.js"), "export default { id: 'test-ai', app() {} }")
          }),
      })
      AppPluginAssets.resetForTesting()
      yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))
      const plugin = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins.find(
        (item) => item.id === "test-ai",
      )
      expect(plugin).toBeDefined()

      const response = yield* hostAIRun(`/app/host/ai/run?directory=${encodeURIComponent(directory)}`, {
        pluginID: "test-ai",
        pluginVersion: plugin!.version,
        pluginHash: plugin!.hash,
        prompt: "summarize the report",
        model: "test/test-model",
      })

      expect({ status: response.status, body: yield* response.json }).toMatchObject({
        status: 200,
        body: { ok: true, text: "Report ready." },
      })
      // Hidden reasoning burns through the output budget, so a plugin run
      // without an explicit budget gets the helper default, not the provider
      // default that reasoning models can exhaust before any visible text.
      expect(llm.requests).toHaveLength(1)
      expect((llm.requests[0] as { max_tokens?: number }).max_tokens).toBe(8192)
    }),
    30_000,
  )

  it.live("authorizes frozen manifests across project directories", () =>
    Effect.gen(function* () {
      const llm = yield* jsonChatServer("Improve the frozen plugin report.")
      const source = yield* tmpdirScoped({
        git: true,
        init: (dir) =>
          Effect.promise(async () => {
            await mkdir(path.join(dir, ".opencode", "plugins", "frozen-ai"), { recursive: true })
            await writeFile(
              path.join(dir, ".opencode", "app.jsonc"),
              JSON.stringify({ plugin: ["./plugins/frozen-ai"] }),
            )
            await writeFile(
              path.join(dir, ".opencode", "plugins", "frozen-ai", "package.json"),
              JSON.stringify({
                name: "frozen-ai",
                version: "1.0.0",
                type: "module",
                exports: { "./app": "./index.js" },
                opencode: { app: { capabilities: ["host:ai"], ai: { tools: [] } } },
              }),
            )
            await writeFile(
              path.join(dir, ".opencode", "plugins", "frozen-ai", "index.js"),
              "export default { id: 'frozen-ai', app() {} }",
            )
          }),
      })
      const target = yield* tmpdirScoped({
        git: true,
        config: () => ({ ...testProviderConfig(llm.url), model: "test/test-model" }),
      })
      AppPluginAssets.resetForTesting()
      yield* Effect.addFinalizer(() => Effect.sync(() => AppPluginAssets.resetForTesting()))

      const manifest = (yield* Effect.promise(() => AppPluginAssets.clientManifest(source))).plugins.find(
        (item) => item.id === "frozen-ai",
      )
      expect(manifest).toBeDefined()

      const missingVersion = yield* hostAIRun(`/app/host/ai/run?directory=${encodeURIComponent(target)}`, {
        pluginID: "frozen-ai",
        prompt: "frozen plugin report",
        model: "test/test-model",
      })
      expect({ status: missingVersion.status, body: yield* missingVersion.json }).toEqual({
        status: 400,
        body: { ok: false, error: "Expected pluginVersion" },
      })

      const missingHash = yield* hostAIRun(`/app/host/ai/run?directory=${encodeURIComponent(target)}`, {
        pluginID: "frozen-ai",
        pluginVersion: manifest!.version,
        prompt: "frozen plugin report",
        model: "test/test-model",
      })
      expect({ status: missingHash.status, body: yield* missingHash.json }).toEqual({
        status: 400,
        body: { ok: false, error: "Expected pluginHash" },
      })

      const rejected = yield* hostAIRun(`/app/host/ai/run?directory=${encodeURIComponent(target)}`, {
        pluginID: "frozen-ai",
        pluginVersion: `${manifest!.version}-unknown`,
        pluginHash: manifest!.hash,
        prompt: "frozen plugin report",
        model: "test/test-model",
      })
      expect({ status: rejected.status, body: yield* rejected.json }).toEqual({
        status: 404,
        body: { ok: false, error: "Unknown app plugin" },
      })
      expect(llm.requests).toHaveLength(0)

      const rejectedHash = yield* hostAIRun(`/app/host/ai/run?directory=${encodeURIComponent(target)}`, {
        pluginID: "frozen-ai",
        pluginVersion: manifest!.version,
        pluginHash: `${manifest!.hash}-unknown`,
        prompt: "frozen plugin report",
        model: "test/test-model",
      })
      expect({ status: rejectedHash.status, body: yield* rejectedHash.json }).toEqual({
        status: 404,
        body: { ok: false, error: "Unknown app plugin" },
      })
      expect(llm.requests).toHaveLength(0)

      const accepted = yield* hostAIRun(`/app/host/ai/run?directory=${encodeURIComponent(target)}`, {
        pluginID: "frozen-ai",
        pluginVersion: manifest!.version,
        pluginHash: manifest!.hash,
        prompt: "frozen plugin report",
        model: "test/test-model",
      })
      expect({ status: accepted.status, body: yield* accepted.json }).toMatchObject({
        status: 200,
        body: {
          ok: true,
          text: "Improve the frozen plugin report.",
          model: "test/test-model",
        },
      })
      expect(llm.requests).toHaveLength(1)
    }),
    30_000,
  )

  it.live("uses the routed directory as InstanceRef when a model is provided", () =>
    Effect.gen(function* () {
      const llm = yield* jsonChatServer("Improve the checkout failure report.")
      const directory = yield* tmpdirScoped({
        git: true,
        config: () => ({ ...testProviderConfig(llm.url), model: "test/test-model" }),
      })

      const response = yield* promptImprove(`/app/host/prompt/improve?directory=${encodeURIComponent(directory)}`, {
        prompt: "checkout fails",
        model: "test/test-model",
        promptTemplate: "Verbessere diesen Prompt auf Deutsch:\n{prompt}\nNur den Prompt zurueckgeben.",
      })

      expect({ status: response.status, body: yield* response.json }).toMatchObject({
        status: 200,
        body: {
          ok: true,
          prompt: "Improve the checkout failure report.",
          model: "test/test-model",
        },
      })
      expect(llm.requests).toHaveLength(1)
      expect(llm.requests[0]).toMatchObject({
        messages: [{ role: "user", content: "Verbessere diesen Prompt auf Deutsch:\ncheckout fails\nNur den Prompt zurueckgeben." }],
      })
    }),
    30_000,
  )

  it.live("cleans common prompt improve model wrappers", () =>
    Effect.gen(function* () {
      const cases = [
        ["json fence", ["```json", JSON.stringify({ prompt: "Improve the checkout failure report." }), "```"].join("\n")],
        ["label prefix", "Improved prompt:\nImprove the checkout failure report."],
        ["preamble label", "Sure.\n\nHere is the improved prompt:\nImprove the checkout failure report."],
        ["json string", JSON.stringify("Improve the checkout failure report.")],
        ["json array", JSON.stringify(["Improve the checkout failure report."])],
      ]
      const llm = yield* jsonChatServer(cases.map(([, output]) => output))
      const directory = yield* tmpdirScoped({
        git: true,
        config: () => ({ ...testProviderConfig(llm.url), model: "test/test-model" }),
      })

      yield* Effect.forEach(
        cases,
        ([name]) =>
          Effect.gen(function* () {
            const response = yield* promptImprove(`/app/host/prompt/improve?directory=${encodeURIComponent(directory)}`, {
              prompt: `checkout fails ${name}`,
              model: "test/test-model",
            })

            expect({ status: response.status, body: yield* response.json }).toMatchObject({
              status: 200,
              body: {
                ok: true,
                prompt: "Improve the checkout failure report.",
                model: "test/test-model",
              },
            })
          }),
        { concurrency: 1 },
      )
      expect(llm.requests).toHaveLength(cases.length)
    }),
    30_000,
  )

  it.live("rejects prompt improve requests without a directory", () =>
    Effect.gen(function* () {
      const response = yield* promptImprove("/app/host/prompt/improve", {
        prompt: "checkout fails",
        model: "test/test-model",
      })

      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ ok: false, error: "Expected directory" })
    }),
  )
})
