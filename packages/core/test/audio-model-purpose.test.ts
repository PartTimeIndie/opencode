import { describe, expect, test } from "bun:test"
import {
  applyAudioPurposeCapabilities,
  looksLikeSpeechModel,
  looksLikeTranscriptionModel,
} from "../src/audio-model-purpose"

describe("audio model purpose", () => {
  test("recognizes catalogued transcription model ids", () => {
    expect(looksLikeTranscriptionModel("openai/whisper-1")).toBe(true)
    expect(looksLikeTranscriptionModel("nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b")).toBe(true)
    expect(looksLikeTranscriptionModel("x-ai/grok-stt-1.0")).toBe(true)
    expect(looksLikeTranscriptionModel("mistralai/voxtral-small-24b-2507-stt")).toBe(true)
    expect(looksLikeTranscriptionModel("mistralai/voxtral-small-24b-2507")).toBe(true)
    expect(looksLikeTranscriptionModel("mistralai/voxtral-mini-3b-2507")).toBe(true)
    expect(looksLikeTranscriptionModel("openai/gpt-audio-mini")).toBe(false)
  })

  test("recognizes dedicated speech model ids", () => {
    expect(looksLikeSpeechModel("mistralai/voxtral-mini-tts-2603")).toBe(true)
    expect(looksLikeSpeechModel("openai/gpt-4o-mini-tts-2025-12-15")).toBe(true)
    expect(looksLikeSpeechModel("elevenlabs/scribe-v1")).toBe(false)
    expect(looksLikeSpeechModel("openai/whisper-1")).toBe(false)
    expect(looksLikeSpeechModel("openai/gpt-5")).toBe(false)
  })

  test("fills missing transcription and speech capability flags", () => {
    const transcription = applyAudioPurposeCapabilities("openai/whisper-1", {
      input: { text: false, audio: false },
      output: { transcription: false, speech: false },
    })
    expect(transcription.input.audio).toBe(true)
    expect(transcription.output.transcription).toBe(true)
    const speech = applyAudioPurposeCapabilities("openai/gpt-4o-mini-tts-2025-12-15", {
      input: { text: false, audio: false },
      output: { transcription: false, speech: false },
    })
    expect(speech.input.text).toBe(true)
    expect(speech.output.speech).toBe(true)
  })
})
