import type { Effect } from "effect"
import type { Provider } from "@/provider/provider"
import type { SpeechFormat, SpeechResult } from "@opencode-ai/plugin/media"

export type Format = SpeechFormat

export type Input = {
  model: string
  text: string
  voice?: string
  format?: Format
  speed?: number
  signal?: AbortSignal
  provider?: Provider.Info
}

export type Result = SpeechResult

export class SpeechError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "unsupported_provider"
      | "unsupported_model"
      | "missing_credentials"
      | "missing_voice"
      | "rate_limited"
      | "provider_error"
      | "timeout"
      | "cancelled",
    message: string,
  ) {
    super(message)
  }
}

export type AdapterInput = Omit<Input, "model" | "voice"> & {
  voice: string
  provider: Provider.Info
  modelID: string
}

export interface Adapter {
  providerID: string
  supports(modelID: string): boolean
  capabilities?(modelID: string): { formats?: readonly Format[]; defaultVoice?: string }
  speak(input: AdapterInput): Effect.Effect<Result, SpeechError>
}
