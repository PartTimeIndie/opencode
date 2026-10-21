import type { ProviderAuthMethod, ProviderAuthorization, ProviderCredential } from "@opencode-ai/plugin/provider"
import { Effect, Exit, Scope } from "effect"

type OAuthCredential = Extract<ProviderCredential, { type: "oauth" }>
export type EffectOAuth = {
  integrationID: string
  method: Extract<ProviderAuthMethod, { authorize: unknown }>["method"]
  authorize(inputs: Record<string, string>): Effect.Effect<{
    mode: "auto"
    url: string
    instructions: string
    callback: Effect.Effect<OAuthCredential, unknown>
  }, unknown, Scope.Scope>
  refresh(value: OAuthCredential): Effect.Effect<OAuthCredential, unknown>
}

export function oauthCredential(value: OAuthCredential) { return value }

/** An authorization owns its callback listener until result, failure, or cancellation. */
export function effectOAuth(implementation: EffectOAuth): ProviderAuthMethod {
  return {
    integrationID: implementation.integrationID,
    method: implementation.method,
    async authorize(inputs, signal): Promise<ProviderAuthorization> {
      signal.throwIfAborted()
      const scope = Effect.runSync(Scope.make())
      const close = () => Effect.runPromise(Scope.close(scope, Exit.void))
      const abort = () => { void close() }
      signal.addEventListener("abort", abort, { once: true })
      const result = await Effect.runPromise(implementation.authorize(inputs).pipe(Scope.provide(scope)), { signal }).catch(async (error) => {
        signal.removeEventListener("abort", abort)
        await close()
        throw error
      })
      const callback = Effect.runPromise(result.callback, { signal }).finally(async () => {
        signal.removeEventListener("abort", abort)
        await close()
      })
      // The host may still be rendering the login URL when cancellation settles.
      void callback.catch(() => {})
      return { ...result, callback }
    },
    refresh: (value, signal) => Effect.runPromise(implementation.refresh(value), { signal }),
  }
}
