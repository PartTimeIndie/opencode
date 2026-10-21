/** Media adapters use public data, streams and promises; credentials belong only to this provider call. */
export type MediaProvider = { id: string; options: Record<string, unknown>; key?: string }
export type SpeechFormat = "pcm" | "mp3"
export type SpeechInput = {
  provider: MediaProvider; modelID: string; text: string; voice: string; format?: SpeechFormat; speed?: number; signal?: AbortSignal
}
export type SpeechResult = {
  stream: ReadableStream<Uint8Array>; mimeType: string; format: SpeechFormat; voice: string;
  sampleRate?: number; channels?: number; providerID: string; modelID: string; generationID?: string
}
export type TranscriptionInput = {
  provider: MediaProvider; modelID: string; audio: Uint8Array; mimeType: string;
  language?: string; context?: string; signal?: AbortSignal; timeoutMs?: number
}
export type TranscriptionResult = { text: string; providerID: string; modelID: string }
export type MediaAdapters = {
  providerID: string
  speech?: {
    supports(modelID: string): boolean
    capabilities?(modelID: string): { formats?: readonly SpeechFormat[]; defaultVoice?: string }
    speak(input: SpeechInput): Promise<SpeechResult>
  }
  transcription?: {
    supports(modelID: string): boolean
    transcribe(input: TranscriptionInput): Promise<TranscriptionResult>
  }
}
