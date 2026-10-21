import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import { mediaRegistry } from "@/plugin/media"
import { InstanceRef } from "@/effect/instance-ref"
import type { Adapter, AdapterInput, Input } from "./types"
import { TranscriptionError } from "./types"

export { TranscriptionError } from "./types"
export type { Adapter, AdapterInput, Input, Result } from "./types"

export class Registry {
  constructor(private readonly adapters: readonly Adapter[]) {}

  supports(providerID: string, modelID: string) {
    return this.adapters.some((item) => item.providerID === providerID && item.supports(modelID))
  }

  transcribe(input: AdapterInput) {
    const adapter = this.adapters.find((item) => item.providerID === input.provider.id)
    if (!adapter)
      return Effect.fail(
        new TranscriptionError(
          "unsupported_provider",
          `Speech transcription is not available for ${input.provider.id}`,
        ),
      )
    if (!adapter.supports(input.modelID))
      return Effect.fail(
        new TranscriptionError("unsupported_model", `Unknown transcription model ${input.provider.id}/${input.modelID}`),
      )
    return adapter.transcribe(input)
  }
}

function adapters(directory: string) {
  return new Registry(mediaRegistry.list(directory).flatMap((adapter) => adapter.transcription ? [{
    providerID: adapter.providerID, supports: adapter.transcription.supports,
    transcribe: (input: AdapterInput) => Effect.tryPromise({
      try: (signal) => adapter.transcription!.transcribe({ ...input, signal: input.signal ? AbortSignal.any([input.signal, signal]) : signal }),
      catch: (error) => new TranscriptionError(error instanceof DOMException && error.name === "AbortError" ? "cancelled" : error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code as TranscriptionError["code"] : "provider_error", error instanceof Error ? error.message : "Transcription failed"),
    }),
  }] : []))
}

export function supportsTranscriptionModel(
  model:
    | {
        capabilities: {
          input: { audio: boolean }
          output: { transcription?: boolean }
        }
      }
    | undefined,
) {
  return model?.capabilities.input.audio === true && model.capabilities.output.transcription === true
}

export const transcribe = Effect.fn("STT.transcribe")(function* (input: Input) {
  const separator = input.model.indexOf("/")
  if (separator <= 0 || separator === input.model.length - 1)
    return yield* Effect.fail(new TranscriptionError("invalid_input", "Expected model as provider/model"))
  if (!input.audio.byteLength) return yield* Effect.fail(new TranscriptionError("invalid_input", "Audio is empty"))

  const providerID = ProviderV2.ID.make(input.model.slice(0, separator))
  const modelID = input.model.slice(separator + 1)
  const service = yield* Provider.Service
  const instance = yield* InstanceRef
  const registry = adapters(instance?.directory ?? process.cwd())
  const info = input.provider ?? (yield* service.getProvider(providerID))
  const model = info.models?.[modelID]
  if (
    !model &&
    !(input.allowUncataloguedModel && registry.supports(providerID, modelID)) &&
    !(
      (!info.source || info.source === "custom") &&
      ((typeof info.key === "string" && info.key.trim()) ||
        (typeof info.options.apiKey === "string" && info.options.apiKey.trim()))
    )
  )
    return yield* Effect.fail(
      new TranscriptionError("unsupported_model", `Unknown transcription model ${providerID}/${modelID}`),
    )
  if (model && !supportsTranscriptionModel(model) && !registry.supports(providerID, modelID))
    return yield* Effect.fail(
      new TranscriptionError(
        "unsupported_model",
        `${providerID}/${modelID} does not declare audio input and transcription output capabilities`,
      ),
    )
  return yield* registry.transcribe({ ...input, provider: info, modelID })
})

export function supportsAdapterModel(providerID: string, modelID: string, directory = process.cwd()) {
  return adapters(directory).supports(providerID, modelID)
}
