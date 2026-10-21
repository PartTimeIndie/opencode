import { looksLikeSpeechModel } from "@opencode-ai/core/audio-model-purpose"
import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import { mediaRegistry } from "@/plugin/media"
import { InstanceRef } from "@/effect/instance-ref"
import type { Adapter, AdapterInput, Input } from "./types"
import { SpeechError } from "./types"

export { SpeechError } from "./types"
export type { Adapter, AdapterInput, Format, Input, Result } from "./types"

export class Registry {
  constructor(private readonly adapters: readonly Adapter[]) {}

  supports(providerID: string, modelID: string) {
    return this.adapters.some((item) => item.providerID === providerID && item.supports(modelID))
  }

  speak(input: Omit<AdapterInput, "voice"> & { voice?: string }) {
    const adapter = this.adapters.find((item) => item.providerID === input.provider.id)
    if (!adapter)
      return Effect.fail(
        new SpeechError("unsupported_provider", `Text-to-speech is not available for ${input.provider.id}`),
      )
    if (!adapter.supports(input.modelID))
      return Effect.fail(
        new SpeechError("unsupported_model", `Unknown text-to-speech model ${input.provider.id}/${input.modelID}`),
      )
    const capabilities = adapter.capabilities?.(input.modelID)
    const voices = input.provider.models?.[input.modelID]?.supported_voices?.filter((voice) => voice.trim())
    const voice = [input.voice?.trim(), capabilities?.defaultVoice, voices?.[0]].find(
      (voice) => voice && (!voices?.length || voices.includes(voice)),
    )
    if (!voice)
      return Effect.fail(
        new SpeechError("missing_voice", `No compatible voice is available for ${input.provider.id}/${input.modelID}`),
      )
    return adapter.speak({
      ...input,
      voice,
      format: input.format ?? (capabilities?.formats?.includes("pcm") ? "pcm" : "mp3"),
    })
  }
}

function registry(directory: string) {
  return new Registry(mediaRegistry.list(directory).flatMap((adapter) => adapter.speech ? [{
    providerID: adapter.providerID, supports: adapter.speech.supports, capabilities: adapter.speech.capabilities,
    speak: (input: AdapterInput) => Effect.tryPromise({
      try: (signal) => adapter.speech!.speak({ ...input, signal: input.signal ? AbortSignal.any([input.signal, signal]) : signal }),
      catch: (error) => new SpeechError(error instanceof DOMException && error.name === "AbortError" ? "cancelled" : error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code as SpeechError["code"] : "provider_error", error instanceof Error ? error.message : "Speech failed"),
    }),
  }] : []))
}

export function supportsSpeechModel(
  model:
    | {
        capabilities: {
          input: { text: boolean }
          output: { speech?: boolean }
        }
      }
    | undefined,
) {
  return model?.capabilities.input.text === true && model.capabilities.output.speech === true
}

export const speak = Effect.fn("TTS.speak")(function* (input: Input) {
  const separator = input.model.indexOf("/")
  if (separator <= 0 || separator === input.model.length - 1)
    return yield* Effect.fail(new SpeechError("invalid_input", "Expected model as provider/model"))
  if (!input.text.trim()) return yield* Effect.fail(new SpeechError("invalid_input", "Speech text is empty"))

  const providerID = ProviderV2.ID.make(input.model.slice(0, separator))
  const modelID = input.model.slice(separator + 1)
  const service = yield* Provider.Service
  const info = input.provider ?? (yield* service.getProvider(providerID))
  const model = info.models?.[modelID]
  if (
    !model &&
    !(
      !Object.keys(info.models ?? {}).length &&
      (!info.source || info.source === "custom") &&
      ((typeof info.key === "string" && info.key.trim()) ||
        (typeof info.options.apiKey === "string" && info.options.apiKey.trim()))
    )
  )
    return yield* Effect.fail(
      new SpeechError("unsupported_model", `Unknown text-to-speech model ${providerID}/${modelID}`),
    )
  if (model && !supportsSpeechModel(model) && !looksLikeSpeechModel(modelID))
    return yield* Effect.fail(
      new SpeechError(
        "unsupported_model",
        `${providerID}/${modelID} does not declare text input and speech output capabilities`,
      ),
    )
  const instance = yield* InstanceRef
  return yield* registry(instance?.directory ?? process.cwd()).speak({ ...input, provider: info, modelID })
})

export function supportsAdapterModel(providerID: string, modelID: string, directory = process.cwd()) {
  return registry(directory).supports(providerID, modelID)
}
