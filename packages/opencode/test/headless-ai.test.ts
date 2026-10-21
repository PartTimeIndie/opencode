import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { createServer } from "node:http"

const { ModelV2 } = await import("@opencode-ai/core/model")
const { ProviderV2 } = await import("@opencode-ai/core/provider")
const { createOpenAI } = await import("@ai-sdk/openai")
const { Schema } = await import("effect")
const { HeadlessAI } = await import("../src/headless-ai")
const { ProviderTransform } = await import("../src/provider/transform")
const { default: compatibility } = await import("../../provider-plugins/request-compatibility/src/index")
const { ProviderTest } = await import("./fake/provider")
const { testEffect } = await import("./lib/effect")

let openAIBaseURL = "http://127.0.0.1:1/v1"

const provider = ProviderTest.fake({
  model: ProviderTransform.bindModel(
    ProviderTest.model({
      id: ModelV2.ID.make("gpt-5.5"),
      providerID: ProviderV2.ID.make("openai"),
      api: { id: "gpt-5.5", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
      release_date: "2026-04-23",
    }),
    [compatibility],
  ),
  getLanguage: Effect.fn("TestProvider.getLanguage")(() =>
    Effect.succeed(createOpenAI({ apiKey: "test-key", baseURL: openAIBaseURL }).responses("gpt-5.5")),
  ),
})

const it = testEffect(HeadlessAI.layer.pipe(Layer.provide(provider.layer)))

const goProvider = ProviderTest.fake({
  model: ProviderTest.model({
    id: ModelV2.ID.make("muse-spark-1.3-contributor"),
    providerID: ProviderV2.ID.make("opencode-go"),
    api: { id: "muse-spark-1.3-contributor", url: "https://opencode.ai/zen/v1", npm: "@ai-sdk/openai" },
  }),
  getLanguage: Effect.fn("TestProvider.getLanguage")(() =>
    Effect.succeed(createOpenAI({ apiKey: "test-key", baseURL: openAIBaseURL }).responses("muse-spark-1.3-contributor")),
  ),
})

const goIt = testEffect(HeadlessAI.layer.pipe(Layer.provide(goProvider.layer)))

function openAIResponsesServer(output: string, failure?: string, options: { statusCode?: number; incomplete?: boolean } = {}) {
  return Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ url: string; requests: Record<string, unknown>[]; headers: Record<string, string | string[] | undefined>[]; close: () => Promise<void> }>((resolve, reject) => {
          const requests: Record<string, unknown>[] = []
          const headers: Record<string, string | string[] | undefined>[] = []
          const server = createServer((request, response) => {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end()
              return
            }
            const chunks: Buffer[] = []
            request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
            request.on("end", () => {
              requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"))
              headers.push(request.headers)
              if (failure) {
                response.writeHead(options.statusCode ?? 400, { "content-type": "application/json" })
                response.end(JSON.stringify({ error: { message: failure, type: options.statusCode === 503 ? "server_error" : "invalid_request_error" } }))
                return
              }
              response.writeHead(200, { "content-type": "text/event-stream" })
              response.end(
                [
                  sse({
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { type: "message", id: "msg_test" },
                  }),
                  sse({ type: "response.output_text.delta", item_id: "msg_test", delta: output }),
                  sse({
                    type: "response.output_item.done",
                    output_index: 0,
                    item: { type: "message", id: "msg_test" },
                  }),
                  sse({
                    type: options.incomplete ? "response.incomplete" : "response.completed",
                    response: {
                      id: "resp_test",
                      ...(options.incomplete ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } : {}),
                      usage: {
                        input_tokens: 1,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens: 1,
                        output_tokens_details: { reasoning_tokens: 0 },
                      },
                    },
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
              reject(new Error("OpenAI responses server did not bind to TCP"))
              return
            }
            resolve({
              url: `http://127.0.0.1:${address.port}/v1`,
              requests,
              headers,
              close: () => new Promise((done) => server.close(() => done())),
            })
          })
        }),
    ),
    (server) => Effect.promise(() => server.close()).pipe(Effect.ignore),
  )
}

function sse(input: unknown) {
  return `event: ${(input as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(input)}\n\n`
}

describe("HeadlessAI", () => {
  goIt.live("does not hide SDK retries inside a text or object chain step on backend overload", () =>
    Effect.gen(function* () {
      const server = yield* openAIResponsesServer("", "The backend is temporarily overloaded. Please retry.", { statusCode: 503 })
      openAIBaseURL = server.url
      const headless = yield* HeadlessAI.Service
      const chain = [{ providerID: "opencode-go", modelID: "muse-spark-1.3-contributor" }]
      const messages = [{ role: "user" as const, content: "Rewrite this prompt" }]
      const textError = yield* headless.text({ chain, messages }).pipe(Effect.flip)
      expect(textError.message).toContain("overloaded")
      expect(server.requests).toHaveLength(1)
      const Result = Schema.Struct({ result: Schema.String })
      const objectError = yield* headless.object({
        chain,
        messages,
        schema: Object.assign(Schema.toStandardSchemaV1(Result), Schema.toStandardJSONSchemaV1(Result)),
      }).pipe(Effect.flip)
      expect(objectError.message).toContain("overloaded")
      expect(server.requests).toHaveLength(2)
    }),
  )

  goIt.live("preserves explicit SDK retry settings for text and object chain steps", () =>
    Effect.gen(function* () {
      const server = yield* openAIResponsesServer("", "The backend is temporarily overloaded. Please retry.", { statusCode: 503 })
      openAIBaseURL = server.url
      const headless = yield* HeadlessAI.Service
      const chain = [{ providerID: "opencode-go", modelID: "muse-spark-1.3-contributor" }]
      const messages = [{ role: "user" as const, content: "Rewrite this prompt" }]
      yield* headless.text({ chain, messages, maxRetries: 1 }).pipe(Effect.flip)
      expect(server.requests).toHaveLength(2)
      const Result = Schema.Struct({ result: Schema.String })
      yield* headless.object({
        chain,
        messages,
        maxRetries: 1,
        schema: Object.assign(Schema.toStandardSchemaV1(Result), Schema.toStandardJSONSchemaV1(Result)),
      }).pipe(Effect.flip)
      expect(server.requests).toHaveLength(4)
    }),
  )

  goIt.live("rejects reasoning-only and partial rewrites when the output token budget is exhausted", () =>
    Effect.gen(function* () {
      const headless = yield* HeadlessAI.Service
      for (const output of ["", "Partial rewritten prompt"]) {
        const server = yield* openAIResponsesServer(output, undefined, { incomplete: true })
        openAIBaseURL = server.url
        const error = yield* headless.text({
          model: "opencode-go/muse-spark-1.3-contributor",
          messages: [{ role: "user", content: "Rewrite this prompt" }],
          generation: { maxTokens: 1024 },
          maxRetries: 0,
        }).pipe(Effect.flip)
        expect(error.message).toContain("output token budget exhausted")
        expect(error.message).toContain("1024")
        expect(server.requests).toHaveLength(1)
      }
    }),
  )

  goIt.live("classifies token-limited rewrites as an eligible chain failure instead of a successful partial response", () =>
    Effect.gen(function* () {
      const server = yield* openAIResponsesServer("Partial rewritten prompt", undefined, { incomplete: true })
      openAIBaseURL = server.url
      const headless = yield* HeadlessAI.Service
      const error = yield* headless.text({
        chain: [{ providerID: "opencode-go", modelID: "muse-spark-1.3-contributor" }],
        messages: [{ role: "user", content: "Rewrite this prompt" }],
      }).pipe(Effect.flip)
      expect(error.message).toContain("All 1 models in the chain failed")
      expect(error.message).toContain("output token budget exhausted")
    }),
  )

  goIt.live("sends session routing headers for plugin text improvement through an OpenCode Go chain", () =>
    Effect.gen(function* () {
      const server = yield* openAIResponsesServer("Improved prompt")
      openAIBaseURL = server.url
      const headless = yield* HeadlessAI.Service
      const result = yield* headless.text({
        chain: [{ providerID: "opencode-go", modelID: "muse-spark-1.3-contributor" }],
        messages: [{ role: "user", content: "Rewrite this prompt" }],
        metadata: { kind: "plugin.ai", pluginID: "speech-to-text-app" },
      })

      expect(result.text).toBe("Improved prompt")
      expect(server.headers[0]?.["x-opencode-session"]).toMatch(/^headless:[0-9a-f-]{36}$/)
      expect(server.headers[0]?.["x-opencode-client"]).toBe("headless")
      yield* headless.text({
        chain: [{ providerID: "opencode-go", modelID: "muse-spark-1.3-contributor" }],
        messages: [{ role: "user", content: "Rewrite a different prompt" }],
        metadata: { kind: "plugin.ai", pluginID: "prompt-improve-app" },
      })
      expect(server.headers[1]?.["x-opencode-session"]).not.toBe(server.headers[0]?.["x-opencode-session"])
      yield* headless.text({
        model: "opencode-go/muse-spark-1.3-contributor",
        messages: [{ role: "user", content: "Rewrite a session prompt" }],
        metadata: { kind: "plugin.ai", sessionID: "ses_existing" },
      })
      expect(server.headers[2]?.["x-opencode-session"]).toBe("ses_existing")
    }),
  )

  goIt.live("sends session routing headers for headless object requests too", () =>
    Effect.gen(function* () {
      const server = yield* openAIResponsesServer(JSON.stringify({ result: "ok" }))
      openAIBaseURL = server.url
      const headless = yield* HeadlessAI.Service
      const Result = Schema.Struct({ result: Schema.String })
      yield* headless.object({
        model: "opencode-go/muse-spark-1.3-contributor",
        messages: [{ role: "user", content: "Classify" }],
        metadata: { kind: "plugin.ai" },
        schema: Object.assign(Schema.toStandardSchemaV1(Result), Schema.toStandardJSONSchemaV1(Result)),
      })
      expect(server.headers[0]?.["x-opencode-session"]).toMatch(/^headless:[0-9a-f-]{36}$/)
      yield* headless.object({
        model: "opencode-go/muse-spark-1.3-contributor",
        messages: [{ role: "user", content: "Classify again" }],
        metadata: { kind: "plugin.ai", sessionID: "ses_existing" },
        schema: Object.assign(Schema.toStandardSchemaV1(Result), Schema.toStandardJSONSchemaV1(Result)),
      })
      expect(server.headers[1]?.["x-opencode-session"]).toBe("ses_existing")
    }),
  )

  it.live("uses normal provider defaults for OpenAI headless text requests", () =>
    Effect.gen(function* () {
      const server = yield* openAIResponsesServer("Improved prompt")
      openAIBaseURL = server.url
      const headless = yield* HeadlessAI.Service
      yield* headless.text({
        model: "openai/gpt-5.5",
        messages: [{ role: "user", content: "Rewrite this prompt" }],
        metadata: { kind: "plugin.ai" },
      })

      expect(server.requests).toHaveLength(1)
      expect(server.requests[0]?.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Rewrite this prompt" }] }])
      expect(server.requests[0]).toMatchObject({
        stream: true,
        store: false,
        prompt_cache_key: "headless:plugin.ai",
        reasoning: { effort: "medium", summary: "auto" },
        text: { verbosity: "low" },
      })
      expect(server.requests[0]).not.toHaveProperty("max_output_tokens")
      expect(server.requests[0]?.include).toEqual(["reasoning.encrypted_content"])
    }),
  )

  it.live("uses normal provider defaults for OpenAI headless object requests", () =>
    Effect.gen(function* () {
      const server = yield* openAIResponsesServer(JSON.stringify({ decision: "safe", reason: "test" }))
      openAIBaseURL = server.url
      const headless = yield* HeadlessAI.Service
      const Decision = Schema.Struct({
        decision: Schema.Literals(["safe", "unsafe"]),
        reason: Schema.String,
      })
      const schema = Object.assign(Schema.toStandardSchemaV1(Decision), Schema.toStandardJSONSchemaV1(Decision))
      const result = yield* headless.object({
        model: "openai/gpt-5.5",
        messages: [{ role: "user", content: "Classify this tool call" }],
        metadata: { kind: "permission.safety_review", sessionID: "ses_test" },
        schema,
      })

      expect(result.object).toEqual({ decision: "safe", reason: "test" })
      expect(server.requests).toHaveLength(1)
      expect(server.requests[0]?.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "Classify this tool call" }] },
      ])
      expect(server.requests[0]).toMatchObject({
        stream: true,
        store: false,
        prompt_cache_key: "ses_test",
        reasoning: { effort: "medium", summary: "auto" },
        text: {
          format: { type: "json_schema" },
          verbosity: "low",
        },
      })
      expect(server.requests[0]?.include).toEqual(["reasoning.encrypted_content"])
    }),
  )

  it.effect("fails closed before a provider request when a chain step names an unknown variant", () =>
    Effect.gen(function* () {
      const headless = yield* HeadlessAI.Service
      const error = yield* headless.text({
        chain: [{ providerID: "openai", modelID: "gpt-5.5", variant: "unknown" }],
        messages: [{ role: "user", content: "Rewrite this prompt" }],
      }).pipe(Effect.flip)

      expect(error.message).toContain("does not define variant unknown")
    }),
  )

  it.live("issues only one provider request per chain step when compatibility retry would otherwise apply", () =>
    Effect.gen(function* () {
      const server = yield* openAIResponsesServer("", "Unsupported parameter: 'max_output_tokens'")
      openAIBaseURL = server.url
      const headless = yield* HeadlessAI.Service
      yield* headless.text({
        chain: [{ providerID: "openai", modelID: "gpt-5.5" }],
        messages: [{ role: "user", content: "Rewrite this prompt" }],
        maxOutputTokens: 2000,
      }).pipe(Effect.flip)
      const Decision = Schema.Struct({ decision: Schema.String })
      yield* headless.object({
        chain: [{ providerID: "openai", modelID: "gpt-5.5" }],
        messages: [{ role: "user", content: "Classify this tool call" }],
        maxOutputTokens: 2000,
        schema: Object.assign(Schema.toStandardSchemaV1(Decision), Schema.toStandardJSONSchemaV1(Decision)),
      }).pipe(Effect.flip)

      expect(server.requests).toHaveLength(2)
    }),
  )

  it.live("omits OpenAI Responses max_output_tokens even when callers pass a headless token limit", () =>
    Effect.gen(function* () {
      const server = yield* openAIResponsesServer("Improved prompt")
      openAIBaseURL = server.url
      const headless = yield* HeadlessAI.Service
      const result = yield* headless.text({
        model: "openai/gpt-5.5",
        messages: [{ role: "user", content: "Rewrite this prompt" }],
        maxOutputTokens: 2000,
        metadata: { kind: "plugin.ai" },
      })

      expect(result.text).toBe("Improved prompt")
      expect(server.requests).toHaveLength(1)
      expect(server.requests[0]).not.toHaveProperty("max_output_tokens")
      expect(server.requests[0]).toMatchObject({ stream: true, prompt_cache_key: "headless:plugin.ai" })
    }),
  )
})
