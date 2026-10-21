import { expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import { effectOAuth, oauthCredential } from "../src/effect-auth"

test("authorization resources remain open until callback settles and close on cancellation", async () => {
  const state = { open: 0 }
  const result = Effect.runSync(Deferred.make<ReturnType<typeof oauthCredential>>())
  const method = effectOAuth({
    integrationID: "neutral",
    method: { id: "browser", type: "oauth", label: "Browser" },
    authorize: () => Effect.gen(function* () {
      state.open++
      yield* Effect.addFinalizer(() => Effect.sync(() => { state.open-- }))
      return { mode: "auto" as const, url: "https://example.com/login", instructions: "Sign in", callback: Deferred.await(result) }
    }),
    refresh: Effect.succeed,
  })
  if (!("authorize" in method)) throw new Error("Expected OAuth")
  const controller = new AbortController()
  const attempt = await method.authorize({}, controller.signal)
  expect(state.open).toBe(1)
  controller.abort()
  if (attempt.mode !== "auto") throw new Error("Expected automatic callback")
  await expect(attempt.callback).rejects.toThrow()
  expect(state.open).toBe(0)

  const success = await method.authorize({}, new AbortController().signal)
  expect(state.open).toBe(1)
  Effect.runSync(Deferred.succeed(result, oauthCredential({ type: "oauth", methodID: "browser", access: "test", refresh: "test", expires: 100 })))
  if (success.mode !== "auto") throw new Error("Expected automatic callback")
  expect((await success.callback).type).toBe("oauth")
  expect(state.open).toBe(0)
})
