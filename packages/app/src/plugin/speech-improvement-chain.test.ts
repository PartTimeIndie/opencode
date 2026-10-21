import { describe, expect, test } from "bun:test"
import path from "node:path"

const {
  improvementAIRequest,
  invalidateTranscriptPolishWindow,
  resolveModelTargetRequest,
  shouldPolishOnIdlePress,
  transcriptionSTTRequest,
} = await import(`${path.resolve("../../.opencode/plugin-sources/speech-to-text-app/index.js")}?chain-test=${Date.now()}`)

describe("speech-to-text-app improvement host AI request contract", () => {
  test("sends the persisted chain selection", () => {
    expect(improvementAIRequest({ improvementChain: " review-chain " })).toEqual({ chain: "review-chain" })
  })

  test("sends the durable chain reference without the prefix", () => {
    expect(improvementAIRequest({ improvementChain: "chain:review-chain" })).toEqual({ chain: "review-chain" })
  })

  test("sends model for a direct durable model selection", () => {
    expect(improvementAIRequest({ improvementChain: "model:openai/gpt-5.5" })).toEqual({ model: "openai/gpt-5.5" })
  })

  test("legacy bare provider/model values migrate to a direct model request", () => {
    expect(improvementAIRequest({ improvementChain: "openai/gpt-5.5" })).toEqual({ model: "openai/gpt-5.5" })
  })

  test("fails clearly instead of falling back to a hard-coded model", () => {
    expect(() => improvementAIRequest({})).toThrow("Configure an improvement model or chain")
    expect(() => improvementAIRequest({ improvementModel: "legacy/provider-model" })).toThrow(
      "Configure an improvement model or chain",
    )
  })
})

describe("speech-to-text-app transcription request contract", () => {
  test("keeps the explicit-only rule for the text default chain", () => {
    expect(() => transcriptionSTTRequest({ transcriptionChain: "default" })).toThrow(
      "Speech transcription requires an explicitly selected model or chain",
    )
    expect(() => transcriptionSTTRequest({ transcriptionChain: "chain:default" })).toThrow(
      "Speech transcription requires an explicitly selected model or chain",
    )
  })

  test("sends model or chain for durable and legacy selections", () => {
    expect(transcriptionSTTRequest({ transcriptionChain: "chain:stt-fallback-chain" })).toEqual({
      chain: "stt-fallback-chain",
    })
    expect(transcriptionSTTRequest({ transcriptionChain: " stt-fallback-chain " })).toEqual({
      chain: "stt-fallback-chain",
    })
    expect(transcriptionSTTRequest({ transcriptionChain: "model:openai/whisper-2" })).toEqual({
      model: "openai/whisper-2",
    })
    expect(transcriptionSTTRequest({ transcriptionChain: "openai/whisper-2" })).toEqual({
      model: "openai/whisper-2",
    })
    expect(() => transcriptionSTTRequest({})).toThrow("Configure an audio-capable transcription model or chain")
  })

  test("resolveModelTargetRequest rejects malformed durable references", () => {
    expect(() => resolveModelTargetRequest("chain:", "broken")).toThrow("broken")
    expect(() => resolveModelTargetRequest("model:", "broken")).toThrow("broken")
    expect(() => resolveModelTargetRequest("model:no-slash", "broken")).toThrow("broken")
  })
})

describe("speech-to-text-app idle double-press polish", () => {
  test("improves the last transcript within the double-press window", () => {
    expect(
      shouldPolishOnIdlePress({
        phase: "idle",
        lastTranscript: "please fix the composer",
        lastFinishedAt: 1000,
        now: 2500,
        sameComposer: true,
      }),
    ).toBe(true)
  })

  test("starts a new recording after the window or without a transcript", () => {
    expect(
      shouldPolishOnIdlePress({
        phase: "idle",
        lastTranscript: "please fix the composer",
        lastFinishedAt: 1000,
        now: 4000,
        sameComposer: true,
      }),
    ).toBe(false)
    expect(
      shouldPolishOnIdlePress({
        phase: "idle",
        lastTranscript: "",
        lastFinishedAt: 1000,
        now: 1500,
        sameComposer: true,
      }),
    ).toBe(false)
    expect(
      shouldPolishOnIdlePress({
        phase: "recording",
        lastTranscript: "please fix the composer",
        lastFinishedAt: 1000,
        now: 1500,
        sameComposer: true,
      }),
    ).toBe(false)
  })

  test("starts a new recording in a different composer even within the window", () => {
    expect(
      shouldPolishOnIdlePress({
        phase: "idle",
        lastTranscript: "please fix the composer",
        lastFinishedAt: 1000,
        now: 1500,
        sameComposer: false,
      }),
    ).toBe(false)
  })

  test("starts a new recording instead of polishing a transcript that was already improved", () => {
    expect(
      shouldPolishOnIdlePress({
        phase: "idle",
        lastTranscript: "please fix the composer",
        lastFinishedAt: 1000,
        now: 1500,
        sameComposer: true,
        lastTranscriptImproved: true,
      }),
    ).toBe(false)
  })

  test("does not polish a transcript when its destination cannot replace the inserted text", () => {
    expect(
      shouldPolishOnIdlePress({
        phase: "idle",
        lastTranscript: "please fix the composer",
        lastFinishedAt: 1000,
        now: 1500,
        sameComposer: true,
        canReplaceLastTranscript: false,
      }),
    ).toBe(false)
  })

  test("does not polish a transcript when the current destination cannot replace the inserted text", () => {
    expect(
      shouldPolishOnIdlePress({
        phase: "idle",
        lastTranscript: "please fix the composer",
        lastFinishedAt: 1000,
        now: 1500,
        sameComposer: true,
        canReplaceCurrentTranscript: false,
      }),
    ).toBe(false)
  })

  test("does not polish an earlier transcript while insertion recovery is pending", () => {
    expect(
      shouldPolishOnIdlePress({
        phase: "idle",
        lastTranscript: "please fix the composer",
        lastFinishedAt: 1000,
        now: 1500,
        sameComposer: true,
        hasRecovery: true,
      }),
    ).toBe(false)
  })

  test("clipboard improvement invalidates the previous transcript's double-press window", () => {
    const state = { lastFinishedAt: 1000 }
    invalidateTranscriptPolishWindow(state)
    expect(state.lastFinishedAt).toBe(0)
    expect(
      shouldPolishOnIdlePress({
        phase: "idle",
        lastTranscript: "previous transcript",
        lastFinishedAt: state.lastFinishedAt,
        now: 1500,
        sameComposer: true,
      }),
    ).toBe(false)
  })
})
