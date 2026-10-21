import type { AnyRoute } from "@opencode-ai/llm/route"
import type { ProviderConnection, ProviderModel, ProviderStoredCredential } from "./provider.js"

export type NativeModelInput = {
  readonly model: ProviderModel
  readonly connection?: ProviderConnection
  readonly credential?: ProviderStoredCredential
  readonly transport?: { readonly oauthWebSocket?: boolean }
}

export type NativeModelFailure = { readonly error: { readonly apiID?: string; readonly reason: string; readonly message: string } }
/** Structural model output exchanged across provider/plugin package boundaries. */
export type NativeModelOutput = {
  readonly id: string
  readonly provider: string
  readonly route: AnyRoute
}
export type NativeModelIntegration = {
  resolve(input: NativeModelInput): NativeModelOutput | NativeModelFailure | undefined | Promise<NativeModelOutput | NativeModelFailure | undefined>
  /** Undefined keeps the generic catalog policy; a list restricts the fallback to these IDs. */
  smallModels?(input: NativeModelInput): readonly string[] | undefined
}

/** Common request data stays host-neutral; each provider selects its public transport. */
export function nativeRequest(model: ProviderModel, route: AnyRoute, namespace: string) {
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    generation: model.request.generation,
    providerOptions: Object.keys(model.request.options).length > 0 ? { [namespace]: model.request.options } : undefined,
    http: { body: Object.fromEntries(Object.entries(model.request.body).filter(([key]) => key !== "apiKey")) },
    limits: { context: model.limit.context, input: model.limit.input, output: model.limit.output },
  })
}

export function nativeCredential(input: NativeModelInput): { type: "value" | "env"; value: string } | undefined {
  const credential = input.credential?.value
  if (credential?.type === "key") return { type: "value", value: credential.key }
  if (credential?.type === "oauth") return { type: "value", value: credential.access }
  const key = input.model.request.body.apiKey ?? input.model.api.settings?.apiKey
  if (typeof key === "string") return { type: "value", value: key }
  if (input.connection?.type === "env") return { type: "env", value: input.connection.name }
}
