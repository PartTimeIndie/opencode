export * as SessionRunnerModel from "./model"

import type { NativeModelIntegration, NativeModelInput } from "@opencode-ai/plugin/native"
import type { ProviderModel } from "@opencode-ai/plugin/provider"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { LLMEvent, normalizeModelInput, type LLMRequest, Model } from "@opencode-ai/llm"
import { Auth, Protocol, Route, type AnyRoute } from "@opencode-ai/llm/route"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { produce } from "immer"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { IntegrationConnection } from "../../integration/connection"
import { ModelV2 } from "../../model"
import { ModelRequest } from "../../model-request"
import { PluginV2 } from "../../plugin"
import { PluginBoot } from "../../plugin/boot"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"
import { AISDK } from "../../aisdk"
import { SessionRunnerAISDK } from "./aisdk"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {}

export class NativeModelError extends Schema.TaggedErrorClass<NativeModelError>()(
  "SessionRunnerModel.NativeModelError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    apiID: ModelV2.ID,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * The pre-provider model resolve/init boundary (catalog select, credential,
 * AISDK/native plugin init) stalled past its deadline. With a configured chain
 * the runner advances to the next step; without one this fails the turn
 * terminally instead of heartbeating a running activity forever.
 */
export class ModelResolveTimeoutError extends Schema.TaggedErrorClass<ModelResolveTimeoutError>()(
  "SessionRunnerModel.ModelResolveTimeoutError",
  {
    sessionID: SessionSchema.ID,
    providerID: Schema.optional(ProviderV2.ID),
    modelID: Schema.optional(ModelV2.ID),
    timeoutMs: Schema.Number,
  },
) {}

export type Error =
  | Catalog.ProviderNotFoundError
  | Catalog.ModelNotFoundError
  | Integration.AuthorizationError
  | AISDK.InitError
  | ModelNotSelectedError
  | UnsupportedApiError
  | NativeModelError
  | ModelResolveTimeoutError

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>
  readonly resolveSmall: (session: SessionSchema.Info) => Effect.Effect<Option.Option<Model>, Error>
  readonly cost: (session: SessionSchema.Info) => Effect.Effect<ReadonlyArray<ModelV2.Cost>, Error>
  readonly capabilities: (session: SessionSchema.Info) => Effect.Effect<ModelV2.Capabilities, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (
  resolve: Interface["resolve"],
  resolveSmall?: Interface["resolveSmall"],
  cost?: Interface["cost"],
  capabilities?: Interface["capabilities"],
) =>
  Layer.succeed(
    Service,
    Service.of({
      resolve,
      resolveSmall: resolveSmall ?? (() => Effect.succeed(Option.none())),
      cost: cost ?? (() => Effect.succeed([])),
      capabilities: capabilities ?? (() => Effect.succeed({ tools: true, input: [], output: [] })),
    }),
  )

export type NativeModels = Readonly<Record<string, NativeModelIntegration>>
const requestPackages = new WeakMap<Model, string>()
const requestAdapters = new WeakMap<object, { readonly provider: string; readonly model: string }>()
export const requestPackage = (model: Model) => requestPackages.get(model)
// Bind identity to the actual transport closure, not the route label used for
// provider option routing. Route/default wrappers retain this transport object.
export const requestAdapter = (model: Model) => requestAdapters.get(model.route.transport)
function rememberPackage(model: Model, source: ModelV2.Info) {
  if (source.api.type === "aisdk") requestPackages.set(model, source.api.package)
  return model
}
function nativeInput(model: ModelV2.Info, connection?: IntegrationConnection.Info, credential?: Credential.Stored, transport?: NativeModelInput["transport"]): NativeModelInput {
  return {
    model: structuredClone(Schema.encodeSync(ModelV2.Info)(model)) as ProviderModel,
    connection: connection && { ...connection },
    credential: credential && structuredClone(Schema.encodeSync(Credential.Stored)(credential)),
    transport,
  }
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute, profiles: ModelRequest.Profiles) => {
  const options = model.request.options ?? {}
  const namespace = model.api.type === "aisdk" ? ModelRequest.namespace(model.api.package, profiles) : undefined
  const body = model.request.body
  const httpBody = Object.hasOwn(body, "apiKey")
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey"))
    : body
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    generation: model.request.generation,
    providerOptions: namespace && Object.keys(options).length > 0 ? { [namespace]: options } : undefined,
    http: { body: httpBody },
    limits: { context: model.limit.context, input: model.limit.input, output: model.limit.output },
  })
}

const withVariant = (model: ModelV2.Info, variantID: ModelV2.VariantID | undefined) => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant) return model
  return produce(model, (draft) => {
    ModelRequest.assign(draft.request, variant)
  })
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: ModelV2.Info,
  connection?: IntegrationConnection.Info,
  credential?: Credential.Stored,
  transport?: NativeModelInput["transport"],
  integrations: NativeModels = {},
): Effect.Effect<Model, UnsupportedApiError | NativeModelError> => Effect.gen(function* () {
  const resolved = credential?.value.type !== "key" || credential.value.metadata === undefined ? model : produce(model, (draft) => {
    Object.assign(draft.request.body, credential.value.metadata)
  })
  const packageID = resolved.api.type === "aisdk" ? resolved.api.package : ""
  const integration = Object.hasOwn(integrations, packageID) ? integrations[packageID] : undefined
  const result = yield* Effect.promise(async () => integration?.resolve(nativeInput(resolved, connection, credential, transport)))
  if (!result) return yield* new UnsupportedApiError({ providerID: resolved.providerID, modelID: resolved.id, api: apiName(resolved) })
  if ("error" in result) return yield* new NativeModelError({
    providerID: resolved.providerID, modelID: resolved.id, apiID: ModelV2.ID.make(result.error.apiID ?? resolved.api.id),
    reason: result.error.reason, message: result.error.message,
  })
  return rememberPackage(normalizeModelInput(result), resolved)
})

export const resolve = (session: SessionSchema.Info, model: ModelV2.Info, nativeModels: NativeModels) =>
  fromCatalogModel(withVariant(model, session.model?.variant), undefined, undefined, undefined, nativeModels)

export const supported = (model: ModelV2.Info) =>
  model.api.type === "aisdk"

export const fromAISDKModel = (model: ModelV2.Info, language: LanguageModelV3, profiles: ModelRequest.Profiles = {}) => {
  type AISDKFrame = unknown
  type AISDKEvent = Schema.Schema.Type<typeof LLMEvent>
  const protocol = Protocol.make<unknown, AISDKFrame, AISDKEvent, undefined>({
    id: "aisdk",
    runtimeContext: SessionRunnerAISDK.supportsRuntimeContext(language) ? "late-system" : undefined,
    body: {
      schema: Schema.Unknown,
      from: (request) => Effect.succeed(request),
    },
    stream: {
      // The AI SDK adapter emits decoded LLM events, including Usage instances.
      event: Schema.toType(LLMEvent),
      initial: () => undefined,
      step: (state, event) => Effect.succeed([state, [event]] as const),
    },
  })
  const route = Route.make<unknown, LLMRequest, AISDKFrame, AISDKEvent, undefined>({
    id: `aisdk:${model.api.type === "aisdk" ? model.api.package : model.api.type}`,
    protocol,
    endpoint: { baseURL: model.api.url ?? "aisdk://local", path: "" },
    auth: Auth.none,
    defaults: {},
    transport: {
      id: "aisdk",
      prepare: ({ request }: { readonly request: LLMRequest }) => Effect.succeed(request),
      frames: (_prepared: LLMRequest, request: LLMRequest) => SessionRunnerAISDK.stream(language, request),
    },
  })
  requestAdapters.set(route.transport, Object.freeze({ provider: language.provider, model: language.modelId }))
  return rememberPackage(withDefaults(model, route, profiles).model({ id: model.id }), model)
}

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const aisdk = yield* Effect.serviceOption(AISDK.Service)
    const boot = yield* PluginBoot.Service
    const plugins = Option.getOrUndefined(yield* Effect.serviceOption(PluginV2.Service))
    const selectedModel = Effect.fn("SessionRunnerModel.selectedModel")(function* (session: SessionSchema.Info) {
      yield* boot.wait()
      const requested = session.model
        ? yield* catalog.model.get(session.model.providerID, session.model.id)
        : undefined
      const selected =
        requested && supported(requested)
          ? requested
          : (Option.getOrUndefined((yield* catalog.model.default()).pipe(Option.filter(supported))) ??
            (yield* catalog.model.available()).find(supported))
      if (session.model && requested && !supported(requested)) {
        yield* Effect.logWarning("session model is not natively supported; using a catalog fallback", {
          sessionID: session.id,
          providerID: session.model.providerID,
          modelID: session.model.id,
        })
      }
      if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
      return selected
    })

    const toModel = Effect.fn("SessionRunnerModel.toModel")(function* (
      session: SessionSchema.Info,
      selected: ModelV2.Info,
      inheritVariant = true,
      oauthWebSocket = process.env.OPENCODE_EXPERIMENTAL_OAUTH_WEBSOCKET === "1",
    ) {
      const connection = yield* integrations.connection.forIntegration(Integration.ID.make(selected.providerID))
      const resolved = withVariant(selected, inheritVariant ? session.model?.variant : undefined)
      const nativeModels = plugins?.nativeModels() ?? {}
      const packageID = resolved.api.type === "aisdk" ? resolved.api.package : ""
      const credential = connection?.type === "credential" ? yield* integrations.connection.credential(connection.id) : undefined
      if (Object.hasOwn(nativeModels, packageID)) {
        const native = yield* fromCatalogModel(resolved, connection, credential, { oauthWebSocket }, nativeModels).pipe(Effect.result)
        if (native._tag === "Success") return native.success
        if (!(native.failure instanceof UnsupportedApiError)) return yield* native.failure
      }
      if (Option.isNone(aisdk)) return yield* new UnsupportedApiError({ providerID: resolved.providerID, modelID: resolved.id, api: apiName(resolved) })
      return fromAISDKModel(resolved, yield* aisdk.value.language(resolved, credential), plugins?.requestProfiles())
    })

    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        return yield* toModel(session, yield* selectedModel(session))
      }),
      resolveSmall: Effect.fn("SessionRunnerModel.resolveSmall")(function* (session) {
        const selected = yield* selectedModel(session)
        const connection = yield* integrations.connection.forIntegration(Integration.ID.make(selected.providerID))
        const credential =
          connection?.type === "credential" ? yield* integrations.connection.credential(connection.id) : undefined
        const packageID = selected.api.type === "aisdk" ? selected.api.package : ""
        const nativeModels = plugins?.nativeModels() ?? {}
        const integration = Object.hasOwn(nativeModels, packageID) ? nativeModels[packageID] : undefined
        const preferences = integration?.smallModels?.(nativeInput(selected, connection, credential))
        const small = preferences ? Option.firstSomeOf(
          yield* Effect.forEach(preferences, (id) => catalog.model.get(selected.providerID, ModelV2.ID.make(id)).pipe(
            Effect.option, Effect.map(Option.filter((model) => model.enabled && supported(model))),
          )),
        ) : yield* catalog.model.small(selected.providerID).pipe(Effect.map(Option.filter(supported)))
        if (Option.isNone(small)) return Option.some(yield* toModel(session, selected, true, false))
        return Option.some(yield* toModel(session, small.value, false, false))
      }),
      cost: Effect.fn("SessionRunnerModel.cost")(function* (session) {
        return withVariant(yield* selectedModel(session), session.model?.variant).cost
      }),
      capabilities: Effect.fn("SessionRunnerModel.capabilities")(function* (session) {
        return withVariant(yield* selectedModel(session), session.model?.variant).capabilities
      }),
    })
  }),
)
