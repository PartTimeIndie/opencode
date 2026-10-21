import type {
  IntegrationAttempt,
  IntegrationInfo,
  IntegrationKeyMethod,
  IntegrationOAuthMethod,
  ProviderAuthAuthorization,
  ProviderAuthMethod,
} from "@opencode-ai/sdk/v2/client"

export type ConnectMethod = ProviderAuthMethod | IntegrationOAuthMethod | IntegrationKeyMethod
export type ConnectAuthorization = ProviderAuthAuthorization | IntegrationAttempt

export function connectMethods(
  integration: IntegrationInfo | undefined,
  legacy: ProviderAuthMethod[] | undefined,
  fallback: ProviderAuthMethod[],
): ConnectMethod[] {
  const current = integration?.methods.filter(
    (method): method is IntegrationOAuthMethod | IntegrationKeyMethod => method.type !== "env",
  )
  if (current?.length) return current
  return legacy ?? fallback
}

export function isIntegrationOAuth(method: ConnectMethod): method is IntegrationOAuthMethod {
  return method.type === "oauth" && "id" in method
}

export function isIntegrationKey(method: ConnectMethod | undefined): method is IntegrationKeyMethod {
  return method?.type === "key"
}

export function authorizationMode(authorization: ConnectAuthorization | undefined) {
  if (!authorization) return
  return "mode" in authorization ? authorization.mode : authorization.method
}

export function integrationAttemptID(authorization: ConnectAuthorization | undefined) {
  if (!authorization || !("attemptID" in authorization)) return
  return authorization.attemptID
}

/** Upper bound for connect metadata lookups; the server has no request timeout
 * and an instance left wedged by a dispose/reload would otherwise spin forever. */
export const CONNECT_METADATA_TIMEOUT_MS = 5_000

export function withConnectTimeout<T>(promise: Promise<T>, timeoutMs = CONNECT_METADATA_TIMEOUT_MS): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}
