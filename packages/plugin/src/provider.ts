import type { LanguageModelV3, JSONSchema7, SharedV3ProviderOptions } from "@ai-sdk/provider"
import type { ModelMessage } from "ai"

/** Provider API 1 uses plain data and promises; no host service objects cross this boundary. */
export type ProviderAPI =
  | { type: "aisdk"; package: string; url?: string; settings?: Record<string, unknown> }
  | { type: "native"; url?: string; settings: Record<string, unknown> }

export type ProviderDefinition = {
  id: string
  name: string
  disabled?: boolean
  api: ProviderAPI
  request: { headers: Record<string, string>; body: Record<string, unknown> }
}

export type ProviderRequest = {
  headers: Record<string, string>
  body: Record<string, unknown>
  generation: {
    maxTokens?: number
    temperature?: number
    topP?: number
    topK?: number
    frequencyPenalty?: number
    presencePenalty?: number
    seed?: number
    stop?: string[]
  }
  options: Record<string, unknown>
}

export type ProviderModel = {
  id: string
  providerID: string
  family?: string
  name: string
  api: ProviderAPI & { id: string }
  capabilities: { tools: boolean; reasoning?: boolean; input: string[]; output: string[] }
  request: ProviderRequest & { variant?: string }
  variants: Array<ProviderRequest & { id: string }>
  /** UTC milliseconds since Unix epoch. */
  time: { released: number }
  cost: Array<{
    tier?: { type: "context"; size: number }
    input: number
    output: number
    cache: { read: number; write: number }
  }>
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
  limit: { context: number; input?: number; output: number }
}

export type ProviderCatalogRecord = { provider: ProviderDefinition; models: Map<string, ProviderModel> }
export type ProviderCatalogEditor = {
  provider: {
    list(): readonly ProviderCatalogRecord[]
    get(providerID: string): ProviderCatalogRecord | undefined
    update(providerID: string, update: (provider: ProviderDefinition) => void): void
    remove(providerID: string): void
  }
  model: {
    get(providerID: string, modelID: string): ProviderModel | undefined
    update(providerID: string, modelID: string, update: (model: ProviderModel) => void): void
    remove(providerID: string, modelID: string): void
    default: {
      get(): { providerID: string; modelID: string } | undefined
      set(providerID: string, modelID: string): void
    }
  }
}

export type ProviderOAuthCredential = {
  type: "oauth"
  methodID: string
  access: string
  refresh: string
  expires: number
  metadata?: Record<string, string>
}
export type ProviderCredential = ProviderOAuthCredential | {
  type: "key"
  key: string
  metadata?: Record<string, string>
}
export type ProviderStoredCredential = { id: string; integrationID: string; label: string; value: ProviderCredential }
export type ProviderConnection = { type: "credential"; id: string; label: string } | { type: "env"; name: string }
export type ProviderAuthPrompt = {
  key: string
  message: string
  when?: { key: string; op: "eq" | "neq"; value: string }
} & (
  | { type: "text"; placeholder?: string }
  | { type: "select"; options: Array<{ label: string; value: string; hint?: string }> }
)
export type ProviderAuthorization = { url: string; instructions: string } & (
  | { mode: "auto"; callback: Promise<ProviderCredential> }
  | { mode: "code"; callback: (code: string) => Promise<ProviderCredential> }
)
export type ProviderAuthMethod = {
  integrationID: string
} & (
  | {
      method: { id: string; type: "oauth"; label: string; prompts?: ProviderAuthPrompt[] }
      authorize(inputs: Readonly<Record<string, string>>, signal: AbortSignal): Promise<ProviderAuthorization>
      refresh?(credential: ProviderOAuthCredential, signal: AbortSignal): Promise<ProviderOAuthCredential>
    }
  | { method: { type: "key"; label?: string } }
  | { method: { type: "env"; names: string[] } }
)
export type ProviderIntegrationEditor = {
  update(id: string, update: (integration: { id: string; name: string }) => void): void
  method: { update(implementation: ProviderAuthMethod): void }
}

export type ProviderHost = {
  readonly app: { version: string }
  readonly lifecycle: {
    signal: AbortSignal
    onDispose(dispose: () => void | Promise<void>): () => void
  }
  readonly catalog: {
    /** The host removes the transform on unload. */
    transform(update: (editor: ProviderCatalogEditor) => void): Promise<void>
  }
  readonly credentials: {
    /** Limited to integrations declared by this plugin. */
    list(integrationID: string): Promise<ProviderStoredCredential[]>
  }
  readonly integrations: {
    /** Public catalogue metadata; credential values and mutations remain restricted to declared integration IDs. */
    get(id: string): Promise<{ id: string; name: string; connections: ProviderConnection[] } | undefined>
    /** Registers methods for this plugin's lifetime. */
    update(update: (editor: ProviderIntegrationEditor) => void): Promise<void>
    connection: {
      forIntegration(id: string): Promise<ProviderConnection | undefined>
      credential(id: string): Promise<ProviderStoredCredential | undefined>
    }
  }
  readonly cache: {
    readJSON(name: string): Promise<unknown>
    writeJSON(name: string, value: unknown): Promise<void>
  }
  readonly modules: { resolve(specifier: string): Promise<string> }
}

export type ProviderSDKEvent = {
  model: ProviderModel
  package: string
  options: Record<string, unknown>
  sdk?: unknown
}
export type ProviderLanguageEvent = {
  model: ProviderModel
  sdk: unknown
  options: Record<string, unknown>
  language?: LanguageModelV3
}
export type ProviderHooks = {
  "catalog.transform"?: (editor: ProviderCatalogEditor) => Promise<void>
  "aisdk.sdk"?: (event: ProviderSDKEvent) => Promise<void>
  "aisdk.language"?: (event: ProviderLanguageEvent) => Promise<void>
}
export type ProviderRequestProfile = {
  readonly namespace: string
  readonly semantics: Readonly<Record<string, string>>
}

export type ProviderPluginModule = {
  readonly nativeModels?: Readonly<Record<string, import("./native.js").NativeModelIntegration>>
  readonly requestProfiles?: Readonly<Record<string, ProviderRequestProfile>>
  id: string
  /** Integration IDs this package may register and read credentials for. */
  integrations?: readonly string[]
  provider(api: ProviderHost, options?: Readonly<Record<string, unknown>>): Promise<ProviderHooks | void>
  /** Optional discovery/configuration contribution for hosts using the public provider DTO projection. */
  configure?: (provider: ProviderConfigurationRecord, host: ProviderConfigurationHost) => Promise<ProviderConfigurationResult>
  /** SDK package factories owned and bundled by this provider package. */
  transports?: Record<string, (options: Record<string, unknown> & { name: string; baseURL?: string }) => Promise<ProviderTransport>>
  configureCatalog?: (catalog: ProviderConfigurationCatalog, host: ProviderConfigurationHost) => Promise<void>
  prepareTransport?: (model: ProviderConfigurationModel, options: Record<string, unknown>) => Promise<void>
  /** Pure request rules. Later packages override individual functions for a model. */
  transforms?: Partial<ProviderTransforms>
  modelDefaults?: (model: Pick<ProviderConfigurationModel, "id" | "providerID" | "api">) => Partial<ProviderConfigurationModel["capabilities"]>
  selectSmallModel?: (provider: ProviderConfigurationRecord) => string | undefined
}

export type ProviderTransforms = {
  message(messages: ModelMessage[], model: ProviderConfigurationModel, options: Record<string, unknown>): ModelMessage[]
  temperature(model: ProviderConfigurationModel): number | undefined
  topP(model: ProviderConfigurationModel): number | undefined
  topK(model: ProviderConfigurationModel): number | undefined
  variants(model: ProviderConfigurationModel): Record<string, Record<string, unknown>>
  options(input: { model: ProviderConfigurationModel; sessionID: string; providerOptions?: Record<string, unknown> }): Record<string, unknown>
  smallOptions(model: ProviderConfigurationModel): Record<string, unknown>
  providerOptions(model: ProviderConfigurationModel, options: Record<string, unknown>): SharedV3ProviderOptions
  maxOutputTokens(model: ProviderConfigurationModel, maximum?: number): number
  chatMaxOutputTokens(model: ProviderConfigurationModel, maximum?: number): number | undefined
  schema(model: ProviderConfigurationModel, schema: JSONSchema7): JSONSchema7
}

export type ProviderConfigurationHost = {
  readonly version: string
  readonly directory: string
  readonly signal: AbortSignal
  readonly cache: { readJSON(name: string): Promise<unknown> }
  sortModels<T extends { id: string }>(models: T[]): T[]
  auth(providerID: string): Promise<ProviderConfigurationCredential | undefined>
  config(): Promise<{ provider?: Record<string, { options?: Record<string, unknown> }> }>
  env(): Promise<Record<string, string | undefined>>
  get(key: string): Promise<string | undefined>
}

export type ProviderTransportMethods = {
  languageModel?: (modelID: string) => LanguageModelV3
  chat?: (modelID: string) => LanguageModelV3
  messages?: (modelID: string) => LanguageModelV3
  responses?: (modelID: string) => LanguageModelV3
  agenticChat?: (modelID: string, options?: { aiGatewayHeaders?: Record<string, string>; featureFlags?: Record<string, boolean> }) => LanguageModelV3
  workflowChat?: (modelID: string, options?: { featureFlags?: Record<string, boolean>; workflowDefinition?: string }) => LanguageModelV3 & { selectedModelRef?: string | null }
}
export type ProviderTransport = ProviderTransportMethods | (((modelID: string) => LanguageModelV3) & ProviderTransportMethods)
export type ProviderConfigurationResult = {
  autoload: boolean
  options?: Record<string, unknown>
  getModel?: (sdk: ProviderTransport, modelID: string, options?: Record<string, unknown>, model?: ProviderConfigurationModel) => Promise<LanguageModelV3>
  vars?: (options: Record<string, unknown>) => Record<string, string>
  discoverModels?: () => Promise<Record<string, ProviderConfigurationModel>>
  replaceDiscoveredModels?: boolean
}

export type ProviderConfigurationCredential =
  | { type: "api"; key: string; metadata?: Record<string, string>; enterpriseUrl?: string }
  | { type: "oauth"; access: string; refresh: string; expires: number; accountId?: string; enterpriseUrl?: string }
  | { type: "wellknown"; key: string; token: string }

export type ProviderConfigurationModel = {
  id: string
  providerID: string
  api: { id: string; url: string; npm: string; endpoint?: "responses" | "chat" }
  name: string
  family?: string
  capabilities: {
    temperature: boolean; reasoning: boolean; attachment: boolean; toolcall: boolean
    input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
    output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean; transcription?: boolean; speech?: boolean }
    interleaved: boolean | { field: "reasoning" | "reasoning_content" | "reasoning_details" } | string
  }
  cost: { input: number; output: number; cache: { read: number; write: number }; tiers?: Array<{ tier: { type: "context"; size: number }; input: number; output: number; cache: { read: number; write: number } }>; experimentalOver200K?: { input: number; output: number; cache: { read: number; write: number } } }
  limit: { context: number; input?: number; output: number }
  status: "alpha" | "beta" | "deprecated" | "active"
  options: Record<string, unknown>
  headers: Record<string, string>
  release_date: string
  supported_voices?: string[]
  variants?: Record<string, Record<string, unknown>>
}
export type ProviderConfigurationRecord = {
  id: string; name: string; source: "env" | "config" | "custom" | "api"; env: string[]; key?: string
  options: Record<string, unknown>
  models: Record<string, ProviderConfigurationModel>
}
export type ProviderConfigurationCatalog = {
  providers: Record<string, ProviderConfigurationRecord>
  modelLoaders: Record<string, NonNullable<ProviderConfigurationResult["getModel"]>>
  varsLoaders: Record<string, NonNullable<ProviderConfigurationResult["vars"]>>
  disabled: ReadonlySet<string>
}
