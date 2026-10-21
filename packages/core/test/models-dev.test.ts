import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "../src/models-dev"

describe("models.dev modalities", () => {
  test("decodes audio input and transcription output independently", () => {
    const model = Schema.decodeUnknownSync(Model)({
      id: "deepgram/nova-3",
      name: "Nova 3",
      release_date: "2026-01-01",
      attachment: false,
      reasoning: false,
      temperature: false,
      tool_call: false,
      limit: { context: 1, output: 1 },
      modalities: { input: ["audio"], output: ["transcription"] },
    })

    expect(model.modalities?.input).toEqual(["audio"])
    expect(model.modalities?.output).toEqual(["transcription"])
  })

  test("decodes dedicated speech output and published voices", () => {
    const model = Schema.decodeUnknownSync(Model)({
      id: "mistralai/voxtral-mini-tts-2603",
      name: "Voxtral Mini TTS",
      release_date: "2026-03-01",
      attachment: false,
      reasoning: false,
      temperature: false,
      tool_call: false,
      limit: { context: 4096, output: 3276 },
      modalities: { input: ["text"], output: ["speech"] },
      supported_voices: ["en_paul_neutral", "fr_marie_neutral"],
    })

    expect(model.modalities?.output).toEqual(["speech"])
    expect(model.supported_voices).toEqual(["en_paul_neutral", "fr_marie_neutral"])
  })

  test("decodes reasoning_options effort, toggle and budget_tokens", () => {
    const model = Schema.decodeUnknownSync(Model)({
      id: "openai/gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      release_date: "2026-07-01",
      attachment: true,
      reasoning: true,
      temperature: true,
      tool_call: true,
      reasoning_options: [
        { type: "effort", values: ["low", "medium", "high"] },
        { type: "toggle" },
        { type: "budget_tokens", min: 1024, max: 8192 },
      ],
      limit: { context: 1_000_000, output: 128_000 },
    })

    expect(model.reasoning_options).toEqual([
      { type: "effort", values: ["low", "medium", "high"] },
      { type: "toggle" },
      { type: "budget_tokens", min: 1024, max: 8192 },
    ])
  })

  test("decodes interleaved boolean, string field and object field", () => {
    const boolModel = Schema.decodeUnknownSync(Model)({
      id: "openai/gpt-5",
      name: "GPT-5",
      release_date: "2025-08-07",
      attachment: false,
      reasoning: true,
      temperature: false,
      tool_call: true,
      interleaved: true,
      limit: { context: 1, output: 1 },
    })
    expect(boolModel.interleaved).toBe(true)

    const fieldModel = Schema.decodeUnknownSync(Model)({
      id: "anthropic/claude-sonnet-4",
      name: "Claude Sonnet 4",
      release_date: "2025-05-01",
      attachment: false,
      reasoning: true,
      temperature: false,
      tool_call: true,
      interleaved: { field: "reasoning_text" },
      limit: { context: 1, output: 1 },
    })
    expect(fieldModel.interleaved).toEqual({ field: "reasoning_text" })

    const rawFieldModel = Schema.decodeUnknownSync(Model)({
      id: "anthropic/claude-opus-4",
      name: "Claude Opus 4",
      release_date: "2025-05-01",
      attachment: false,
      reasoning: true,
      temperature: false,
      tool_call: true,
      interleaved: "reasoning_content",
      limit: { context: 1, output: 1 },
    })
    expect(rawFieldModel.interleaved).toBe("reasoning_content")
  })

  test("decodes cost tiers and context_over_200k pricing", () => {
    const model = Schema.decodeUnknownSync(Model)({
      id: "openai/gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      release_date: "2026-07-01",
      attachment: false,
      reasoning: true,
      temperature: true,
      tool_call: true,
      cost: {
        input: 10,
        output: 60,
        cache_read: 1,
        cache_write: 12.5,
        tiers: [
          {
            input: 15,
            output: 90,
            cache_read: 1.5,
            cache_write: 18.75,
            tier: { type: "context", size: 272_000 },
          },
        ],
        context_over_200k: {
          input: 20,
          output: 120,
          cache_read: 2,
          cache_write: 25,
        },
      },
      limit: { context: 1_000_000, output: 128_000 },
    })

    expect(model.cost?.tiers?.[0].tier.size).toBe(272_000)
    expect(model.cost?.context_over_200k?.input).toBe(20)
  })
})
