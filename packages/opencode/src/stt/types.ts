import type { Effect } from "effect"
import type { Provider } from "@/provider/provider"
import type { TranscriptionResult } from "@opencode-ai/plugin/media"

export type Input = {
  model: string
  audio: Uint8Array
  mimeType: string
  language?: string
  context?: string
  signal?: AbortSignal
  /** Remaining budget for this step of an explicit transcription chain. */
  timeoutMs?: number
  provider?: Provider.Info
  /** The protected host route already validated this model against a dedicated STT adapter. */
  allowUncataloguedModel?: boolean
}

export type Result = TranscriptionResult

export class TranscriptionError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "unsupported_provider"
      | "unsupported_model"
      | "missing_credentials"
      | "rate_limited"
      | "provider_error"
      | "timeout"
      | "cancelled",
    message: string,
  ) {
    super(message)
  }
}

export type AdapterInput = Omit<Input, "model"> & {
  provider: Provider.Info
  modelID: string
}

export interface Adapter {
  providerID: string
  supports(modelID: string): boolean
  transcribe(input: AdapterInput): Effect.Effect<Result, TranscriptionError>
}
