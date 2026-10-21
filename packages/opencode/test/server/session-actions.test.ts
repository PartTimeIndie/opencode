import { afterEach, describe, expect, mock } from "bun:test"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, httpApiLayer))

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
})

describe("session action routes", () => {
  it.instance(
    "session routes expose metadata on create, update, get, and fork",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "Content-Type": "application/json" }

        const created = yield* requestInDirectory("/session", test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "meta-session",
            metadata: { source: "sdk", trace: { id: "abc" } },
          }),
        })
        expect(created.status).toBe(200)

        const session = (yield* created.json) as SessionNs.Info
        expect(session.metadata).toEqual({ source: "sdk", trace: { id: "abc" } })

        const updated = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: { source: "sdk", trace: { id: "def" }, tags: ["one"] } }),
        })
        expect(updated.status).toBe(200)

        const next = (yield* updated.json) as SessionNs.Info
        expect(next.metadata).toEqual({ source: "sdk", trace: { id: "def" }, tags: ["one"] })

        const fetched = yield* requestInDirectory(`/session/${session.id}`, test.directory)
        expect(fetched.status).toBe(200)
        expect(((yield* fetched.json) as SessionNs.Info).metadata).toEqual(next.metadata)

        const forked = yield* requestInDirectory(`/session/${session.id}/fork`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(forked.status).toBe(200)

        const fork = (yield* forked.json) as SessionNs.Info
        expect(fork.metadata).toEqual(next.metadata)

        const reset = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: {} }),
        })
        expect(reset.status).toBe(200)
        expect(((yield* reset.json) as SessionNs.Info).metadata).toEqual({})

        yield* SessionNs.Service.use((svc) => svc.remove(fork.id).pipe(Effect.ignore))
        yield* SessionNs.Service.use((svc) => svc.remove(session.id).pipe(Effect.ignore))
      }),
    { git: true },
  )

  it.instance(
    "applies concurrent metadata patches without losing unrelated keys",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "Content-Type": "application/json" }
        const session = yield* SessionNs.use.create({ metadata: { existing: true } })

        const patchResponses = yield* Effect.all(
          [
            requestInDirectory(`/session/${session.id}`, test.directory, {
              method: "PATCH",
              headers,
              body: JSON.stringify({ metadataPatch: { set: { "opencode.session.goal": "ship it" } } }),
            }),
            requestInDirectory(`/session/${session.id}`, test.directory, {
              method: "PATCH",
              headers,
              body: JSON.stringify({ metadataPatch: { set: { access_control: { mode: "always" } } } }),
            }),
          ],
          { concurrency: 2 },
        )
        expect(patchResponses.map((response) => response.status)).toEqual([200, 200])

        const patched = yield* requestInDirectory(`/session/${session.id}`, test.directory)
        expect(((yield* patched.json) as SessionNs.Info).metadata).toEqual({
          existing: true,
          "opencode.session.goal": "ship it",
          access_control: { mode: "always" },
        })

        const unset = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadataPatch: { unset: ["opencode.session.goal"] } }),
        })
        expect(((yield* unset.json) as SessionNs.Info).metadata).toEqual({
          existing: true,
          access_control: { mode: "always" },
        })

        yield* SessionNs.use.remove(session.id).pipe(Effect.ignore)
      }),
    { git: true },
  )

  it.instance(
    "interrupts an idle v2 session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/api/session/${session.id}/interrupt`, test.directory, { method: "POST" })

        expect(res.status).toBe(204)
      }),
    { git: true },
  )

  it.instance(
    "experimental background route is a no-op without synchronous subagents",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/experimental/session/${session.id}/background`, test.directory, {
          method: "POST",
        })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(false)
      }),
    { git: true },
  )
})
