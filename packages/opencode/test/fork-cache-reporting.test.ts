import { expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM, LLMClient, LLMEvent, Usage } from "@opencode-ai/llm"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { codexRoute } from "@opencode-ai/llm/protocols/openai-responses"
import { cacheUsage } from "../script/fork-cache-usage"
import { cacheComparisonMessages } from "../script/fork-cache-messages"

test("the comparison preserves Main's full last-user cache-write boundary", async () => {
  const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer))
  const model = codexRoute.model({ id: "fixture" })
  const prepared = await Promise.all((["main", "child"] as const).map((role) => Effect.runPromise(LLMClient.prepare(LLM.request({
    model, system: "Shared instructions", messages: cacheComparisonMessages("Shared reference material", role),
  })).pipe(Effect.provide(client)))))
  const main = prepared[0]!.body as { input: unknown[] }
  const child = prepared[1]!.body as { input: unknown[] }
  expect(main.input).toHaveLength(2)
  expect(child.input).toHaveLength(3)
  expect(child.input.slice(0, main.input.length)).toEqual(main.input)
})

for (const cached of [0, 3584, undefined])
  test(`real Codex HTTP usage mapping preserves ${cached ?? "unknown"} cached tokens`, async () => {
    let calls = 0
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
      calls++
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { usage: {
        input_tokens: 4096, output_tokens: 1, ...(cached !== undefined ? { input_tokens_details: { cached_tokens: cached } } : {}),
      } } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    } })
    try {
      const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer))
      const model = codexRoute.with({ endpoint: { baseURL: `http://127.0.0.1:${server.port}` } }).model({ id: "fixture" })
      const events = Array.from(await Effect.runPromise(LLMClient.stream(LLM.request({ model, prompt: "Reporting fixture", tools: [], http: { retries: 0 } })).pipe(
        Stream.runCollect, Effect.provide(client), Effect.timeout("5 seconds"),
      )))
      const finish = events.findLast(LLMEvent.is.finish)
      expect(finish).toBeDefined()
      const observed = cacheUsage(finish?.usage)
      expect(observed).toEqual(cached === undefined ? { inputTokens: undefined, cacheReadInputTokens: undefined, rawUsageVerified: false }
        : { inputTokens: 4096, cacheReadInputTokens: cached, rawUsageVerified: true })
      expect(calls).toBe(1)
    } finally { await server.stop(true) }
  })

test("reporting refuses mapped/raw disagreement and never turns unknown into zero", () => {
  expect(cacheUsage(undefined)).toMatchObject({ rawUsageVerified: false, cacheReadInputTokens: undefined })
  expect(() => cacheUsage(new Usage({ inputTokens: 4096, cacheReadInputTokens: 0,
    providerMetadata: { openai: { input_tokens: 4096, input_tokens_details: { cached_tokens: 3584 } } } }))).toThrow()
  const result = cacheUsage(new Usage({ inputTokens: 4096, cacheReadInputTokens: 0,
    providerMetadata: { openai: { input_tokens: 4096, input_tokens_details: {}, secret: "never-report" } } }))
  expect(result).toMatchObject({ rawUsageVerified: false, cacheReadInputTokens: undefined })
  expect(JSON.stringify(result)).not.toContain("never-report")
})
