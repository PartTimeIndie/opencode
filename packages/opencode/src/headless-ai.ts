import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AIChain } from "@opencode-ai/core/ai-chain"
import { ModelRequest } from "@opencode-ai/core/model-request"
import { streamObject, streamText, type FlexibleSchema, type ModelMessage } from "ai"
import { Cause, Context, Effect, Layer } from "effect"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { mergeDeep } from "remeda"
import { HeadlessAIChain } from "./headless-ai-chain"

type ExperimentalTelemetry = Parameters<typeof streamText>[0]["experimental_telemetry"]

type TextInput = {
  model?: string
  system?: string
  messages: ModelMessage[]
  generation?: ModelRequest.Generation
  options?: Record<string, unknown>
  variant?: string
  /**
   * Ordered model chain snapshot. Each step is tried exactly once in order and
   * only eligible transient provider/quota/empty-completion failures advance to
   * the next step; permanent failures fail closed so the configured order is
   * never silently bypassed.
   */
  chain?: AIChain.AIChainStep[]
  maxOutputTokens?: number
  maxRetries?: number
  returnAfter?: "sentence"
  abort?: AbortSignal
  metadata?: Record<string, unknown>
  telemetry?: ExperimentalTelemetry
  routingSessionID?: string
}

type ObjectInput = TextInput & {
  schema: FlexibleSchema<unknown>
}

export type TextResult = {
  text: string
  model: string
}

export type ObjectResult<T> = {
  object: T
  model: string
}

export interface Interface {
  readonly text: (input: TextInput) => Effect.Effect<TextResult, Error>
  readonly object: <T>(input: ObjectInput) => Effect.Effect<ObjectResult<T>, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/HeadlessAI") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service

    const resolve = Effect.fn("HeadlessAI.resolve")(function* (input: TextInput) {
      const ref = input.model ? Provider.parseModel(input.model) : yield* provider.defaultModel()
      const model = yield* provider.getModel(ref.providerID, ref.modelID)
      if (input.variant && !model.variants?.[input.variant])
        return yield* Effect.fail(new Error(`Model ${model.providerID}/${model.id} does not define variant ${input.variant}`))
      const language = yield* provider.getLanguage(model)
      return { model, language, key: `${model.providerID}/${model.id}` }
    })

    const providerOptions = (model: Provider.Model, input: TextInput) => {
      const base = ProviderTransform.options({
        model,
        sessionID: headlessSessionID(input),
        providerOptions: input.options,
      })
      const variant = input.variant ? model.variants?.[input.variant] : undefined
      const options = mergeDeep(mergeDeep(mergeDeep(base, model.options), variant ?? {}), input.options ?? {}) as Record<string, unknown>
      return Object.keys(options).length > 0 ? ProviderTransform.providerOptions(model, options) : undefined
    }

    const textModel = Effect.fn("HeadlessAI.text")(function* (input: TextInput, compatibilityRetry = true) {
      const resolved = yield* resolve(input)
      const run = (omitMaxOutputTokens: boolean) =>
        Effect.tryPromise({
          try: async () => {
            const maxOutputTokens = omitMaxOutputTokens
              ? undefined
              : ProviderTransform.chatMaxOutputTokens(resolved.model, input.generation?.maxTokens ?? input.maxOutputTokens)
            const result = streamText({
              model: resolved.language,
              headers: headlessHeaders(resolved.model, input),
              system: input.system,
              messages: input.messages,
              experimental_telemetry: input.telemetry,
              temperature: input.generation?.temperature ?? (resolved.model.capabilities.temperature ? ProviderTransform.temperature(resolved.model) : undefined),
              topP: input.generation?.topP,
              topK: input.generation?.topK,
              frequencyPenalty: input.generation?.frequencyPenalty,
              presencePenalty: input.generation?.presencePenalty,
              seed: input.generation?.seed,
              stopSequences: input.generation?.stop,
              maxOutputTokens,
              maxRetries: input.maxRetries,
              abortSignal: input.abort,
              providerOptions: providerOptions(resolved.model, input),
            })
            let text = ""
            for await (const part of result.fullStream) {
              if (part.type === "text-delta") text += part.text
              if (part.type === "text-delta" && input.returnAfter === "sentence") {
                const sentence = firstSentence(text)
                if (sentence) return sentence
              }
              if (part.type === "error") throw part.error
              if (part.type === "finish-step" && part.finishReason === "length") {
                throw new Error(
                  `Incomplete model response: output token budget exhausted (${maxOutputTokens ?? "provider default"} tokens; ` +
                  `${part.usage.outputTokenDetails.reasoningTokens ?? "unknown"} reasoning tokens). ` +
                  "Increase the output budget or select a lower reasoning variant.",
                )
              }
            }
            return text
          },
          catch: (error): Error => (error instanceof Error ? error : new Error(String(error))),
        })
      const result = yield* run(false).pipe(
        Effect.catchIf((error) => compatibilityRetry && unsupportedMaxOutputTokens(error), (error) =>
          Effect.logWarning("headless ai retrying without max_output_tokens", {
            model: resolved.key,
            metadata: input.metadata,
            error: errorDetails(error),
          }).pipe(Effect.flatMap(() => run(true))),
        ),
        Effect.tapCause((cause) =>
          Effect.logWarning("headless ai text generation failed", {
            model: resolved.key,
            metadata: input.metadata,
            messages: messageStats(input.messages),
            error: errorDetails(Cause.squash(cause)),
            cause: Cause.pretty(cause),
          }),
        ),
      )
      return { text: result, model: resolved.key }
    })

    const text = Effect.fn("HeadlessAI.text")(function* (input: TextInput) {
      const request = { ...input, routingSessionID: `headless:${crypto.randomUUID()}` }
      if (!request.chain?.length) return yield* textModel(request)
      return yield* HeadlessAIChain.runModelChain(
        request.chain,
        (step, signal) =>
          textModel(
            {
              ...request,
              model: `${step.providerID}/${step.modelID}`,
              variant: step.variant,
              chain: undefined,
              // The chain owns fallback; do not spend its deadline on hidden
              // SDK retries unless the caller explicitly requests them.
              maxRetries: request.maxRetries ?? 0,
              abort: signal,
            },
            false,
          ),
        { abort: request.abort, metadata: request.metadata },
      )
    })

    const objectModel = Effect.fn("HeadlessAI.object")(function* <T>(input: ObjectInput, compatibilityRetry = true) {
      const resolved = yield* resolve(input)
      const run = (omitMaxOutputTokens: boolean) =>
        Effect.tryPromise({
          try: async () => {
            const maxOutputTokens = omitMaxOutputTokens
              ? undefined
              : ProviderTransform.chatMaxOutputTokens(resolved.model, input.generation?.maxTokens ?? input.maxOutputTokens)
            const result = streamObject({
              model: resolved.language,
              headers: headlessHeaders(resolved.model, input),
              system: input.system,
              messages: input.messages,
              experimental_telemetry: input.telemetry,
              temperature: input.generation?.temperature,
              topP: input.generation?.topP,
              topK: input.generation?.topK,
              frequencyPenalty: input.generation?.frequencyPenalty,
              presencePenalty: input.generation?.presencePenalty,
              seed: input.generation?.seed,
              maxOutputTokens,
              maxRetries: input.maxRetries,
              abortSignal: input.abort,
              providerOptions: providerOptions(resolved.model, input),
              schema: input.schema,
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return (await result.object) as T
          },
          catch: (error): Error => (error instanceof Error ? error : new Error(String(error))),
        })
      const result = yield* run(false).pipe(
        Effect.catchIf((error) => compatibilityRetry && unsupportedMaxOutputTokens(error), (error) =>
          Effect.logWarning("headless ai retrying without max_output_tokens", {
            model: resolved.key,
            metadata: input.metadata,
            error: errorDetails(error),
          }).pipe(Effect.flatMap(() => run(true))),
        ),
        Effect.tapCause((cause) =>
          Effect.logWarning("headless ai object generation failed", {
            model: resolved.key,
            metadata: input.metadata,
            messages: messageStats(input.messages),
            error: errorDetails(Cause.squash(cause)),
            cause: Cause.pretty(cause),
          }),
        ),
      )
      return { object: result, model: resolved.key }
    })

    const object = Effect.fn("HeadlessAI.object")(function* <T>(input: ObjectInput) {
      const request = { ...input, routingSessionID: `headless:${crypto.randomUUID()}` }
      if (!request.chain?.length) return yield* objectModel<T>(request)
      return yield* HeadlessAIChain.runModelChain(
        request.chain,
        (step, signal) =>
          objectModel<T>(
            {
              ...request,
              model: `${step.providerID}/${step.modelID}`,
              variant: step.variant,
              chain: undefined,
              maxRetries: request.maxRetries ?? 0,
              abort: signal,
            },
            false,
          ),
        { abort: request.abort, metadata: request.metadata },
      )
    })

    return Service.of({ text, object })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Provider.defaultLayer))

export const node = LayerNode.make(layer, [Provider.node])

function headlessSessionID(input: TextInput) {
  const sessionID = input.metadata?.sessionID
  if (typeof sessionID === "string" && sessionID.trim()) return sessionID
  const kind = input.metadata?.kind
  if (typeof kind === "string" && kind.trim()) return `headless:${kind}`
  return "headless"
}

function headlessHeaders(model: Provider.Model, input: TextInput) {
  // OpenCode-hosted models require a session header even for plugin and other
  // headless requests, which have no persisted Session user message.
  if (!model.providerID.startsWith("opencode")) return undefined
  return {
    "x-opencode-session": typeof input.metadata?.sessionID === "string" && input.metadata.sessionID.trim()
      ? input.metadata.sessionID
      : input.routingSessionID ?? headlessSessionID(input),
    "x-opencode-client": "headless",
  }
}

function messageStats(messages: ModelMessage[]) {
  return {
    count: messages.length,
    characters: messages.reduce((total, message) => total + messageCharacters(message), 0),
  }
}

function messageCharacters(message: ModelMessage): number {
  if (typeof message.content === "string") return message.content.length
  if (!Array.isArray(message.content)) return 0
  return message.content.reduce((total, part) => total + ("text" in part && typeof part.text === "string" ? part.text.length : 0), 0)
}

function firstSentence(text: string) {
  const trimmed = text.trim()
  const match = trimmed.match(/^([\s\S]*?[.!?])(?:\s|$)/)
  return match?.[1]?.trim()
}

function errorDetails(error: unknown) {
  if (!(error instanceof Error)) return { message: String(error) }
  const detail = error as Error & { statusCode?: unknown; responseBody?: unknown; data?: unknown }
  return {
    name: error.name,
    message: error.message,
    statusCode: typeof detail.statusCode === "number" ? detail.statusCode : undefined,
    responseBody: typeof detail.responseBody === "string" ? truncate(detail.responseBody) : undefined,
    data: typeof detail.data === "string" ? truncate(detail.data) : undefined,
  }
}

function unsupportedMaxOutputTokens(error: Error) {
  const detail = error as Error & { responseBody?: unknown }
  return /unsupported parameter:\s*max_output_tokens/i.test(
    [error.message, typeof detail.responseBody === "string" ? detail.responseBody : ""].join("\n"),
  )
}

function truncate(value: string) {
  return value.length > 2_000 ? `${value.slice(0, 2_000)}...` : value
}

export * as HeadlessAI from "./headless-ai"
