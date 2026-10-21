import type { ModelMessage } from "ai"
import type { JSONSchema7, SharedV3ProviderOptions } from "@ai-sdk/provider"
import type { ProviderConfigurationModel, ProviderPluginModule, ProviderTransforms } from "@opencode-ai/plugin/provider"

export type RawProviderOptions = Record<string, unknown>
export type ProviderOptions = SharedV3ProviderOptions
export const OUTPUT_TOKEN_MAX = 32_000
const registration = Symbol("provider-transforms")
const registrations = new WeakMap<readonly ProviderPluginModule[], Partial<ProviderTransforms>>()
type BoundModel = ProviderConfigurationModel & {
  [registration]?: { rules: Partial<ProviderTransforms>; signal?: AbortSignal }
}

/** Per-instance rules survive model spreads but never enter JSON API responses. */
export function bindModel<T extends ProviderConfigurationModel>(
  model: T,
  modules: readonly ProviderPluginModule[],
  signal?: AbortSignal,
): T {
  const rules =
    registrations.get(modules) ??
    (Object.freeze(
      Object.assign({}, ...modules.flatMap((module) => (module.transforms ? [module.transforms] : []))),
    ) as Partial<ProviderTransforms>)
  registrations.set(modules, rules)
  Object.defineProperty(model, registration, { value: { rules, signal }, enumerable: true, configurable: true })
  return model
}

function rules(model: BoundModel) {
  model[registration]?.signal?.throwIfAborted()
  return model[registration]?.rules ?? {}
}

function publicModel(model: BoundModel): ProviderConfigurationModel {
  const input = { ...model }
  delete input[registration]
  return input
}

export function sanitizeSurrogates(content: string) {
  return content.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
}
export function message(messages: ModelMessage[], model: ProviderConfigurationModel, options: RawProviderOptions) {
  return rules(model).message?.(messages, publicModel(model), options) ?? messages
}
export function temperature(model: ProviderConfigurationModel) {
  return rules(model).temperature?.(publicModel(model))
}
export function topP(model: ProviderConfigurationModel) {
  return rules(model).topP?.(publicModel(model))
}
export function topK(model: ProviderConfigurationModel) {
  return rules(model).topK?.(publicModel(model))
}
export function variants(model: ProviderConfigurationModel) {
  return rules(model).variants?.(publicModel(model)) ?? {}
}
export function options(input: {
  model: ProviderConfigurationModel
  sessionID: string
  providerOptions?: RawProviderOptions
}) {
  return rules(input.model).options?.({ ...input, model: publicModel(input.model) }) ?? {}
}
export function smallOptions(model: ProviderConfigurationModel) {
  return rules(model).smallOptions?.(publicModel(model)) ?? {}
}
export function providerOptions(model: ProviderConfigurationModel, options: RawProviderOptions): ProviderOptions {
  return rules(model).providerOptions?.(publicModel(model), options) ?? {}
}
export function maxOutputTokens(model: ProviderConfigurationModel, maximum = OUTPUT_TOKEN_MAX) {
  return rules(model).maxOutputTokens?.(publicModel(model), maximum) ?? (Math.min(model.limit.output, maximum) || maximum)
}
export function chatMaxOutputTokens(model: ProviderConfigurationModel, maximum = OUTPUT_TOKEN_MAX) {
  const transform = rules(model).chatMaxOutputTokens
  return transform ? transform(publicModel(model), maximum) : maxOutputTokens(model, maximum)
}
export function schema(model: ProviderConfigurationModel, schema: JSONSchema7) {
  return rules(model).schema?.(publicModel(model), schema) ?? schema
}
export * as ProviderTransform from "./transform"
