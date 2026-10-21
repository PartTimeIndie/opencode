import { describe, expect, test } from "bun:test"
import {
  chainMatchesChainPickerFilter,
  getModelChainPickerOptions,
  modelMatchesChainPickerFilter,
  shouldAutoSelectSingleModelChain,
  type ModelChainPickerChain,
  type ModelChainPickerModel,
} from "./settings-model-chain-picker-model"

const text = (id: string, providerID = "openai"): ModelChainPickerModel => ({
  modelID: id,
  name: id,
  providerID,
  capabilities: { input: { text: true } },
})

const audioCaps = (id: string, providerID = "openai"): ModelChainPickerModel => ({
  modelID: id,
  name: id,
  providerID,
  capabilities: { input: { text: true, audio: true } },
})

const audioLegacy = (id: string, providerID = "openai"): ModelChainPickerModel => ({
  modelID: id,
  name: id,
  providerID,
  modalities: { input: ["text", "audio"] },
})

const chain = (id: string, steps: string[]): ModelChainPickerChain => ({
  id,
  name: id,
  steps: steps.map((model) => ({
    providerID: model.slice(0, model.indexOf("/")),
    modelID: model.slice(model.indexOf("/") + 1),
  })),
})

function transcription(id: string, providerID = "openrouter"): ModelChainPickerModel {
  return {
    providerID,
    modelID: id,
    capabilities: { input: { audio: true }, output: { transcription: true } },
  }
}

function speech(id: string, providerID = "openrouter"): ModelChainPickerModel {
  return {
    providerID,
    modelID: id,
    capabilities: { input: { text: true }, output: { speech: true } },
  }
}

describe("modelMatchesChainPickerFilter", () => {
  test("accepts audio via capabilities.input", () => {
    expect(modelMatchesChainPickerFilter(audioCaps("a"), { inputModalities: ["audio"] })).toBe(true)
    expect(modelMatchesChainPickerFilter(text("t"), { inputModalities: ["audio"] })).toBe(false)
  })

  test("accepts audio via legacy modalities.input", () => {
    expect(modelMatchesChainPickerFilter(audioLegacy("a"), { inputModalities: ["audio"] })).toBe(true)
  })

  test("accepts only dedicated transcription models for transcription chains", () => {
    const filter = { purpose: "transcription" } as const
    expect(
      modelMatchesChainPickerFilter(transcription("nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b"), filter),
    ).toBe(true)
    expect(modelMatchesChainPickerFilter(transcription("x-ai/grok-stt-1.0"), filter)).toBe(true)
    expect(modelMatchesChainPickerFilter(transcription("deepgram/nova-3"), filter)).toBe(true)
    expect(modelMatchesChainPickerFilter(transcription("google/chirp-3"), filter)).toBe(true)
    expect(modelMatchesChainPickerFilter(transcription("qwen/qwen3-asr-0.6b"), filter)).toBe(true)
    expect(modelMatchesChainPickerFilter(transcription("mistralai/voxtral-small-24b-2507-stt"), filter)).toBe(true)
    expect(modelMatchesChainPickerFilter(transcription("openai/whisper-1"), filter)).toBe(true)
    expect(
      modelMatchesChainPickerFilter(
        {
          providerID: "openrouter",
          modelID: "openai/gpt-audio-mini",
          capabilities: { input: { audio: true }, output: { transcription: false } },
        },
        filter,
      ),
    ).toBe(false)
    expect(
      modelMatchesChainPickerFilter(
        {
          providerID: "openrouter",
          modelID: "mistralai/voxtral-small-24b-2507",
          capabilities: { input: { audio: true }, output: { transcription: false } },
        },
        filter,
      ),
    ).toBe(false)
    expect(modelMatchesChainPickerFilter(audioCaps("gpt-audio-mini", "openai"), filter)).toBe(false)
    expect(modelMatchesChainPickerFilter(transcription("qwen/qwen3-asr-0.6b"), filter)).toBe(true)
    expect(
      modelMatchesChainPickerFilter(
        { providerID: "openrouter", modelID: "openai/whisper-1", capabilities: { input: { text: true } } },
        { inputModalities: ["audio"], purpose: "transcription" },
      ),
    ).toBe(true)
    expect(
      modelMatchesChainPickerFilter(
        { providerID: "openrouter", modelID: "openai/gpt-5", capabilities: { input: { text: true } } },
        { inputModalities: ["audio"], purpose: "transcription" },
      ),
    ).toBe(false)
  })

  test("accepts only dedicated speech models for text-to-speech chains", () => {
    const filter = { purpose: "speech" } as const
    expect(modelMatchesChainPickerFilter(speech("mistralai/voxtral-mini-tts-2603"), filter)).toBe(true)
    expect(
      modelMatchesChainPickerFilter(
        {
          providerID: "openrouter",
          modelID: "openai/gpt-4o-mini-tts-2025-12-15",
          capabilities: { input: { text: true } },
        },
        filter,
      ),
    ).toBe(true)
    expect(modelMatchesChainPickerFilter(text("gpt-5"), filter)).toBe(false)
    expect(modelMatchesChainPickerFilter(transcription("openai/whisper-1"), filter)).toBe(false)
  })
})

describe("chainMatchesChainPickerFilter", () => {
  const models = [text("one"), text("two"), audioCaps("audio")]

  test("requires every step to resolve and match", () => {
    expect(
      chainMatchesChainPickerFilter(chain("ok", ["openai/one", "openai/two"]), models, { providerIDs: ["openai"] }),
    ).toBe(true)
    expect(chainMatchesChainPickerFilter(chain("missing", ["openai/one", "openai/missing"]), models)).toBe(false)
    expect(
      chainMatchesChainPickerFilter(chain("audio-only-second", ["openai/one", "openai/two"]), models, {
        inputModalities: ["audio"],
      }),
    ).toBe(false)
    expect(
      chainMatchesChainPickerFilter(chain("audio", ["openai/audio", "openai/audio"]), models, {
        inputModalities: ["audio"],
      }),
    ).toBe(true)
  })

  test("keeps uncatalogued STT and TTS chains selectable by model id", () => {
    expect(
      chainMatchesChainPickerFilter(
        chain("stt", ["openrouter/qwen/qwen3-asr-0.6b", "openrouter/mistralai/voxtral-small-24b-2507-stt"]),
        [],
        { inputModalities: ["audio"], purpose: "transcription" },
      ),
    ).toBe(true)
    expect(
      chainMatchesChainPickerFilter(
        chain("tts", ["openrouter/openai/gpt-4o-mini-tts-2025-12-15", "openrouter/mistralai/voxtral-mini-tts-2603"]),
        [],
        { purpose: "speech" },
      ),
    ).toBe(true)
    expect(
      chainMatchesChainPickerFilter(chain("stt-in-speech", ["openrouter/qwen/qwen3-asr-0.6b"]), [], {
        purpose: "speech",
      }),
    ).toBe(false)
    expect(
      chainMatchesChainPickerFilter(chain("other-provider", ["other/qwen/qwen3-asr-0.6b"]), [], {
        purpose: "transcription",
      }),
    ).toBe(false)
    expect(chainMatchesChainPickerFilter(chain("chat", ["openrouter/openai/gpt-5"]), [], undefined)).toBe(false)
  })

  test("requires every text-to-speech chain step to support speech output", () => {
    const models = [speech("primary"), speech("fallback"), text("chat", "openrouter")]
    expect(
      chainMatchesChainPickerFilter(chain("speech", ["openrouter/primary", "openrouter/fallback"]), models, {
        purpose: "speech",
      }),
    ).toBe(true)
    expect(
      chainMatchesChainPickerFilter(chain("mixed", ["openrouter/primary", "openrouter/chat"]), models, {
        purpose: "speech",
      }),
    ).toBe(false)
  })
})

describe("getModelChainPickerOptions", () => {
  const models = [text("one"), text("two")]
  const chains = [chain("valid", ["openai/one", "openai/two"]), chain("broken", ["openai/one", "openai/missing"])]

  test("keeps an unavailable stored value visible", () => {
    const options = getModelChainPickerOptions({
      chains,
      models,
      value: "broken",
      required: true,
    })
    expect(options.some((item) => item.value === "broken" && item.unavailable)).toBe(true)
    expect(options.some((item) => item.value === "valid")).toBe(true)
    expect(options.some((item) => item.value === "")).toBe(false)
  })

  test("includes No chain when required is false", () => {
    const options = getModelChainPickerOptions({
      chains,
      models,
      value: "",
      required: false,
    })
    expect(options[0]).toEqual({ value: "", label: "No chain" })
  })
})

describe("shouldAutoSelectSingleModelChain", () => {
  test("selects the only valid chain when empty or invalid", () => {
    expect(
      shouldAutoSelectSingleModelChain({
        autoSelectSingle: true,
        value: "",
        validChainIDs: ["only"],
      }),
    ).toBe("only")
    expect(
      shouldAutoSelectSingleModelChain({
        autoSelectSingle: true,
        value: "gone",
        validChainIDs: ["only"],
      }),
    ).toBe("only")
  })

  test("prefers the valid default chain when requested", () => {
    expect(
      shouldAutoSelectSingleModelChain({
        autoSelectDefault: true,
        defaultChainID: "default",
        value: "gone",
        validChainIDs: ["other", "default"],
      }),
    ).toBe("default")
  })

  test("does not overwrite a valid value or multiple matches", () => {
    expect(
      shouldAutoSelectSingleModelChain({
        autoSelectSingle: true,
        value: "only",
        validChainIDs: ["only"],
      }),
    ).toBeUndefined()
    expect(
      shouldAutoSelectSingleModelChain({
        autoSelectSingle: true,
        value: "stale",
        validChainIDs: ["a", "b"],
      }),
    ).toBeUndefined()
    expect(
      shouldAutoSelectSingleModelChain({
        autoSelectSingle: false,
        value: "",
        validChainIDs: ["only"],
      }),
    ).toBeUndefined()
  })

  test("repairs a persisted invalid chain when exactly one catalog-valid transcription chain remains", () => {
    expect(
      shouldAutoSelectSingleModelChain({
        autoSelectSingle: true,
        value: "stale-audio-chain",
        validChainIDs: ["catalog-stt-chain"],
      }),
    ).toBe("catalog-stt-chain")
  })
})
