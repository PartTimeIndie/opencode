import path from "node:path"
import { existsSync, writeFileSync } from "node:fs"
import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { eq } from "drizzle-orm"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { Session } from "@/session/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionActivityTable, SessionInputTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { BackgroundJobTable } from "@opencode-ai/core/background-job.sql"
import { Database } from "@opencode-ai/core/database/database"
import { AccountV2 } from "@opencode-ai/core/account"
import { AccountTable } from "@opencode-ai/core/account/sql"
import { Worktree } from "../../src/worktree"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))
const testWorktreeMutations = process.platform === "win32" ? it.instance.skip : it.instance

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

function configureMcpServer(directory: string) {
  return Effect.gen(function* () {
    const mcp = new Server({ name: "catalog", version: "1.0.0" }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      writeFileSync(path.join(directory, "catalog-ready"), "ready")
      while (!existsSync(path.join(directory, "catalog-release"))) await Bun.sleep(10)
      return {
        tools: [{ name: "fresh", description: "Fresh catalog tool", inputSchema: { type: "object", properties: {} } }],
      }
    })

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    })
    yield* Effect.promise(() => mcp.connect(transport))
    const http = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) => transport.handleRequest(request),
        }),
      ),
      (server) =>
        Effect.promise(async () => {
          server.stop(true)
          await mcp.close()
        }),
    )

    yield* Effect.promise(() =>
      Bun.write(
        path.join(directory, "opencode.json"),
        JSON.stringify({
          formatter: false,
          lsp: false,
          mcp: {
            catalog: {
              type: "remote",
              url: http.url.toString(),
              oauth: false,
              timeout: 5_000,
            },
          },
        }),
      ),
    )
  })
}

function waitReady(input: { directory?: string; name?: string }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const on = (event: GlobalEvent) => {
      if (event.payload.type !== Worktree.Event.Ready.type) return
      if (input.directory && event.directory !== input.directory) return
      if (input.name && event.payload.properties.name !== input.name) return
      Deferred.doneUnsafe(ready, Effect.void)
    }

    GlobalBus.on("event", on)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

    return yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
      }),
    )
  })
}

function insertAccount() {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(AccountTable)
        .values({
          id: AccountV2.ID.make("account-test"),
          email: "test@example.com",
          url: "https://console.example.com",
          access_token: AccountV2.AccessToken.make("access"),
          refresh_token: AccountV2.RefreshToken.make("refresh"),
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      return "account-test"
    }),
    (id) =>
      Database.Service.use(({ db }) =>
        db
          .delete(AccountTable)
          .where(eq(AccountTable.id, AccountV2.ID.make(id)))
          .run()
          .pipe(Effect.orDie),
      ),
  )
}

function setSessionUpdated(session: Session.Info, updated: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ time_updated: updated })
      .where(eq(SessionTable.id, session.id))
      .run()
      .pipe(Effect.orDie)
  })
}

function withCreatedWorktree(
  directory: string,
  use: (info: Worktree.Info) => Effect.Effect<void, unknown, HttpClient.HttpClient>,
) {
  const name = "api-test"
  const headers = { "content-type": "application/json" }
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const ready = yield* waitReady({ name }).pipe(Effect.forkScoped)
      const created = yield* request(ExperimentalPaths.worktree, directory, {
        method: "POST",
        headers,
        body: JSON.stringify({ name }),
      })

      expect(created.status).toBe(200)
      const info = yield* json<Worktree.Info>(created)
      expect(info).toMatchObject({ name, branch: "opencode/api-test" })
      yield* Fiber.join(ready)
      return info
    }),
    use,
    (info) =>
      Effect.gen(function* () {
        const removed = yield* request(ExperimentalPaths.worktree, directory, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ directory: info.directory }),
        })
        if (removed.status !== 200) return yield* Effect.fail(new Error(`failed to remove worktree: ${removed.status}`))
        const ok = yield* json<boolean>(removed)
        if (!ok) return yield* Effect.fail(new Error(`failed to remove worktree ${info.directory}`))
      }),
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("experimental HttpApi", () => {
  it.instance(
    "serves read-only experimental endpoints through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const directory = tmp.directory
        const configured = yield* request("/config", directory)
        expect(configured.status).toBe(200)
        const [consoleState, consoleOrgs, toolList, toolIDs, worktrees, resources] = yield* Effect.all(
          [
            request(ExperimentalPaths.console, directory),
            request(ExperimentalPaths.consoleOrgs, directory),
            request(`${ExperimentalPaths.tool}?provider=opencode&model=gpt-5`, directory),
            request(ExperimentalPaths.toolIDs, directory),
            request(ExperimentalPaths.worktree, directory),
            request(ExperimentalPaths.resource, directory),
          ],
          { concurrency: "unbounded" },
        )

        expect(consoleState.status).toBe(200)
        expect(yield* json(consoleState)).toEqual({
          consoleManagedProviders: [],
          switchableOrgCount: 0,
        })

        expect(consoleOrgs.status).toBe(200)
        expect(yield* json(consoleOrgs)).toEqual({ orgs: [] })

        expect(toolList.status).toBe(200)
        expect(yield* json<unknown[]>(toolList)).toContainEqual(
          expect.objectContaining({
            id: "bash",
            description: expect.any(String),
            parameters: expect.any(Object),
          }),
        )

        expect(toolIDs.status).toBe(200)
        expect(yield* json(toolIDs)).toContain("bash")

        expect(worktrees.status).toBe(200)
        expect(yield* json(worktrees)).toEqual([])

        expect(resources.status).toBe(200)
        const resourceBody = yield* json<Record<string, unknown>>(resources)
        expect(resourceBody).toBeTypeOf("object")
        expect(Array.isArray(resourceBody)).toBe(false)
      }),
    {
      config: {
        formatter: false,
        lsp: false,
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
    30_000,
  )

  it.instance(
    "waits for fresh MCP discovery before serving the tool catalog",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const configured = yield* request("/config", tmp.directory)
        expect(yield* json(configured)).toMatchObject({ mcp: { catalog: { type: "remote", oauth: false } } })
        const pending = yield* request(
          `${ExperimentalPaths.tool}?provider=opencode&model=gpt-5`,
          tmp.directory,
        ).pipe(Effect.forkScoped)
        yield* pollWithTimeout(
          Effect.sync(() => (existsSync(path.join(tmp.directory, "catalog-ready")) ? true : undefined)),
          "timed out waiting for MCP catalog discovery",
          "10 seconds",
        )
        expect(Option.isNone(yield* Fiber.join(pending).pipe(Effect.timeoutOption("50 millis")))).toBe(true)
        yield* Effect.sync(() => writeFileSync(path.join(tmp.directory, "catalog-release"), "release"))
        const response = yield* Fiber.join(pending)

        expect(response.status).toBe(200)
        expect(yield* json<unknown[]>(response)).toContainEqual(
          expect.objectContaining({ id: "catalog_fresh", source: "mcp:catalog" }),
        )
      }),
    {
      init: configureMcpServer,
    },
    15_000,
  )

  it.instance(
    "waits for fresh MCP discovery before serving tool IDs",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const pending = yield* request(ExperimentalPaths.toolIDs, tmp.directory).pipe(Effect.forkScoped)
        yield* pollWithTimeout(
          Effect.sync(() => (existsSync(path.join(tmp.directory, "catalog-ready")) ? true : undefined)),
          "timed out waiting for MCP tool ID discovery",
          "10 seconds",
        )
        expect(Option.isNone(yield* Fiber.join(pending).pipe(Effect.timeoutOption("50 millis")))).toBe(true)
        yield* Effect.sync(() => writeFileSync(path.join(tmp.directory, "catalog-release"), "release"))
        const response = yield* Fiber.join(pending)

        expect(response.status).toBe(200)
        expect(yield* json(response)).toContain("catalog_fresh")
      }),
    {
      init: configureMcpServer,
    },
    15_000,
  )

  it.instance("returns declared worktree errors", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(ExperimentalPaths.worktree, tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(400)
      expect(yield* json(response)).toEqual({
        name: "WorktreeNotGitError",
        data: { message: "Worktrees are only supported for git projects" },
      })
    }),
  )

  it.instance(
    "serves Console org switch through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const accountID = yield* insertAccount()
        const switched = yield* request(ExperimentalPaths.consoleSwitch, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountID, orgID: "org-test" }),
        })

        expect(switched.status).toBe(200)
        expect(yield* json(switched)).toBe(true)
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves global session list through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const first = yield* createSession({ title: "page-one" })
        const second = yield* createSession({ title: "page-two" })
        yield* setSessionUpdated(first, 1)
        yield* setSessionUpdated(second, 2)

        const page = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({ directory: tmp.directory, limit: "1" })}`,
          tmp.directory,
        )
        expect(page.status).toBe(200)
        expect(page.headers["x-next-cursor"]).toBeTruthy()

        const body = yield* json<Session.GlobalInfo[]>(page)
        expect(body.map((session) => session.id)).toEqual([second.id])
        expect(body[0].project?.id).toBe(second.projectID)

        const next = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({
            directory: tmp.directory,
            limit: "10",
            cursor: body[0].time.updated.toString(),
          })}`,
          tmp.directory,
        )
        expect(next.status).toBe(200)
        expect((yield* json<Session.GlobalInfo[]>(next)).map((session) => session.id)).toContain(first.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves session usage with descendant and run attribution",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const parent = yield* createSession({ title: "usage parent" })
        const now = Date.now()
        const { db } = yield* Database.Service
        const childID = SessionSchema.ID.make("ses_usage_child")
        yield* db
          .insert(SessionTable)
          .values({
            id: childID,
            project_id: parent.projectID,
            parent_id: parent.id,
            slug: "ses_usage_child",
            directory: parent.directory,
            title: "usage child",
            version: "test",
            agent: "explore",
            tokens_input: 50,
            tokens_output: 10,
          })
          .run()
        yield* db.update(SessionTable).set({ tokens_input: 100, tokens_output: 20 }).where(eq(SessionTable.id, parent.id)).run()
        yield* db
          .insert(SessionActivityTable)
          .values({
            id: "act_usage_1",
            session_id: parent.id,
            status: "completed",
            kind: "prompt",
            opened_seq: 10,
            closed_seq: 11,
            time_created: now - 1000,
            time_updated: now - 500,
          })
          .run()
        yield* db
          .insert(EventSequenceTable)
          .values({ aggregate_id: parent.id, seq: 11 })
          .onConflictDoUpdate({ target: EventSequenceTable.aggregate_id, set: { seq: 11 } })
          .run()
        yield* db
          .insert(SessionMessageTable)
          .values({
            id: "msg_usage_1" as typeof SessionMessageTable.$inferInsert.id,
            session_id: parent.id,
            type: "assistant",
            seq: 11,
            time_created: now - 900,
            time_updated: now - 900,
            data: {
              agent: "build",
              model: { id: "gpt-test", providerID: "openai", variant: "high" },
              tokens: { input: 30, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0.01,
            },
          } as unknown as typeof SessionMessageTable.$inferInsert)
          .run()
        const chain = {
          id: "chain_usage_test",
          name: "Reliable",
          steps: [
            { id: "gpt-test", providerID: "openai", variant: "high" },
            { id: "claude-test", providerID: "anthropic" },
          ],
          active: 0,
        }
        yield* db
          .insert(SessionInputTable)
          .values({
            id: "msg_usage_input" as typeof SessionInputTable.$inferInsert.id,
            session_id: parent.id,
            prompt: {
              text: "test prompt",
              model: { id: "gpt-test", providerID: "openai", variant: "high", chain },
            } as unknown as typeof SessionInputTable.$inferInsert.prompt,
            delivery: "queue",
            admitted_seq: 10,
            promoted_seq: 11,
            time_created: now - 950,
          })
          .run()

        const usage = yield* request(
          `${ExperimentalPaths.sessionUsage.replace(":sessionID", parent.id)}?${new URLSearchParams({ directory: tmp.directory })}`,
          tmp.directory,
        )
        expect(usage.status).toBe(200)
        const body = yield* json<Record<string, any>>(usage)
        expect(body.sessionID).toBe(parent.id)
        expect(body.session.own.total).toBe(120)
        expect(body.session.descendants.total).toBe(60)
        expect(body.session.total.total).toBe(180)
        expect(body.session.descendantSessions).toBe(1)
        expect(body.session.generationMs).toBe(0)
        expect(body.sequence).toBe(11)
        expect(body.activityID).toBe("act_usage_1")
        expect(body.run).not.toBeNull()
        expect(body.run.status).toBe("completed")
        expect(body.run.running).toBe(false)
        expect(body.run.timeUpdated).toBe(now - 500)
        expect(body.run.generationMs).toBe(0)
        expect(body.run.own.total).toBe(35)
        expect(body.run.own.cost).toBeCloseTo(0.01)
        expect(body.run.measurement.own.unreportedSteps).toBe(1)
        expect(body.run.measurement.own.categories.input).toMatchObject({ known: 30, complete: true })
        expect(body.run.attribution.status).toBe("partial")
        expect(body.run.models).toMatchObject({
          selected: [{ model: { id: "gpt-test", providerID: "openai", variant: "high", chain: { id: "chain_usage_test", name: "Reliable" } }, source: "prompt", sequence: 11 }],
          observed: [{ model: { id: "gpt-test", providerID: "openai", variant: "high" }, sequence: 11 }],
          complete: true,
        })
        // Descendant exists but no task provenance part links it inside the window.
        expect(body.run.descendants.total).toBe(0)
        expect(body.run.complete).toBe(false)
        expect(body.run.reason).toBeDefined()

        const missing = yield* request(
          `${ExperimentalPaths.sessionUsage.replace(":sessionID", "ses_missing_usage")}?${new URLSearchParams({ directory: tmp.directory })}`,
          tmp.directory,
        )
        expect(missing.status).toBe(400)
        expect(yield* json<Record<string, any>>(missing)).toMatchObject({ name: "SessionUsageNotFound" })
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "does not expose background task output through a different directory",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const foreignDirectory = yield* tmpdirScoped()
        const session = yield* createSession({ title: "private parent" })
        const taskID = SessionSchema.ID.make("ses_private_task")
        const now = Date.now()
        const { db } = yield* Database.Service
        yield* db
          .insert(BackgroundJobTable)
          .values({
            id: taskID,
            type: "task",
            status: "completed",
            parent_session_id: session.id,
            child_session_id: taskID,
            parent_message_id: "msg_private_parent",
            parent_call_id: "call_private_parent",
            title: "Private task",
            metadata: { background: true, rootSessionID: session.id },
            output: "private task output",
            delivery_status: "available",
            time_created: now,
            time_updated: now,
            time_completed: now,
          })
          .run()
          .pipe(Effect.orDie)

        const taskPath = ExperimentalPaths.sessionTasks.replace(":sessionID", session.id)
        const allowed = yield* request(taskPath, tmp.directory)
        expect(allowed.status).toBe(200)
        expect(yield* json<Array<{ output?: string }>>(allowed)).toEqual([
          expect.objectContaining({ output: "private task output" }),
        ])

        const denied = yield* request(taskPath, foreignDirectory)
        expect(denied.status).toBe(404)
        expect(JSON.stringify(yield* json(denied))).not.toContain("private task output")
      }),
    { config: { formatter: false, lsp: false } },
  )

  testWorktreeMutations(
    "serves worktree mutations through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* withCreatedWorktree(tmp.directory, (info) =>
          Effect.gen(function* () {
            const listed = yield* request(ExperimentalPaths.worktree, tmp.directory)
            expect(listed.status).toBe(200)
            expect(yield* json(listed)).toContain(info.directory)

            const reset = yield* request(ExperimentalPaths.worktreeReset, tmp.directory, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ directory: info.directory }),
            })

            expect(reset.status).toBe(200)
            expect(yield* json(reset)).toBe(true)
          }),
        )

        const afterRemove = yield* request(ExperimentalPaths.worktree, tmp.directory)
        expect(afterRemove.status).toBe(200)
        expect(yield* json(afterRemove)).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
