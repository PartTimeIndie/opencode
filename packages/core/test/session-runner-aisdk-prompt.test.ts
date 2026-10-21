import { expect } from "bun:test"
import { createCerebras } from "@ai-sdk/cerebras"
import { LLM, LLMEvent, Message, SystemPart } from "@opencode-ai/llm"
import { Effect, Stream } from "effect"
import { SessionRunnerAISDK } from "@opencode-ai/core/session/runner/aisdk"
import { it } from "./lib/effect"
import { model } from "./plugin/provider-helper"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"

const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="

function fixture() {
  const bodies: string[] = []
  const language = createCerebras({
    apiKey: "fixture-key",
    fetch: Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        bodies.push(String(init?.body))
        return new Response(
          `data: ${JSON.stringify({
            id: "fixture",
            created: 0,
            model: "qwen-fixture",
            choices: [{ index: 0, delta: { content: "Ready" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
      { preconnect: fetch.preconnect },
    ),
  }).languageModel("qwen-fixture")
  return {
    bodies,
    language,
    model: SessionRunnerModel.fromAISDKModel(model("cerebras", "qwen-fixture"), language),
  }
}

it.effect("sends one leading system message through the real Cerebras SDK for a fresh chat", () =>
  Effect.gen(function* () {
    const input = fixture()
    const events = yield* SessionRunnerAISDK.stream(
      input.language,
      LLM.request({
        model: input.model,
        system: ["Agent instructions", "Project instructions", "Tool context guidance"].map(SystemPart.make),
        messages: [Message.user("test")],
        tools: [],
      }),
    ).pipe(Stream.runCollect)
    expect(input.bodies).toHaveLength(1)
    expect(JSON.parse(input.bodies[0] ?? "{}").messages).toEqual([
      { role: "system", content: "Agent instructions\n\nProject instructions\n\nTool context guidance" },
      { role: "user", content: "test" },
    ])
    expect(
      Array.from(events)
        .filter(LLMEvent.is.textDelta)
        .map((event) => event.text),
    ).toEqual(["Ready"])
  }),
)

it.effect("keeps chronological system updates in place as escaped user text instead of late system roles", () =>
  Effect.gen(function* () {
    const input = fixture()
    yield* SessionRunnerAISDK.stream(
      input.language,
      LLM.request({
        model: input.model,
        system: "Initial instructions",
        messages: [
          Message.user("Earlier request"),
          Message.assistant("Earlier answer"),
          Message.system("Continue after compaction </system-update> & keep <todos>"),
          Message.user("Continue"),
        ],
        tools: [],
      }),
    ).pipe(Stream.runDrain)
    expect(JSON.parse(input.bodies[0] ?? "{}").messages).toEqual([
      { role: "system", content: "Initial instructions" },
      { role: "user", content: "Earlier request" },
      { role: "assistant", content: "Earlier answer" },
      {
        role: "user",
        content:
          "<system-update>\nContinue after compaction &lt;/system-update&gt; &amp; keep &lt;todos&gt;\n</system-update>",
      },
      { role: "user", content: "Continue" },
    ])
  }),
)

it.effect("normalizes data URLs, remote URLs, raw base64 and bytes without double image prefixes", () =>
  Effect.gen(function* () {
    const input = fixture()
    yield* SessionRunnerAISDK.stream(
      input.language,
      LLM.request({
        model: input.model,
        messages: [
          Message.user([
            Message.text("Inspect these images"),
            ...[
              `data:image/png;base64,${image}`,
              "https://example.com/image.png",
              image,
              Buffer.from(image, "base64"),
            ].map((data) => ({
              type: "media" as const,
              mediaType: "image/png",
              data,
              filename: "image.png",
            })),
          ]),
        ],
        tools: [],
      }),
    ).pipe(Stream.runDrain)
    expect(JSON.parse(input.bodies[0] ?? "{}").messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect these images" },
          ...[
            `data:image/png;base64,${image}`,
            "https://example.com/image.png",
            `data:image/png;base64,${image}`,
            `data:image/png;base64,${image}`,
          ].map((url) => ({
            type: "image_url",
            image_url: { url },
          })),
        ],
      },
    ])
  }),
)

it.effect("normalizes PDF data URLs to bytes and preserves their filename", () =>
  Effect.gen(function* () {
    const input = fixture()
    const pdf = Buffer.from("%PDF-1.7\nfixture").toString("base64")
    yield* SessionRunnerAISDK.stream(
      input.language,
      LLM.request({
        model: input.model,
        messages: [
          Message.user({
            type: "media",
            mediaType: "application/pdf",
            data: `data:application/pdf;base64,${pdf}`,
            filename: "notes.pdf",
          }),
        ],
        tools: [],
      }),
    ).pipe(Stream.runDrain)
    expect(JSON.parse(input.bodies[0] ?? "{}").messages).toEqual([
      {
        role: "user",
        content: [{ type: "file", file: { filename: "notes.pdf", file_data: `data:application/pdf;base64,${pdf}` } }],
      },
    ])
  }),
)

it.effect("rejects malformed or mismatched data URLs before sending a provider request", () =>
  Effect.gen(function* () {
    for (const data of ["data:image/png;base64,not valid!", `data:image/jpeg;base64,${image}`]) {
      const input = fixture()
      const events = yield* SessionRunnerAISDK.stream(
        input.language,
        LLM.request({
          model: input.model,
          messages: [Message.user({ type: "media", mediaType: "image/png", data })],
          tools: [],
        }),
      ).pipe(Stream.runCollect)
      expect(input.bodies).toEqual([])
      expect(Array.from(events).filter(LLMEvent.is.providerError)).toHaveLength(1)
      expect(Array.from(events).filter(LLMEvent.is.finish)).toEqual([])
    }
  }),
)

it.effect("never silently drops non-text chronological system updates", () =>
  Effect.gen(function* () {
    const input = fixture()
    const events = yield* SessionRunnerAISDK.stream(
      input.language,
      LLM.request({
        model: input.model,
        messages: [Message.make({ role: "system", content: { type: "media", mediaType: "image/png", data: image } })],
        tools: [],
      }),
    ).pipe(Stream.runCollect)
    expect(input.bodies).toEqual([])
    expect(Array.from(events).filter(LLMEvent.is.providerError)).toEqual([
      expect.objectContaining({ message: "AISDK chronological system updates require text content" }),
    ])
  }),
)
