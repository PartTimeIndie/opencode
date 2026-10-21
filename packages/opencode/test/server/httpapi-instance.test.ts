import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { describe, expect } from "bun:test"
import { Config, Context, Effect, Exit, Fiber, FileSystem, Layer, Path, Scope, Semaphore } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { ControlPaths } from "../../src/server/routes/instance/httpapi/groups/control"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionActivityTable } from "@opencode-ai/core/session/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { eq } from "drizzle-orm"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { HEADER as FenceHeader } from "../../src/server/shared/fence"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Flip the experimental workspaces flag so EventV2.run actually writes to
// EventSequenceTable (the source of truth the fence middleware reads). Reset
// the database around the test so per-instance state does not leak between
// runs. resetDatabase() already calls disposeAllInstances(), so we don't
// repeat it.
const suiteLock = Semaphore.makeUnsafe(1)
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* suiteLock.take(1)
    yield* Effect.addFinalizer(() => suiteLock.release(1))
    const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
    Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
        await resetDatabase()
      }),
    )
  }),
)

// Mount the production HttpApi route tree on a real Node HTTP server bound to
// 127.0.0.1:0 and a fetch-based HttpClient that prepends the server URL. This
// keeps the test wired directly through the same route layer production uses.
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const httpApiServerLayer = servedRoutes.pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

const it = testEffect(
  Layer.mergeAll(testStateLayer, httpApiServerLayer, Database.defaultLayer, EventV2.defaultLayer),
)
const handlerContext = Context.empty() as Context.Context<unknown>

const directoryHeader = (dir: string) => HttpClientRequest.setHeader("x-opencode-directory", dir)

function activityByID(db: Database.Interface["db"], id: string) {
  return db.select().from(SessionActivityTable).where(eq(SessionActivityTable.id, id)).get().pipe(Effect.orDie)
}

describe("instance HttpApi", () => {
  it.live("serves the OpenAPI document", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/doc")

      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toContain("application/json")
      expect(yield* response.json).toMatchObject({
        openapi: expect.any(String),
        info: expect.any(Object),
        paths: expect.objectContaining({
          "/global/health": expect.any(Object),
          "/session": expect.any(Object),
        }),
      })
    }),
  )

  it.live("emits a sync fence header for fixed-workspace mutations", () =>
    Effect.gen(function* () {
      const originalWorkspaceID = Flag.OPENCODE_WORKSPACE_ID
      Flag.OPENCODE_WORKSPACE_ID = WorkspaceV2.ID.ascending()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Flag.OPENCODE_WORKSPACE_ID = originalWorkspaceID
        }),
      )

      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* HttpClientRequest.post(SessionPaths.create).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ title: "fenced" }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(response.status).toBe(200)
      expect(JSON.parse(response.headers[FenceHeader] ?? "{}")).not.toEqual({})
    }),
  )

  it.live("does not emit sync fence headers for fixed-workspace reads or no-op mutations", () =>
    Effect.gen(function* () {
      const originalWorkspaceID = Flag.OPENCODE_WORKSPACE_ID
      Flag.OPENCODE_WORKSPACE_ID = WorkspaceV2.ID.ascending()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Flag.OPENCODE_WORKSPACE_ID = originalWorkspaceID
        }),
      )

      const dir = yield* tmpdirScoped({ git: true })
      const read = yield* HttpClientRequest.get(InstancePaths.path).pipe(directoryHeader(dir), HttpClient.execute)
      const log = yield* HttpClientRequest.post(ControlPaths.log).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ service: "fence-test", level: "info", message: "noop" }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(read.status).toBe(200)
      expect(read.headers[FenceHeader]).toBeUndefined()
      expect(log.status).toBe(200)
      expect(log.headers[FenceHeader]).toBeUndefined()
    }),
  )

  it.live("rejects malformed permission and Surface request ids", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const request = (path: string, init?: RequestInit) =>
        Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${path}`, {
              ...init,
              headers: { "x-opencode-directory": dir, "content-type": "application/json", ...init?.headers },
            }),
            handlerContext,
          ),
        )
      const [permission, surfaceReply, surfaceDismiss] = yield* Effect.all(
        [
          request("/permission/invalid-permission-id/reply", {
            method: "POST",
            body: JSON.stringify({ reply: "once" }),
          }),
          request("/api/session/ses_invalid/surface/invalid-surface-id/reply", {
            method: "POST",
            body: JSON.stringify({ answers: [["Yes"]] }),
          }),
          request("/api/session/ses_invalid/surface/invalid-surface-id/dismiss", { method: "POST" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(permission.status).toBe(400)
      expect(surfaceReply.status).toBe(404)
      expect(surfaceDismiss.status).toBe(404)
    }),
  )

  it.live("returns typed not found bodies for missing permission requests", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const request = (path: string, init?: RequestInit) =>
        Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${path}`, {
              ...init,
              headers: { "x-opencode-directory": dir, "content-type": "application/json", ...init?.headers },
            }),
            handlerContext,
          ),
        )
      const permissionID = PermissionV1.ID.ascending()
      const permission = yield* request(`/permission/${permissionID}/reply`, {
        method: "POST",
        body: JSON.stringify({ reply: "once" }),
      })

      expect(permission.status).toBe(404)
      expect(yield* Effect.promise(() => permission.json())).toEqual({
        _tag: "PermissionNotFoundError",
        requestID: permissionID,
        message: `Permission request not found: ${permissionID}`,
      })
    }),
  )

  it.live("settles a Layer A question through the real Layer B router idempotently", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const create = () =>
        HttpClientRequest.post("/api/session").pipe(
          directoryHeader(directory),
          HttpClientRequest.bodyJson({ location: { directory } }),
          Effect.flatMap(HttpClient.execute),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => (body as { data: { id: string } }).data.id),
        )
      const sessionID = SessionV2.ID.make(yield* create())
      const wrongSessionID = SessionV2.ID.make(yield* create())
      const { db } = yield* Database.Service
      const now = Date.now()
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: "activity_question_router",
          session_id: sessionID,
          status: "running",
          kind: "prompt",
          owner_id: "owner_question_router",
          lease_until: now + 300_000,
          heartbeat_at: now,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const layerA = QuestionV2.layer.pipe(
        Layer.provide(Layer.succeed(Database.Service, yield* Database.Service)),
        Layer.provide(Layer.succeed(EventV2.Service, yield* EventV2.Service)),
      )
      const question = Context.get(yield* Layer.buildWithScope(Layer.fresh(layerA), scope), QuestionV2.Service)
      const waiter = yield* question
        .ask({
          sessionID,
          questions: [{ question: "Continue through router?", options: [{ label: "Yes" }] }],
        })
        .pipe(Effect.forkScoped)
      let pending = yield* question.list()
      while (pending.length === 0) {
        yield* Effect.sleep("10 millis")
        pending = yield* question.list()
      }
      const requestID = pending[0]!.id
      const currentList = yield* HttpClientRequest.get(
        `/api/surface/request?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
      ).pipe(HttpClient.execute, Effect.flatMap((response) => response.json))
      expect((currentList as { data: Array<{ id: string }> }).data.map((request) => request.id)).toEqual([requestID])
      const reply = (owner: SessionV2.ID, answers: string[][]) =>
        HttpClientRequest.post(`/api/session/${owner}/surface/${requestID}/reply`).pipe(
          directoryHeader(directory),
          HttpClientRequest.bodyJson({ answers }),
          Effect.flatMap(HttpClient.execute),
        )

      expect((yield* reply(sessionID, [["Yes"]])).status).toBe(204)
      expect(yield* Fiber.join(waiter)).toEqual([["Yes"]])
      expect((yield* reply(sessionID, [["Yes"]])).status).toBe(204)
      expect((yield* reply(sessionID, [["No"]])).status).toBe(409)
      expect((yield* reply(wrongSessionID, [["Yes"]])).status).toBe(404)

      const rejectedWaiter = yield* question
        .ask({ sessionID, questions: [{ question: "Dismiss through router?", options: [{ label: "Yes" }] }] })
        .pipe(Effect.exit, Effect.forkScoped)
      let rejected = yield* question.list()
      while (rejected.length === 0) {
        yield* Effect.sleep("10 millis")
        rejected = yield* question.list()
      }
      const rejectRequest = () =>
        HttpClientRequest.post(`/api/session/${sessionID}/surface/${rejected[0]!.id}/dismiss`).pipe(
          directoryHeader(directory),
          HttpClient.execute,
        )
      const reject = yield* rejectRequest().pipe(Effect.timeout("5 seconds"))
      expect(reject.status).toBe(200)
      expect(yield* reject.json).toEqual({ status: "settled" })
      const duplicateReject = yield* rejectRequest().pipe(Effect.timeout("5 seconds"))
      expect(duplicateReject.status).toBe(200)
      expect(yield* duplicateReject.json).toEqual({ status: "settled" })
      expect((yield* Fiber.join(rejectedWaiter))._tag).toBe("Failure")
      const activities = yield* db
        .select()
        .from(SessionActivityTable)
        .where(eq(SessionActivityTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(activities).toHaveLength(1)
      expect(activities[0]!.status).toBe("running")
      expect(activities[0]!.time_updated).toBe(now)
    }),
  )

  it.live("leaves stale and newer activities unchanged when dismissing a blocking question", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const sessionID = SessionV2.ID.make(
        yield* HttpClientRequest.post("/api/session").pipe(
          directoryHeader(directory),
          HttpClientRequest.bodyJson({ location: { directory } }),
          Effect.flatMap(HttpClient.execute),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => (body as { data: { id: string } }).data.id),
        ),
      )
      const { db } = yield* Database.Service
      const now = Date.now()
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: "activity_question_stale",
          session_id: sessionID,
          status: "running",
          kind: "prompt",
          owner_id: "owner_question_stale",
          lease_until: now - 1,
          heartbeat_at: now - 60_000,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const question = Context.get(
        yield* Layer.buildWithScope(
          Layer.fresh(
            QuestionV2.layer.pipe(
              Layer.provide(Layer.succeed(Database.Service, yield* Database.Service)),
              Layer.provide(Layer.succeed(EventV2.Service, yield* EventV2.Service)),
            ),
          ),
          scope,
        ),
        QuestionV2.Service,
      )
      const waiter = yield* question
        .ask({ sessionID, questions: [{ question: "Dismiss stale turn?", options: [{ label: "Yes" }] }] })
        .pipe(Effect.exit, Effect.forkScoped)
      let pending = yield* question.list()
      while (pending.length === 0) {
        yield* Effect.sleep("10 millis")
        pending = yield* question.list()
      }

      yield* db
        .insert(SessionActivityTable)
        .values({
          id: "activity_question_newer",
          session_id: sessionID,
          status: "running",
          kind: "prompt",
          owner_id: "owner_question_newer",
          lease_until: now + 300_000,
          heartbeat_at: now,
          time_created: now + 2,
          time_updated: now + 2,
        })
        .run()
        .pipe(Effect.orDie)

      const rejected = yield* HttpClientRequest.post(
        `/api/session/${sessionID}/surface/${pending[0]!.id}/dismiss`,
      ).pipe(directoryHeader(directory), HttpClient.execute, Effect.timeout("5 seconds"))
      expect(rejected.status).toBe(200)
      expect(yield* rejected.json).toEqual({ status: "settled" })
      expect(yield* activityByID(db, "activity_question_stale")).toMatchObject({
        status: "running",
        owner_id: "owner_question_stale",
      })
      expect(yield* activityByID(db, "activity_question_newer")).toMatchObject({
        status: "running",
        owner_id: "owner_question_newer",
      })
      expect((yield* Fiber.join(waiter))._tag).toBe("Failure")
    }),
  )

  it.live("returns typed not found bodies for missing projects", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const projectID = ProjectV2.ID.make("project_missing")
      const response = yield* Effect.promise(() =>
        HttpApiApp.webHandler().handler(
          new Request(`http://localhost/project/${projectID}`, {
            method: "PATCH",
            headers: { "x-opencode-directory": dir, "content-type": "application/json" },
            body: JSON.stringify({ name: "Missing" }),
          }),
          handlerContext,
        ),
      )

      expect(response.status).toBe(404)
      expect(yield* Effect.promise(() => response.json())).toEqual({
        _tag: "ProjectNotFoundError",
        projectID,
        message: `Project not found: ${projectID}`,
      })
    }),
  )

  it.live("queues and retries project icon generation through canonical routes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const currentResponse = yield* Effect.promise(() =>
        HttpApiApp.webHandler().handler(
          new Request("http://localhost/project/current", {
            headers: { "x-opencode-directory": dir },
          }),
          handlerContext,
        ),
      )
      const current = (yield* Effect.promise(() => currentResponse.json())) as { id: string }

      const generated = yield* Effect.promise(() =>
        HttpApiApp.webHandler().handler(
          new Request(`http://localhost/project/${current.id}/icon/generate`, {
            method: "POST",
            headers: { "x-opencode-directory": dir, "content-type": "application/json" },
            body: JSON.stringify({ force: false }),
          }),
          handlerContext,
        ),
      )
      expect(generated.status).toBe(200)
      expect(yield* Effect.promise(() => generated.json())).toMatchObject({
        id: current.id,
        iconGeneration: { status: "queued", attempt: 1 },
      })

      const retried = yield* Effect.promise(() =>
        HttpApiApp.webHandler().handler(
          new Request(`http://localhost/project/${current.id}/icon/retry`, {
            method: "POST",
            headers: { "x-opencode-directory": dir },
          }),
          handlerContext,
        ),
      )
      expect(retried.status).toBe(200)
      expect(yield* Effect.promise(() => retried.json())).toMatchObject({
        id: current.id,
        iconGeneration: { status: "queued", attempt: 2 },
      })
    }),
  )

  it.live("serves path and VCS read endpoints", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(path.join(dir, "changed.txt"), "hello")

      const [paths, vcs, diff] = yield* Effect.all(
        [
          HttpClientRequest.get(InstancePaths.path).pipe(directoryHeader(dir), HttpClient.execute),
          HttpClientRequest.get(InstancePaths.vcs).pipe(directoryHeader(dir), HttpClient.execute),
          HttpClientRequest.get(InstancePaths.vcsDiff).pipe(
            HttpClientRequest.setUrlParam("mode", "git"),
            directoryHeader(dir),
            HttpClient.execute,
          ),
        ],
        { concurrency: "unbounded" },
      )

      expect(paths.status).toBe(200)
      expect(yield* paths.json).toMatchObject({ directory: dir, worktree: dir })

      expect(vcs.status).toBe(200)
      expect(yield* vcs.json).toMatchObject({ branch: expect.any(String) })

      expect(diff.status).toBe(200)
      expect(yield* diff.json).toContainEqual(
        expect.objectContaining({ file: "changed.txt", additions: 1, status: "added" }),
      )
    }),
  )
})
