import type { ProviderCredential } from "@opencode-ai/plugin/provider"
import { effectOAuth, oauthCredential, type EffectOAuth } from "./effect-auth"

import { createServer } from "node:http"
import { Deferred, Effect, Schema } from "effect"

const defaultClientID = "1d89f9fdb23ee96d4e603201f6861dab6e143c5c3c00469a018a2d94bdc03d4e"
const defaultInstanceUrl = "https://gitlab.com"
const defaultCallbackPort = 8080

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})

type Pkce = {
  verifier: string
  challenge: string
}

export const methodID = "gitlab-oauth"

const implementation = {
  integrationID: "gitlab",
  method: {
    id: methodID,
    type: "oauth",
    label: "GitLab OAuth",
    prompts: [
      {
        type: "text",
        key: "instanceUrl",
        message: "GitLab instance URL",
        placeholder: defaultInstanceUrl,
      },
    ],
  },
  authorize: (inputs) =>
    Effect.gen(function* () {
      const instanceUrl = requireInstanceUrl(
        inputs.instanceUrl || process.env.GITLAB_INSTANCE_URL || defaultInstanceUrl,
      )
      const id = clientID()
      const pkce = yield* Effect.promise(generatePKCE)
      const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
      const code = yield* Deferred.make<string, Error>()
      const port = callbackPort()
      const redirect = `http://127.0.0.1:${port}/callback`
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", redirect)
        if (url.pathname !== "/callback") {
          response.writeHead(404).end("Not found")
          return
        }
        const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
        const value = url.searchParams.get("code")
        if (error) {
          Effect.runFork(Deferred.fail(code, new Error(error)))
          response.writeHead(400, { "Content-Type": "text/html" }).end(errorPage(error))
          return
        }
        if (!value || url.searchParams.get("state") !== state) {
          const message = value ? "Invalid OAuth state" : "Missing authorization code"
          Effect.runFork(Deferred.fail(code, new Error(message)))
          response.writeHead(400, { "Content-Type": "text/html" }).end(errorPage(message))
          return
        }
        Effect.runFork(Deferred.succeed(code, value))
        response.writeHead(200, { "Content-Type": "text/html" }).end(successPage)
      })
      yield* Effect.callback<void, Error>((resume) => {
        server.once("error", (error) => resume(Effect.fail(error)))
        server.listen(port, "127.0.0.1", () => resume(Effect.void))
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.close()
        }),
      )
      return {
        mode: "auto" as const,
        url: `${instanceUrl}/oauth/authorize?${new URLSearchParams({
          client_id: id,
          redirect_uri: redirect,
          response_type: "code",
          state,
          scope: "api",
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
        })}`,
        instructions: "Complete authorization in your browser. This window will close automatically.",
        callback: Deferred.await(code).pipe(
          Effect.flatMap((value) =>
            tokenRequest(instanceUrl, {
              client_id: id,
              code: value,
              grant_type: "authorization_code",
              redirect_uri: redirect,
              code_verifier: pkce.verifier,
            }),
          ),
          Effect.flatMap((tokens) => credential(tokens, instanceUrl, id)),
        ),
      }
    }),
  refresh: (value) => {
    const instanceUrl = requireCredentialInstanceUrl(value)
    const id = value.metadata?.clientID || clientID()
    return tokenRequest(instanceUrl, {
      client_id: id,
      refresh_token: value.refresh,
      grant_type: "refresh_token",
    }).pipe(Effect.flatMap((tokens) => credential(tokens, instanceUrl, id, value.refresh)))
  },
} satisfies EffectOAuth

export function normalizeInstanceUrl(value: unknown) {
  if (typeof value !== "string") return
  const raw = value.trim()
  if (!raw || !URL.canParse(raw)) return
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") return
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return
  return url.origin
}

export function requireInstanceUrl(value: unknown) {
  const result = normalizeInstanceUrl(value)
  if (result) return result
  throw new Error("GitLab instance URL must be an HTTP(S) origin without credentials, path, query, or fragment")
}

export function requireCredentialInstanceUrl(value: ProviderCredential) {
  const result = normalizeInstanceUrl(value.metadata?.instanceUrl ?? value.metadata?.enterpriseUrl)
  if (result) return result
  throw new Error("GitLab credential is missing valid instanceUrl metadata")
}

function tokenRequest(instanceUrl: string, body: Record<string, string>) {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${instanceUrl}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams(body).toString(),
        signal,
      })
      if (!response.ok) throw new Error(`GitLab OAuth request failed: ${response.status}`)
      return response.json()
    },
    catch: (cause) => cause,
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(TokenResponse)))
}

function credential(tokens: typeof TokenResponse.Type, instanceUrl: string, id: string, previousRefresh?: string) {
  const refresh = tokens.refresh_token ?? previousRefresh
  if (!refresh) return Effect.fail(new Error("GitLab OAuth response did not include a refresh token"))
  return Effect.succeed(
    oauthCredential({
      type: "oauth",
      methodID,
      access: tokens.access_token,
      refresh,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      metadata: { instanceUrl, clientID: id },
    }),
  )
}

async function generatePKCE(): Promise<Pkce> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)), (byte) => chars[byte % chars.length]).join("")
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function base64UrlEncode(buffer: ArrayBuffer) {
  return Buffer.from(buffer).toString("base64url")
}

function clientID() {
  return process.env.GITLAB_OAUTH_CLIENT_ID?.trim() || defaultClientID
}

function callbackPort() {
  const value = Number.parseInt(process.env.GITLAB_OAUTH_CALLBACK_PORT ?? "")
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : defaultCallbackPort
}

const successPage =
  "<!doctype html><title>OpenCode</title><h1>Authorization successful</h1><p>You can close this window.</p>"
const errorPage = (message: string) =>
  `<!doctype html><title>OpenCode</title><h1>Authorization failed</h1><p>${message.replace(/[&<>"']/g, "")}</p>`

export const oauth = effectOAuth(implementation)
