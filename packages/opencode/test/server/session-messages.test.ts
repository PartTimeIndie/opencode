import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { CrashActivity } from "@opencode-ai/core/observability/crash-activity"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"

import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Database } from "@opencode-ai/core/database/database"
import { SessionArchiveCatalogTable, SessionArchiveJournalTable } from "@opencode-ai/core/archive.sql"
import { SessionArchive } from "@opencode-ai/core/session-archive"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Global } from "@opencode-ai/core/global"
import { eq, sql } from "drizzle-orm"
import path from "path"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(Database.defaultLayer, SessionNs.defaultLayer, httpApiLayer))

const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test"),
}

afterEach(async () => {
  await disposeAllInstances()
})

const withoutWatcher = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  if (process.platform !== "win32") return effect
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
      process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
        else process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = previous
      }),
  )
}

const sessionScoped = Effect.acquireRelease(SessionNs.use.create({}), (session) =>
  SessionNs.use.remove(session.id).pipe(Effect.ignore),
)

const fill = Effect.fn("SessionMessagesTest.fill")(function* (
  sessionID: SessionID,
  count: number,
  time = (i: number) => Date.now() + i,
) {
  const session = yield* SessionNs.Service
  return yield* Effect.forEach(
    Array.from({ length: count }, (_, i) => i),
    (i) =>
      Effect.gen(function* () {
        const id = MessageID.ascending()
        yield* session.updateMessage({
          id,
          sessionID,
          role: "user",
          time: { created: time(i) },
          agent: "test",
          model,
          tools: {},
        } satisfies SessionV1.User)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: `m${i}`,
        } satisfies SessionV1.TextPart)
        return id
      }),
  )
})

function request(path: string, init?: RequestInit) {
  return TestInstance.pipe(Effect.flatMap((test) => requestInDirectory(path, test.directory, init)))
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((body) => body as T))
}

describe("session messages endpoint", () => {
  it.instance("returns the persisted model chain from the session endpoint", () =>
    Effect.gen(function* () {
      const chain = {
        id: "luna-free-qa",
        name: "Luna Free QA",
        active: 0,
        steps: [
          {
            id: ModelV2.ID.make("gpt-5.6-luna"),
            providerID: ProviderV2.ID.make("openai"),
            variant: ModelV2.VariantID.make("high"),
          },
          { id: ModelV2.ID.make("openrouter/free"), providerID: ProviderV2.ID.make("openrouter") },
        ],
      }
      const session = yield* Effect.acquireRelease(
        SessionNs.use.create({
          model: {
            id: ModelV2.ID.make("gpt-5.6-luna"),
            providerID: ProviderV2.ID.make("openai"),
            variant: ModelV2.VariantID.make("high"),
            chain,
          },
        }),
        (created) => SessionNs.use.remove(created.id).pipe(Effect.ignore),
      )

      const response = yield* request(`/session/${session.id}`)
      expect(response.status).toBe(200)
      expect((yield* json<SessionNs.Info>(response)).model?.chain).toEqual(chain)
    }),
  )

  it.instance(
    "keeps archived sessions visible and pages them without reactivation before the next prompt",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 170, (index: number) => 1_000 + index)
        const database = yield* Database.Service
        yield* database.db
          .insert(SessionMessageTable)
          .values(
            Array.from({ length: 170 }, (_, index) => ({
              id: SessionMessage.ID.make(`msg_v2_archive_${index.toString().padStart(3, "0")}`),
              session_id: session.id,
              type: "user" as const,
              seq: index,
              time_created: 1_000 + index,
              time_updated: 1_000 + index,
              data: { text: `v2-${index}`, time: { created: 1_000 + index } },
            })),
          )
          .run()
          .pipe(Effect.orDie)
        yield* database.db
          .update(SessionTable)
          .set({ time_updated: 1_200 })
          .where(eq(SessionTable.id, session.id))
          .run()
          .pipe(Effect.orDie)
        yield* database.db.run(sql`UPDATE message SET time_created = 1200, time_updated = 1200 WHERE session_id = ${session.id}`)
        yield* database.db.run(sql`UPDATE part SET time_created = 1200, time_updated = 1200 WHERE session_id = ${session.id}`)
        const archive = yield* SessionArchive.make({
          directory: path.join(Global.Path.data, "archives"),
          inactiveMs: 0,
          now: () => 2_000,
          isIdle: () => Effect.succeed(true),
        })
        yield* archive.initialize
        yield* archive.refreshCatalog(session.id)
        expect((yield* archive.archiveOne(session.id))?.sessionID).toBe(session.id)
        expect(yield* archive.getCatalog(session.id)).toMatchObject({
          sessionID: session.id,
          directory: (yield* TestInstance).directory.replaceAll("\\", "/"),
          location: "archived",
        })
        expect((yield* SessionNs.Service.use((service) => service.list({ limit: 200 }))).map((item) => item.id)).toContain(
          session.id,
        )
        expect(
          (yield* SessionNs.Service.use((service) => service.listGlobal({ limit: 200 }))).map((item) => item.id),
        ).toContain(session.id)

        const listed = yield* request(`/session?directory=${encodeURIComponent((yield* TestInstance).directory)}&limit=200`)
        expect(listed.status).toBe(200)
        expect((yield* json<Array<{ id: string }>>(listed)).map((item) => item.id)).toContain(session.id)
        const fetched = yield* request(`/session/${session.id}`)
        expect(fetched.status).toBe(200)
        expect((yield* json<{ id: string }>(fetched)).id).toBe(session.id)
        const v2Fetched = yield* request(`/api/session/${session.id}`)
        expect(v2Fetched.status).toBe(200)
        const v2Page = yield* request(`/api/session/${session.id}/message?limit=80`)
        expect(v2Page.status).toBe(200)
        expect((yield* json<{ data: SessionMessage.Message[] }>(v2Page)).data).toHaveLength(80)

        const first = yield* request(`/session/${session.id}/message?limit=80`)
        expect(first.status).toBe(200)
        expect((yield* json<SessionV1.WithParts[]>(first)).map((item) => item.info.id)).toEqual(ids.slice(-80))
        const second = yield* request(
          `/session/${session.id}/message?limit=80&before=${encodeURIComponent(first.headers["x-next-cursor"]!)}`,
        )
        expect(second.status).toBe(200)
        expect((yield* json<SessionV1.WithParts[]>(second)).map((item) => item.info.id)).toEqual(ids.slice(10, 90))
        const deepLink = yield* request(`/session/${session.id}/message/${ids[20]}`)
        expect(deepLink.status).toBe(200)
        expect((yield* json<SessionV1.WithParts>(deepLink)).parts).toMatchObject([{ text: "m20" }])
        expect(
          yield* database.db
            .select({ location: SessionArchiveCatalogTable.location })
            .from(SessionArchiveCatalogTable)
            .where(eq(SessionArchiveCatalogTable.session_id, session.id))
            .get(),
        ).toEqual({ location: "archived" })
        expect(yield* database.db.get(sql`SELECT id FROM session WHERE id = ${session.id}`)).toBeUndefined()

        for (const [id, delivery] of [
          ["msg_archive_queue", "queue"],
          ["msg_archive_steer", "steer"],
        ] as const) {
          const response = yield* request(`/api/session/${session.id}/prompt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id, prompt: { text: delivery }, delivery, resume: false }),
          })
          expect(response.status).toBe(200)
        }
        expect(
          yield* database.db
            .select({ location: SessionArchiveCatalogTable.location })
            .from(SessionArchiveCatalogTable)
            .where(eq(SessionArchiveCatalogTable.session_id, session.id))
            .get(),
        ).toEqual({ location: "active" })
        expect(
          yield* database.db
            .select({ count: sql<number>`count(*)` })
            .from(SessionArchiveJournalTable)
            .where(
              sql`${SessionArchiveJournalTable.session_id} = ${session.id} AND ${SessionArchiveJournalTable.operation} = 'reactivate'`,
            )
            .get(),
        ).toEqual({ count: 1 })
      }),
    ),
    { git: true },
    45_000,
  )

  it.instance(
    "returns cursor headers for older pages",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 5)

        const a = yield* request(`/session/${session.id}/message?limit=2`)
        expect(a.status).toBe(200)
        const aBody = yield* json<SessionV1.WithParts[]>(a)
        expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
        const cursor = a.headers["x-next-cursor"]
        expect(cursor).toBeTruthy()
        expect(a.headers["link"]).toContain('rel="next"')

        const b = yield* request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor!)}`)
        expect(b.status).toBe(200)
        const bBody = yield* json<SessionV1.WithParts[]>(b)
        expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))
      }),
    ),
    { git: true },
  )

  it.instance(
    "keeps full-history responses when limit is omitted",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 3)

        const res = yield* request(`/session/${session.id}/message`)
        expect(res.status).toBe(200)
        const body = yield* json<SessionV1.WithParts[]>(res)
        expect(body.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
    { git: true },
  )

  it.instance(
    "rejects invalid cursors and missing sessions",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped

        const bad = yield* request(`/session/${session.id}/message?limit=2&before=bad`)
        expect(bad.status).toBe(400)

        const miss = yield* request(`/session/ses_missing/message?limit=2`)
        expect(miss.status).toBe(404)
      }),
    ),
    { git: true },
  )

  it.instance(
    "reads messages from a deleted session directory but rejects prompts with an actionable stale-location error",
    withoutWatcher(
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* sessionScoped
        const directory = path.join(tmp.directory, "deleted-worktree")
        const database = yield* Database.Service
        yield* database.db
          .insert(SessionMessageTable)
          .values([
            {
              id: SessionMessage.ID.create(),
              session_id: session.id,
              type: "user",
              seq: 1,
              time_created: 1,
              time_updated: 1,
              data: { text: "still readable", time: { created: 1 } } as NonNullable<
                (typeof SessionMessageTable.$inferInsert)["data"]
              >,
            },
          ])
          .run()
          .pipe(Effect.orDie)
        yield* database.db.update(SessionTable).set({ directory }).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)

        const updates: CrashActivity.Update[] = []
        const messages = yield* Effect.acquireUseRelease(
          Effect.sync(() => CrashActivity.configure((update) => updates.push(update))),
          () => request(`/api/session/${session.id}/message?limit=80`),
          (stop) => Effect.sync(stop),
        )
        expect(messages.status).toBe(200)
        expect((yield* json<{ data: SessionMessage.Message[] }>(messages)).data).toHaveLength(1)
        const stages = updates.flatMap((update) =>
          update.phase === "start" && update.kind === "session-stage" && update.sessionID === session.id ? [update] : [],
        )
        expect(stages.map((stage) => stage.name)).toEqual([
          "http.message-page", "messages.lookup", "messages.query", "messages.decode",
          "http.message-context", "messages.context-decode", "http.public-projection",
        ])
        for (const stage of stages)
          expect(updates).toContainEqual({ phase: "end", id: stage.id, outcome: "success" })
        expect(JSON.stringify(updates)).not.toContain("still readable")

        const prompt = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: { text: "blocked" }, resume: false }),
        })
        expect(prompt.status).toBe(410)
        expect((yield* json<{ _tag: string; directory: string }>(prompt))).toMatchObject({
          _tag: "SessionLocationUnavailableError",
          directory,
        })
      }),
    ),
    { git: true },
  )

  it.instance(
    "does not truncate large legacy limit requests",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, 520)

        const res = yield* request(`/session/${session.id}/message?limit=510`)
        expect(res.status).toBe(200)
        const body = yield* json<SessionV1.WithParts[]>(res)
        expect(body).toHaveLength(510)
      }),
    ),
    { git: true },
  )

  it.instance(
    "accepts directory query used by workspace routing",
    withoutWatcher(
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* sessionScoped
        yield* fill(session.id, 1)

        const res = yield* request(
          `/session/${session.id}/message?limit=80&directory=${encodeURIComponent(tmp.directory)}`,
        )
        expect(res.status).toBe(200)
        const body = yield* json<unknown[]>(res)
        expect(Array.isArray(body)).toBe(true)
        expect(body).toHaveLength(1)
      }),
    ),
    { git: true },
  )
})
