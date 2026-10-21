import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import path from "node:path"
import { SPEECH_POLISH_CHAIN_ID, SPEECH_SPEED_TARGETS, speechSpeedProfile } from "../../script/speech-speed-profile"

describe("measured speech speed profile", () => {
  const chains = [
    {
      id: "speech",
      name: "Speech STT",
      steps: [{ providerID: "openrouter", modelID: "mistralai/voxtral-small-24b-2507" }],
    },
    { id: "coding", name: "Coding", steps: [{ providerID: "openai", modelID: "coding-model", variant: "high" }] },
  ]

  test("repairs the stale fallback and declares every ASR model for catalogs omitting audio", () => {
    const profile = speechSpeedProfile(chains, "speech")
    expect(profile.model_chains[0].steps[0].modelID).toBe("openai/gpt-4o-mini-transcribe")
    expect(profile.model_chains[0].steps.at(-1)?.modelID).toBe("mistralai/voxtral-small-24b-2507-stt")
    for (const step of profile.model_chains[0].steps) {
      const model = Object.entries(profile.provider.openrouter.models).find(([id]) => id === step.modelID)?.[1]
      expect(model?.modalities).toEqual({ input: ["audio"], output: ["transcription"] })
    }
  })

  test("pins measured text providers without touching general-purpose chains", () => {
    const profile = speechSpeedProfile(chains, "speech")
    expect(profile.model_chains[1]).toBe(chains[1])
    expect(chains[0].steps[0].modelID).toBe("mistralai/voxtral-small-24b-2507")
    expect(profile.provider.openrouter.models["speech-polish-groq"].options).toEqual({
      provider: { only: ["groq"], allow_fallbacks: false },
      reasoning: { effort: "minimal" },
    })
    expect(profile.model_chains.at(-1)?.id).toBe(SPEECH_POLISH_CHAIN_ID)
  })

  test("is idempotent and refuses a disappeared chain", () => {
    const profile = speechSpeedProfile(chains, "speech")
    expect(speechSpeedProfile(profile.model_chains, "speech")).toEqual(profile)
    expect(() => speechSpeedProfile(chains, "missing")).toThrow("Transcription chain no longer exists")
  })

  test("is accepted by the on-disk config schema", () => {
    const profile = speechSpeedProfile(chains, "speech")
    expect(() => Schema.decodeUnknownSync(ConfigV1.UpdateInfo)(profile)).not.toThrow()
  })

  test("live targets resolve directly without a stale renderer chain snapshot", async () => {
    const speech = await import(path.resolve("../../.opencode/plugin-sources/speech-to-text-app/index.js"))
    expect(speech.transcriptionSTTRequest(SPEECH_SPEED_TARGETS)).toEqual({
      model: "openrouter/openai/gpt-4o-mini-transcribe",
    })
    expect(speech.improvementAIRequest(SPEECH_SPEED_TARGETS)).toEqual({ model: "openrouter/speech-polish-groq" })
  })
})
