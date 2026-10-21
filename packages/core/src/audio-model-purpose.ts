/** Infer STT/TTS purpose from model IDs when catalog modalities omit transcription/speech. */

export function looksLikeTranscriptionModel(modelID: string) {
  if (!modelID.trim()) return false
  return (
    /(?:^|[-/])(asr|stt|transcrib(?:e|er|ing)|transcription|whisper|chirp|parakeet)(?:[-.:/]|$)/i.test(modelID) ||
    modelID === "mistralai/voxtral-small-24b-2507" ||
    modelID === "mistralai/voxtral-mini-3b-2507"
  )
}

export function looksLikeSpeechModel(modelID: string) {
  if (!modelID.trim()) return false
  return (
    /(?:^|[-/])(tts|text-to-speech)(?:[-.:/]|$)/i.test(modelID) ||
    /tts[-.]?\d/i.test(modelID)
  )
}

type AudioCapabilities = {
  input: { text?: boolean; audio?: boolean }
  output: { transcription?: boolean; speech?: boolean }
}

// These four fields are mutated, so a caller's literal false is not a valid
// return-type guarantee. Preserve other modalities and required/optional keys.
export function applyAudioPurposeCapabilities<T extends AudioCapabilities>(
  modelID: string,
  capabilities: T,
): Omit<T, "input" | "output"> & {
  input: { [K in keyof T["input"]]: K extends "text" | "audio" ? boolean : T["input"][K] } & AudioCapabilities["input"]
  output: {
    [K in keyof T["output"]]: K extends "transcription" | "speech" ? boolean : T["output"][K]
  } & AudioCapabilities["output"]
}
export function applyAudioPurposeCapabilities(modelID: string, capabilities: AudioCapabilities) {
  if (looksLikeTranscriptionModel(modelID)) {
    capabilities.input.audio = true
    capabilities.output.transcription = true
  }
  if (looksLikeSpeechModel(modelID)) {
    capabilities.input.text = true
    capabilities.output.speech = true
  }
  return capabilities
}
