import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { SessionActivityTable } from "@opencode-ai/core/session/sql"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

const state = Layer.effectDiscard(Effect.gen(function* () {
  yield* Effect.promise(() => resetDatabase())
  yield* Effect.addFinalizer(() => Effect.promise(async () => { await disposeAllInstances(); await resetDatabase() }))
}))
const it = testEffect(Layer.mergeAll(state, httpApiLayer))

describe("session attention HTTP summary", () => {
  it.live("requires the owning directory and counts only durable terminal results", () => Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const created = yield* HttpClientRequest.post("/api/session").pipe(
      HttpClientRequest.bodyJson({ location: { directory } }), Effect.flatMap(HttpClient.execute))
    expect(created.status).toBe(200)
    const { data } = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ id: SessionSchema.ID }) }))(yield* created.json)
    yield* Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(SessionActivityTable).values([
        { id: "http_done", session_id: data.id, kind: "prompt", status: "completed", closed_seq: 3 },
        { id: "http_stop", session_id: data.id, kind: "prompt", status: "interrupted", closed_seq: 4 },
      ]).run().pipe(Effect.orDie)
    }).pipe(Effect.provide(Database.defaultLayer))
    const url = `/session/${data.id}/attention-state?directory=${encodeURIComponent(directory)}&afterSeq=0`
    const ok = yield* HttpClient.execute(HttpClientRequest.get(url))
    expect(ok.status).toBe(200)
    expect((yield* ok.json)).toMatchObject({ count: 1, cursor: 4 })
    const bad = yield* HttpClient.execute(HttpClientRequest.get(`/session/${data.id}/attention-state?directory=${encodeURIComponent(directory)}&afterSeq=-1`))
    expect(bad.status).toBe(400)
    const foreign = yield* tmpdirScoped({ git: true })
    const denied = yield* HttpClient.execute(HttpClientRequest.get(`/session/${data.id}/attention-state?directory=${encodeURIComponent(foreign)}&afterSeq=0`))
    expect(denied.status).not.toBe(200)
    const missing = yield* HttpClient.execute(HttpClientRequest.get(`/session/${data.id}/attention-state?afterSeq=0`))
    expect(missing.status).not.toBe(200)
  }), 60_000)
})
