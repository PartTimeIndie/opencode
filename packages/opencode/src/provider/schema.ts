import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { optionalOmitUndefined } from "@opencode-ai/core/schema"
import { Schema, Types } from "effect"
import { ModelStatus } from "./model-status"

const ProviderApiInfo = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  npm: Schema.String,
  endpoint: optionalOmitUndefined(Schema.Literals(["responses", "chat"])),
})

const ProviderInputModalities = Schema.Struct({
  text: Schema.Boolean,
  audio: Schema.Boolean,
  image: Schema.Boolean,
  video: Schema.Boolean,
  pdf: Schema.Boolean,
})

const ProviderOutputModalities = Schema.Struct({
  text: Schema.Boolean,
  audio: Schema.Boolean,
  image: Schema.Boolean,
  video: Schema.Boolean,
  pdf: Schema.Boolean,
  transcription: optionalOmitUndefined(Schema.Boolean),
  speech: optionalOmitUndefined(Schema.Boolean),
})

const ProviderInterleaved = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]),
  }),
])

const ProviderCapabilities = Schema.Struct({
  temperature: Schema.Boolean,
  reasoning: Schema.Boolean,
  attachment: Schema.Boolean,
  toolcall: Schema.Boolean,
  input: ProviderInputModalities,
  output: ProviderOutputModalities,
  interleaved: ProviderInterleaved,
})

const ProviderCacheCost = Schema.Struct({
  read: Schema.Finite,
  write: Schema.Finite,
})

const ProviderCostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const ProviderCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tiers: optionalOmitUndefined(Schema.Array(ProviderCostTier)),
  experimentalOver200K: optionalOmitUndefined(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache: ProviderCacheCost,
    }),
  ),
})

const ProviderLimit = Schema.Struct({
  context: Schema.Finite,
  input: optionalOmitUndefined(Schema.Finite),
  output: Schema.Finite,
})

export const Model = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  api: ProviderApiInfo,
  name: Schema.String,
  family: optionalOmitUndefined(Schema.String),
  capabilities: ProviderCapabilities,
  cost: ProviderCost,
  limit: ProviderLimit,
  status: ModelStatus,
  options: Schema.Record(Schema.String, Schema.Any),
  headers: Schema.Record(Schema.String, Schema.String),
  release_date: Schema.String,
  supported_voices: optionalOmitUndefined(Schema.Array(Schema.String)),
  variants: optionalOmitUndefined(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Any))),
}).annotate({ identifier: "Model" })
export type Model = Types.DeepMutable<Schema.Schema.Type<typeof Model>>

export const Info = Schema.Struct({
  id: ProviderV2.ID,
  name: Schema.String,
  source: Schema.Literals(["env", "config", "custom", "api"]),
  env: Schema.Array(Schema.String),
  key: optionalOmitUndefined(Schema.String),
  options: Schema.Record(Schema.String, Schema.Any),
  models: Schema.Record(Schema.String, Model),
}).annotate({ identifier: "Provider" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

const DefaultModelIDs = Schema.Record(Schema.String, Schema.String)

export const ListResult = Schema.Struct({
  all: Schema.Array(Info),
  default: DefaultModelIDs,
  connected: Schema.Array(Schema.String),
})
export type ListResult = Types.DeepMutable<Schema.Schema.Type<typeof ListResult>>

export const ConfigProvidersResult = Schema.Struct({
  providers: Schema.Array(Info),
  default: DefaultModelIDs,
})
export type ConfigProvidersResult = Types.DeepMutable<Schema.Schema.Type<typeof ConfigProvidersResult>>

export class ModelNotFoundError extends Schema.TaggedErrorClass<ModelNotFoundError>()("ProviderModelNotFoundError", {
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  suggestions: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect),
}) {
  static isInstance(input: unknown): input is ModelNotFoundError {
    return input instanceof ModelNotFoundError
  }
}

export class InitError extends Schema.TaggedErrorClass<InitError>()("ProviderInitError", {
  providerID: ProviderV2.ID,
  cause: Schema.optional(Schema.Defect),
}) {
  static isInstance(input: unknown): input is InitError {
    return input instanceof InitError
  }
}

export class NoProvidersError extends Schema.TaggedErrorClass<NoProvidersError>()("ProviderNoProvidersError", {}) {
  static isInstance(input: unknown): input is NoProvidersError {
    return input instanceof NoProvidersError
  }
}

export class NoModelsError extends Schema.TaggedErrorClass<NoModelsError>()("ProviderNoModelsError", {
  providerID: ProviderV2.ID,
}) {
  static isInstance(input: unknown): input is NoModelsError {
    return input instanceof NoModelsError
  }
}

export type DefaultModelError = ModelNotFoundError | NoProvidersError | NoModelsError
export type Error = ModelNotFoundError | InitError | NoProvidersError | NoModelsError
