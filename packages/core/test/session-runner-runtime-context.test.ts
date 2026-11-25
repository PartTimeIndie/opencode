import { expect } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { createCerebras } from "@ai-sdk/cerebras"
import { LLM, LLMClient, LLMEvent, Message, SystemPart } from "@opencode-ai/llm"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { SessionRunnerAISDK } from "@opencode-ai/core/session/runner/aisdk"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { it } from "./lib/effect"
import { model } from "./plugin/provider-helper"

const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer))

function fixture(mode: "chat" | "responses" | "unsupported", id = "gpt-4.1") {
  const bodies: string[] = []
  const options = {
    apiKey: "fixture",
    fetch: Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        bodies.push(String(init?.body))
        return new Response(
          mode === "responses"
            ? `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 1 } } })}\n\n`
            : `data: ${JSON.stringify({ id: "fixture", created: 0, model: id, choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
      { preconnect: fetch.preconnect },
    ),
  }
  const language =
    mode === "unsupported"
      ? createCerebras(options).languageModel("qwen-fixture")
      : mode === "chat"
        ? createOpenAI(options).chat(id)
        : createOpenAI(options).responses(id)
  const request = LLM.request({
    model: SessionRunnerModel.fromAISDKModel(model("openai", id), language),
    system: "Shared instructions",
    messages: [Message.user("Work"), Message.assistant("Answer"), Message.system("<operator> & update")],
    runtimeContext: [SystemPart.make("Host-owned context")],
  })
  return { bodies, language, request }
}

for (const mode of ["chat", "responses"] as const)
  for (const id of ["gpt-4.1", "gpt-5"]) {
    it.effect(`preserves late system rank on the real OpenAI ${mode} SDK wire for ${id}`, () =>
      Effect.gen(function* () {
        const input = fixture(mode, id)
        const events = yield* LLMClient.stream(input.request).pipe(Stream.runCollect, Effect.provide(client))
        expect(input.bodies).toHaveLength(1)
        const body = JSON.parse(input.bodies[0] ?? "{}")
        const prompt = mode === "chat" ? body.messages : body.input
        expect(prompt.map((item: { role: string }) => item.role)).toEqual([
          "system",
          "user",
          "assistant",
          "user",
          "system",
        ])
        expect(prompt[0]).toEqual({ role: "system", content: "Shared instructions" })
        expect(prompt.at(-1)).toEqual({ role: "system", content: "Host-owned context" })
        expect(JSON.stringify(prompt[3])).toContain("&lt;operator&gt; &amp; update")
        expect(Array.from(events).filter(LLMEvent.is.providerError)).toEqual([])
        expect(Array.from(events).filter(LLMEvent.is.finish)).toHaveLength(1)
      }),
    )
  }

it.effect("rejects unsupported SDKs and destructive provider options even when called directly", () =>
  Effect.gen(function* () {
    for (const mode of ["unsupported", "responses"] as const) {
      const input = fixture(mode)
      const attempts =
        mode === "unsupported"
          ? [input.request]
          : [
              LLM.updateRequest(input.request, { providerOptions: { openai: { systemMessageMode: "remove" } } }),
              LLM.updateRequest(input.request, {
                providerOptions: { openai: { previousResponseId: "foreign-history" } },
              }),
            ]
      for (const request of attempts) {
        const events = yield* SessionRunnerAISDK.stream(input.language, request).pipe(Stream.runCollect)
        expect(Array.from(events).filter(LLMEvent.is.providerError)).toHaveLength(1)
        expect(Array.from(events).filter(LLMEvent.is.finish)).toEqual([])
      }
      expect(input.bodies).toEqual([])
    }
  }),
)
