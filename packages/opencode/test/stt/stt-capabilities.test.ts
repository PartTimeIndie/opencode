import { describe, expect, test } from "bun:test"
import { supportsTranscriptionModel } from "@/stt/stt"

function model(input: { audio: boolean; transcription: boolean }) {
  return {
    capabilities: {
      input: { audio: input.audio },
      output: { transcription: input.transcription },
    },
  }
}

describe("STT model capabilities", () => {
  test("requires audio input and transcription output", () => {
    expect(supportsTranscriptionModel(model({ audio: true, transcription: true }))).toBe(true)
    expect(supportsTranscriptionModel(model({ audio: true, transcription: false }))).toBe(false)
    expect(supportsTranscriptionModel(model({ audio: false, transcription: true }))).toBe(false)
    expect(supportsTranscriptionModel(undefined)).toBe(false)
  })
})
