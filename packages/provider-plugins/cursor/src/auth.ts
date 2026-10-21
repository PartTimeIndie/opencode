import type { ProviderAuthMethod, ProviderCredential, ProviderHost } from "@opencode-ai/plugin/provider"

export const PACKAGE = "cursor-opencode-provider"
export const INTEGRATION_ID = "cursor"
export const OAUTH_METHOD_ID = "cursor-oauth"

import { tokenFromCredential } from "./credentials"
export { tokenFromCredential, applyToken } from "./credentials"

export async function importModule() {
  return import("./upstream/auth.js")
}

export const oauth: ProviderAuthMethod = {
  integrationID: INTEGRATION_ID,
  method: { id: OAUTH_METHOD_ID, type: "oauth", label: "Cursor account (browser login)" },
  async authorize(_inputs, signal) {
    signal.throwIfAborted()
    const auth = await importModule()
    const params = auth.generatePkceParams()
    const challenge = await auth.generatePkceChallenge(params.verifier)
    const callback = auth.pollForTokens(params.uuid, params.verifier, apiURL(), signal).then((tokens) => credential(auth, tokens))
    void callback.catch(() => {})
    return {
      mode: "auto",
      url: auth.buildLoginUrl(challenge, params.uuid, process.env.CURSOR_WEBSITE_URL ?? "https://cursor.com"),
      instructions: "Open this URL in a browser to sign in to Cursor",
      callback,
    }
  },
  async refresh(value, signal) {
    signal.throwIfAborted()
    const auth = await importModule()
    const tokens = await auth.refreshAccessToken(value.refresh, apiURL())
    signal.throwIfAborted()
    return credential(auth, tokens)
  },
}

export async function resolveAccessToken(api: Pick<ProviderHost, "integrations" | "credentials">) {
  const connection = await api.integrations.connection.forIntegration(INTEGRATION_ID)
  if (connection?.type === "credential") {
    const stored = await api.integrations.connection.credential(connection.id).catch(() => undefined)
    const token = tokenFromCredential(stored?.value)
    if (token) return token
  }
  return tokenFromCredential((await api.credentials.list(INTEGRATION_ID)).at(-1)?.value) ?? process.env.CURSOR_API_KEY
}

function credential(auth: Awaited<ReturnType<typeof importModule>>, tokens: { accessToken: string; refreshToken: string }): Extract<ProviderCredential, { type: "oauth" }> {
  return {
    type: "oauth",
    methodID: OAUTH_METHOD_ID,
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    expires: auth.decodeJwtExpiryMs(tokens.accessToken) ?? Date.now(),
  }
}

function apiURL() { return process.env.CURSOR_API_BASE_URL ?? "https://api2.cursor.sh" }
