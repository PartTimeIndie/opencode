import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, describe, expect, test } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Cause, Config, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"

import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import * as HttpSessionError from "../../src/server/routes/instance/httpapi/handlers/session-errors"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { Database } from "@opencode-ai/core/database/database"
import { EventTable } from "@opencode-ai/core/event/sql"
import { EventV2 } from "@opencode-ai/core/event"
import {
  SessionActivityTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
  PartTable,
} from "@opencode-ai/core/session/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { QuestionTable } from "@opencode-ai/core/question/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionPlanDocument } from "@opencode-ai/core/session/plan-document"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Surface } from "@opencode-ai/core/surface"
import { AgentSwitchTool } from "@opencode-ai/core/tool/agent-switch"
import * as DateTime from "effect/DateTime"
import { desc, eq, sql } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { sameEventDirectory } from "../../src/server/routes/instance/httpapi/handlers/event"
import { InstanceRef } from "../../src/effect/instance-ref"

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const commandHookPlugin = pathToFileURL(path.join(import.meta.dir, "..", "fixture", "command-hook-plugin.ts")).href
const goalCommandObserver = pathToFileURL(path.join(import.meta.dir, "..", "fixture", "goal-command-observer.ts")).href

// Machine-readable bindings are part of the admission contract: run IDs must be
// backtick-quoted list fields and every accepted item needs separate - itemId /
// - approvalId fields under an accepted heading. A readable prose snapshot would
// pass the visual handoff but fail admission.
const dailyReviewPlanMarkdown = [
  "# Daily Review",
  "- runId: `morning-run`",
  "- runDate: `2026-10-05`",
  "- planId: `plan-1`",
  "- morningRunId: `morning-run`",
  "## Angenommene Punkte",
  "### itemId `item-1`",
  `- approvalId: \`${"a".repeat(64)}\``,
  "autoApply=false",
].join("\n")
function dailyReviewSurface(plan: SessionPlanDocument.Info) {
  return {
    version: 1,
    controlID: "agent-switch-build",
    title: "Daily Review: all accepted items",
    markdown: [
      "**Expected:** Confirm this handoff to authorize implementation of every accepted item below, or dismiss it to stop.",
      "## Authorization scope",
      "This one confirmation covers all accepted Daily Review items in this exact plan snapshot, including items marked `autoApply=false`. The build agent must process them sequentially through the per-item admission tool.",
      "Rejected (Nein), deferred (Später), alternatives, and work not listed as accepted are excluded. Existing dependency checks and report-only, Git, safety, and direction-clarification rules remain in force.",
      `Plan snapshot: revision ${plan.revision}; updatedAt ${plan.updatedAt}; SHA-256 ${createHash("sha256").update(plan.markdown).digest("hex")}.`,
      "## Exact build prompt",
      "```text",
      AgentSwitchTool.dailyReviewBuildPrompt,
      "```",
      "## Complete plan snapshot",
      plan.markdown,
    ].join("\n\n"),
    controls: [{ id: "implement", type: "button", label: "Authorize all accepted items and switch to build" }],
    actions: [{
      id: "handoff",
      trigger: { event: "click", source: "implement" },
      steps: [{ type: "switchAgentAndPrompt", agent: "build", prompt: AgentSwitchTool.dailyReviewBuildPrompt, model: { mode: "planning-model" } }],
    }],
  } satisfies Surface.PresentInput["surface"]
}

test("event directory matching accepts persisted and native Windows separators", () => {
  expect(sameEventDirectory("C:/GitRepros/PU", "C:\\GitRepros\\PU")).toBe(process.platform === "win32")
  expect(sameEventDirectory("C:/GitRepros/PU", "C:/GitRepros/other")).toBe(false)
})

const workspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
let instanceBootstrapRuns = 0
const instanceBootstrapDirectories: string[] = []
const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(
      InstanceBootstrapService.Service,
      InstanceBootstrapService.Service.of({
        run: InstanceRef.pipe(
          Effect.tap((instance) =>
            Effect.sync(() => {
              instanceBootstrapRuns++
              if (instance) instanceBootstrapDirectories.push(instance.directory)
            }),
          ),
          Effect.asVoid,
        ),
      }),
    ),
  ),
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    workspaceLayer,
    Database.defaultLayer,
    httpApiLayer,
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)
const mcpTransientTestName = "retries transient MCP discovery and resolves backed v2 commands into durable prompts"
const mcpTransientChild = process.env.OPENCODE_HTTPAPI_MCP_TRANSIENT_CHILD === "1"

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function createTextMessage(sessionID: SessionIDType, text: string) {
  return Effect.gen(function* () {
    const svc = yield* Session.Service
    const info = yield* svc.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: { created: Date.now() },
    })
    const part = yield* svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: info.id,
      type: "text",
      text,
    })
    return { info, part }
  })
}

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

const createLocalWorkspace = (input: { projectID: Project.Info["id"]; type: string; directory: string }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      registerAdapter(input.projectID, input.type, localAdapter(input.directory))
      return yield* Workspace.Service.use((svc) =>
        svc.create({
          type: input.type,
          branch: null,
          extra: null,
          projectID: input.projectID,
        }),
      )
    }),
    (info) => Workspace.use.remove(info.id).pipe(Effect.ignore),
  )

const insertLegacyAssistantMessage = (sessionID: SessionIDType, seq = 1, time = seq) =>
  Effect.gen(function* () {
    const message = new SessionMessage.Assistant({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
        variant: ModelV2.VariantID.make("default"),
      },
      time: { created: DateTime.makeUnsafe(time) },
      content: [],
    })
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: message.id,
          session_id: sessionID,
          type: message.type,
          seq,
          time_created: time,
          data: {
            time: { created: time },
            agent: message.agent,
            model: message.model,
            content: message.content,
          } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    return message
  })

const insertCorruptV2Message = (sessionID: SessionIDType, time = 1) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: SessionMessage.ID.create(),
          session_id: sessionID,
          type: "assistant",
          seq: time,
          time_created: time,
          data: {} as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
  })

const setLegacySummaryDiff = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({
        summary_additions: 1,
        summary_deletions: 0,
        summary_files: 1,
        summary_diffs: [{ additions: 1, deletions: 0 }],
      })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
  })

const getWorkspaceID = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ workspaceID: SessionTable.workspace_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
  })

const getLatestActivityCompletion = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({
        status: SessionActivityTable.status,
        completionState: SessionActivityTable.turn_completion_state,
        completionResult: SessionActivityTable.turn_completion_result,
        completionAttempts: SessionActivityTable.turn_completion_attempts,
      })
      .from(SessionActivityTable)
      .where(eq(SessionActivityTable.session_id, sessionID))
      .orderBy(desc(SessionActivityTable.time_created))
      .get()
      .pipe(Effect.orDie)
  })

const clearSessionPath = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  })

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function responseJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("session HttpApi", () => {
  it.instance("shares scoped delegation preferences with durable Session CAS and rejects stale HTTP saves", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const parent = yield* createSession({ title: "Scoped preferences" })
      const endpoint = pathFor(SessionPaths.delegationPreferences, { sessionID: parent.id })
      const headers = { "x-opencode-directory": instance.directory, "content-type": "application/json" }
      const initial = yield* requestJson<{ scope: string; revision: number; value: unknown }>(endpoint, { headers })
      expect(initial).toEqual({ scope: "session", revision: 0, value: {} })
      const saved = yield* requestJson<{ scope: string; revision: number; value: unknown }>(endpoint, {
        method: "PATCH", headers, body: JSON.stringify({ expectedRevision: 0, patch: { ordinaryQuestions: false } }),
      })
      expect(saved).toEqual({ scope: "session", revision: 1, value: { ordinaryQuestions: false } })
      const stale = yield* request(endpoint, { method: "PATCH", headers,
        body: JSON.stringify({ expectedRevision: 0, patch: { ordinaryQuestions: true } }) })
      expect(stale.status).toBe(409)
      expect(yield* requestJson(endpoint, { headers })).toEqual(saved)
      const missingVersion = yield* request(endpoint, { method: "PATCH", headers,
        body: JSON.stringify({ scope: "project", patch: { ordinaryQuestions: true } }) })
      expect(missingVersion.status).toBe(400)
      const invalidTask = yield* request(`${endpoint}?scope=task&taskID=${parent.id}`, { headers })
      expect(invalidTask.status).toBe(400)
      const projectBefore = yield* requestJson<{ scope: string; version: string; value: unknown }>(`${endpoint}?scope=project`, { headers })
      const projectSaved = yield* requestJson<{ scope: string; version: string; value: unknown }>(endpoint, {
        method: "PATCH", headers, body: JSON.stringify({ scope: "project", expectedVersion: projectBefore.version,
          patch: { preferences: [{ topic: "review", selections: [{ agent: "build" }] }] } }),
      })
      expect(projectSaved.scope).toBe("project")
      expect(projectSaved.version).not.toBe(projectBefore.version)
      expect(projectSaved.value).toEqual({ preferences: [{ topic: "review", selections: [{ agent: "build" }] }] })
      expect(yield* requestJson(`${endpoint}?scope=project`, { headers })).toEqual({
        scope: "project", version: projectSaved.version, value: projectSaved.value,
      })
      const projectStale = yield* request(endpoint, { method: "PATCH", headers, body: JSON.stringify({ scope: "project",
        expectedVersion: projectBefore.version, patch: { ordinaryQuestions: true } }) })
      expect(projectStale.status).toBe(409)
      const cleared = yield* requestJson<{ scope: string; version: string; value: unknown }>(endpoint, {
        method: "PATCH", headers, body: JSON.stringify({ scope: "project", expectedVersion: projectSaved.version,
          patch: { ordinaryQuestions: null, preferences: null, rules: null } }),
      })
      expect(cleared.value).toEqual({})
      expect(cleared.version).not.toBe(projectSaved.version)
      expect(yield* requestJson(endpoint, { headers })).toEqual(saved)
      const foreignDirectory = yield* tmpdirScoped({ git: true })
      // Session routing deliberately uses the stored Session location, not a
      // stale client directory header. It must still return only this ID's state.
      expect(yield* requestJson(endpoint, { headers: { "x-opencode-directory": foreignDirectory } })).toEqual(saved)
      const other = yield* requestJson<Session.Info>(SessionPaths.create, { method: "POST",
        headers: { "x-opencode-directory": foreignDirectory, "content-type": "application/json" }, body: JSON.stringify({ title: "Other Session" }) })
      expect(yield* requestJson(pathFor(SessionPaths.delegationPreferences, { sessionID: other.id }), { headers }))
        .toEqual({ scope: "session", revision: 0, value: {} })
    }),
  )
  it.live("bootstraps the local instance before serving V2 session requests", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      yield* store.disposeDirectory(directory)
      instanceBootstrapRuns = 0
      instanceBootstrapDirectories.length = 0

      const response = yield* request(`/api/session?directory=${encodeURIComponent(directory)}`)

      expect(response.status).toBe(200)
      expect(instanceBootstrapRuns).toBe(1)
      expect(instanceBootstrapDirectories).toEqual([directory])
    }),
  )

  it.live("decodes the directory header emitted by the V2 SDK client", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      yield* store.disposeDirectory(directory)
      instanceBootstrapRuns = 0
      instanceBootstrapDirectories.length = 0

      const response = yield* request("/api/session", {
        headers: { "x-opencode-directory": encodeURIComponent(directory) },
      })

      expect(response.status).toBe(200)
      expect(instanceBootstrapRuns).toBe(1)
      expect(instanceBootstrapDirectories).toEqual([directory])
    }),
  )

  it.live("does not resolve the global control-plane sentinel header as a filesystem path", () =>
    Effect.gen(function* () {
      instanceBootstrapRuns = 0
      instanceBootstrapDirectories.length = 0

      const response = yield* request("/api/session", {
        headers: { "x-opencode-directory": "global" },
      })

      expect(response.status).toBe(200)
      expect(instanceBootstrapDirectories).toEqual([FSUtil.resolve(process.cwd())])
    }),
  )

  it.instance(
    "serves session list requests that carry the global control-plane sentinel",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const parent = yield* createSession({ title: "control plane root" })

        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?directory=global&roots=true`, {
          headers,
        })
        expect(listed.map((item) => item.id)).toContain(parent.id)
      }),
  )

  it.effect("maps busy sessions to public session busy errors", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const exit = yield* HttpSessionError.mapBusy(Effect.fail(new Session.BusyError({ sessionID }))).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionBusyError",
          sessionID,
          message: `Session is busy: ${sessionID}`,
        })
      }
    }),
  )

  it.instance(
    "reports leased activities and durable blocking waits in the current instance placement",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 status" })
        const foreignSession = yield* createSession({ title: "foreign project status" })
        const foreignDirectorySession = yield* createSession({ title: "foreign directory status" })
        const foreignWorkspaceSession = yield* createSession({ title: "foreign workspace status" })
        const { db } = yield* Database.Service
        const activityID = "activity_http_status"
        const now = Date.now()

        yield* db.run(sql`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project_http_status_foreign', 'C:/foreign-project', '[]', ${now}, ${now})
        `)
        yield* db.run(sql`
          UPDATE session
          SET project_id = 'project_http_status_foreign', directory = 'C:/foreign-project'
          WHERE id = ${foreignSession.id}
        `)
        yield* db
          .update(SessionTable)
          .set({ directory: "C:/foreign-directory" })
          .where(eq(SessionTable.id, foreignDirectorySession.id))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({ workspace_id: WorkspaceV2.ID.make("wrk_foreign") })
          .where(eq(SessionTable.id, foreignWorkspaceSession.id))
          .run()
          .pipe(Effect.orDie)

        yield* db
          .insert(SessionActivityTable)
          .values(
            [
              { id: activityID, sessionID: session.id },
              { id: "activity_http_status_foreign_project", sessionID: foreignSession.id },
              { id: "activity_http_status_foreign_directory", sessionID: foreignDirectorySession.id },
              { id: "activity_http_status_foreign_workspace", sessionID: foreignWorkspaceSession.id },
            ].map((item) => ({
              id: item.id,
              session_id: item.sessionID,
              status: "running",
              kind: "prompt",
              owner_id: "http-status-test",
              lease_until: now + 30_000,
              heartbeat_at: now,
              opened_seq: 1,
            })),
          )
          .run()
          .pipe(Effect.orDie)

        const queuedInputID = SessionMessage.ID.make("msg_http_status_queued")
        yield* db
          .insert(SessionInputTable)
          .values({
            id: queuedInputID,
            session_id: session.id,
            prompt: { text: "queued follow-up" },
            delivery: "queue",
            admitted_seq: 2,
            time_created: now,
          })
          .run()
          .pipe(Effect.orDie)

        expect(yield* requestJson<Record<string, { type: string }>>(SessionPaths.status, { headers })).toEqual({
          [session.id]: { type: "busy" },
        })

        const questionID = QuestionV2.ID.make("que_http_status_waiting")
        yield* db
          .insert(QuestionTable)
          .values({
            id: questionID,
            session_id: session.id,
            seq: 1,
            state: "active",
            mode: "blocking",
            request: {
              id: questionID,
              sessionID: session.id,
              mode: "blocking",
              revision: 1,
              actions: [],
              questions: [
                { header: "Review", question: "Continue?", options: [{ label: "Yes", description: "Continue" }] },
              ],
            },
            time_created: now,
            time_updated: now,
          })
          .run()
          .pipe(Effect.orDie)
        expect(yield* requestJson<Record<string, { type: string }>>(SessionPaths.status, { headers })).toEqual({
          [session.id]: { type: "waiting_for_user" },
        })

        yield* db
          .update(SessionActivityTable)
          .set({ lease_until: now - 1 })
          .where(eq(SessionActivityTable.id, activityID))
          .run()
          .pipe(Effect.orDie)
        expect(yield* requestJson<Record<string, { type: string }>>(SessionPaths.status, { headers })).toEqual({
          [session.id]: { type: "waiting_for_user" },
        })

        yield* db
          .update(SessionActivityTable)
          .set({ status: "recovering", reason: "owner-shutdown" })
          .where(eq(SessionActivityTable.id, activityID))
          .run()
          .pipe(Effect.orDie)
        expect(yield* requestJson<Record<string, { type: string }>>(SessionPaths.status, { headers })).toEqual({
          [session.id]: { type: "waiting_for_user" },
        })

        yield* db
          .update(QuestionTable)
          .set({ state: "replied", time_settled: now })
          .where(eq(QuestionTable.id, questionID))
          .run()
          .pipe(Effect.orDie)
        expect(yield* requestJson<Record<string, { type: string }>>(SessionPaths.status, { headers })).toEqual({})
        expect(
          yield* db
            .select({ promotedSeq: SessionInputTable.promoted_seq })
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, queuedInputID))
            .get()
            .pipe(Effect.orDie),
        ).toEqual({ promotedSeq: null })

        yield* db
          .update(SessionActivityTable)
          .set({ lease_until: now + 30_000 })
          .where(eq(SessionActivityTable.id, activityID))
          .run()
          .pipe(Effect.orDie)
        expect(yield* requestJson<Record<string, { type: string }>>(SessionPaths.status, { headers })).toEqual({
          [session.id]: { type: "busy" },
        })

        yield* db
          .update(SessionActivityTable)
          .set({ status: "completed", lease_until: null, closed_seq: 2 })
          .where(eq(SessionActivityTable.id, activityID))
          .run()
          .pipe(Effect.orDie)
        expect(yield* requestJson<Record<string, { type: string }>>(SessionPaths.status, { headers })).toEqual({})

        yield* db
          .update(SessionActivityTable)
          .set({ status: "interrupted", reason: "stale-lease" })
          .where(eq(SessionActivityTable.id, activityID))
          .run()
          .pipe(Effect.orDie)
        expect(yield* requestJson<Record<string, { type: string }>>(SessionPaths.status, { headers })).toEqual({})

        yield* db
          .update(SessionActivityTable)
          .set({ status: "recovering", lease_until: now - 1, closed_seq: null })
          .where(eq(SessionActivityTable.id, activityID))
          .run()
          .pipe(Effect.orDie)
        expect(yield* requestJson<Record<string, { type: string }>>(SessionPaths.status, { headers })).toEqual({})
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns declared not found errors for read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const missingSession = SessionID.descending()
        const missingSessionBody = {
          name: "NotFoundError",
          data: { message: `Session not found: ${missingSession}` },
        }

        const get = yield* request(pathFor(SessionPaths.get, { sessionID: missingSession }), { headers })
        expect(get.status).toBe(404)
        expect(yield* responseJson(get)).toEqual(missingSessionBody)

        const exists = yield* request(pathFor(SessionPaths.exists, { sessionID: missingSession }), { headers })
        expect(exists.status).toBe(200)
        expect(yield* responseJson(exists)).toEqual({ exists: false })

        const children = yield* request(pathFor(SessionPaths.children, { sessionID: missingSession }), { headers })
        expect(children.status).toBe(404)
        expect(yield* responseJson(children)).toEqual(missingSessionBody)

        const todo = yield* request(pathFor(SessionPaths.todo, { sessionID: missingSession }), { headers })
        expect(todo.status).toBe(404)
        expect(yield* responseJson(todo)).toEqual(missingSessionBody)

        const messages = yield* request(pathFor(SessionPaths.messages, { sessionID: missingSession }), { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(missingSessionBody)

        const remove = yield* request(pathFor(SessionPaths.remove, { sessionID: missingSession }), {
          headers,
          method: "DELETE",
        })
        expect(remove.status).toBe(404)
        expect(yield* responseJson(remove)).toEqual(missingSessionBody)

        const session = yield* createSession({ title: "missing message" })
        const missingMessage = MessageID.ascending()
        const message = yield* request(
          pathFor(SessionPaths.message, { sessionID: session.id, messageID: missingMessage }),
          { headers },
        )
        expect(message.status).toBe(404)
        expect(yield* responseJson(message)).toEqual({
          name: "NotFoundError",
          data: { message: `Message not found: ${missingMessage}` },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const parent = yield* createSession({ title: "parent" })
        const child = yield* createSession({ title: "child", parentID: parent.id })
        const message = yield* createTextMessage(parent.id, "hello")
        yield* createTextMessage(parent.id, "world")

        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true`, { headers })
        expect(listed.map((item) => item.id)).toContain(parent.id)
        expect(Object.hasOwn(listed[0]!, "parentID")).toBe(false)

        expect(yield* requestJson<Record<string, unknown>>(SessionPaths.status, { headers })).toEqual({})

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: parent.id }), { headers }),
        ).toMatchObject({ id: parent.id, title: "parent" })

        expect(
          yield* requestJson<{ exists: boolean; session?: Session.Info }>(
            pathFor(SessionPaths.exists, { sessionID: parent.id }),
            { headers },
          ),
        ).toMatchObject({ exists: true, session: { id: parent.id, title: "parent" } })

        expect(
          (yield* requestJson<Session.Info[]>(pathFor(SessionPaths.children, { sessionID: parent.id }), {
            headers,
          })).map((item) => item.id),
        ).toEqual([child.id])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.todo, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.diff, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        const messages = yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1`, {
          headers,
        })
        const messagePage = yield* json<SessionV1.WithParts[]>(messages)
        const nextCursor = messages.headers["x-next-cursor"]
        expect(nextCursor).toBeTruthy()
        expect(messagePage[0]?.parts[0]).toMatchObject({ type: "text" })

        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?before=${nextCursor}`, {
            headers,
          })).status,
        ).toBe(400)
        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1&before=invalid`, {
            headers,
          })).status,
        ).toBe(400)

        expect(
          yield* requestJson<SessionV1.WithParts>(
            pathFor(SessionPaths.message, { sessionID: parent.id, messageID: message.info.id }),
            { headers },
          ),
        ).toMatchObject({ info: { id: message.info.id } })

        yield* insertLegacyAssistantMessage(parent.id)

        expect(
          (yield* requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${parent.id}/message`, {
            headers,
          })).data,
        ).toMatchObject([{ type: "assistant" }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.live(
    "uses the persisted session directory for prompt requests",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.text("ok", { usage: { input: 1, output: 1 } })

        const config = testProviderConfig(llm.url)
        const sessionDirectory = yield* tmpdirScoped({ git: true, config })
        const requestDirectory = yield* tmpdirScoped({ git: true, config })
        const session = yield* createSession({ title: "directory regression" }).pipe(
          provideInstanceEffect(sessionDirectory),
        )

        const response = yield* request(
          `/api/session/${session.id}/prompt?directory=${encodeURIComponent(requestDirectory)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", id: "test-model" },
              prompt: { text: "which directory?" },
            }),
          },
        )

        expect(response.status).toBe(200)
        yield* responseJson(response)
        const wait = yield* request(`/api/session/${session.id}/wait`, { method: "POST" })
        expect(wait.status).toBe(204)
        expect(
          (yield* requestJson<{ data: { type: string }[] }>(`/api/session/${session.id}/message`, {
            headers: { "x-opencode-directory": sessionDirectory },
          })).data.some((message) => message.type === "assistant"),
        ).toBe(true)
        expect(
          yield* Database.Service.use(({ db }) =>
            db
              .select({ model: SessionTable.model })
              .from(SessionTable)
              .where(eq(SessionTable.id, session.id))
              .get()
              .pipe(Effect.orDie),
          ),
        ).toEqual({ model: { providerID: "test", id: "test-model" } })
        expect(yield* llm.inputs).toHaveLength(1)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    { timeout: 15_000 },
  )

  it.instance(
    "returns v2 public request errors for cursor and workspace query failures",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 cursor" })
        const firstMessage = yield* insertLegacyAssistantMessage(session.id, 1, 2)
        const secondMessage = yield* insertLegacyAssistantMessage(session.id, 2, 1)

        const sessionPage = yield* request(
          `/api/session?${new URLSearchParams({
            limit: "1",
            order: "asc",
            directory: test.directory,
            search: "v2",
          })}`,
          { headers },
        )
        const sessionCursor = (yield* json<{ data: Session.Info[]; cursor: { next?: string } }>(sessionPage)).cursor
          .next
        expect(sessionCursor).toBeTruthy()
        expect(JSON.parse(Buffer.from(sessionCursor!, "base64url").toString("utf8"))).toMatchObject({
          order: "asc",
          directory: test.directory,
          search: "v2",
          anchor: { id: session.id, direction: "next" },
        })

        const sessionNextPage = yield* request(`/api/session?cursor=${sessionCursor}`, { headers })
        expect(sessionNextPage.status).toBe(200)

        const invalidSessionCursor = yield* request(`/api/session?cursor=invalid`, { headers })
        expect(invalidSessionCursor.status).toBe(400)
        expect(yield* responseJson(invalidSessionCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })

        const invalidWorkspace = yield* request(`/api/session?workspace=bad`, { headers })
        expect(invalidWorkspace.status).toBe(400)
        expect(yield* responseJson(invalidWorkspace)).toMatchObject({
          _tag: "InvalidRequestError",
          kind: "Query",
        })

        const messagePage = yield* request(`/api/session/${session.id}/message?limit=1`, { headers })
        const messageBody = yield* json<{ data: SessionMessage.Message[]; cursor: { next?: string } }>(messagePage)
        const messageCursor = messageBody.cursor.next
        expect(messageCursor).toBeTruthy()
        expect(messageBody.data.map((message) => message.id)).toEqual([secondMessage.id])
        expect(JSON.parse(Buffer.from(messageCursor!, "base64url").toString("utf8"))).toEqual({
          id: secondMessage.id,
          order: "desc",
          direction: "next",
        })

        const nextMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${messageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(nextMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const anchoredMessagePage = yield* request(
          `/api/session/${session.id}/message?${new URLSearchParams({
            anchor: firstMessage.id,
            limit: "2",
            order: "asc",
          })}`,
          { headers },
        )
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(anchoredMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id, secondMessage.id])

        const previousAnchorPage = yield* request(
          `/api/session/${session.id}/message?${new URLSearchParams({
            anchor: secondMessage.id,
            anchorMode: "previous",
            limit: "1",
            order: "asc",
          })}`,
          { headers },
        )
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(previousAnchorPage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const missingMessageID = MessageID.ascending()
        const missingAnchorPage = yield* request(`/api/session/${session.id}/message?anchor=${missingMessageID}`, {
          headers,
        })
        expect(missingAnchorPage.status).toBe(404)
        expect(yield* responseJson(missingAnchorPage)).toMatchObject({
          _tag: "MessageNotFoundError",
          messageID: missingMessageID,
        })

        const legacyMessageCursor = Buffer.from(
          JSON.stringify({ id: secondMessage.id, time: 1, order: "desc", direction: "next" }),
        ).toString("base64url")
        const legacyMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${legacyMessageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(legacyMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const messageCursorWithOrder = yield* request(
          `/api/session/${session.id}/message?cursor=${messageCursor}&order=asc`,
          { headers },
        )
        expect(messageCursorWithOrder.status).toBe(400)
        expect(yield* responseJson(messageCursorWithOrder)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Cursor cannot be combined with order",
        })

        const invalidMessageCursor = yield* request(`/api/session/${session.id}/message?cursor=invalid`, { headers })
        expect(invalidMessageCursor.status).toBe(400)
        expect(yield* responseJson(invalidMessageCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public not found errors for missing sessions",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const missing = SessionID.descending()
        const expected = {
          _tag: "SessionNotFoundError",
          sessionID: missing,
          message: `Session not found: ${missing}`,
        }

        const messages = yield* request(`/api/session/${missing}/message`, { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(expected)

        const context = yield* request(`/api/session/${missing}/context`, { headers })
        expect(context.status).toBe(404)
        expect(yield* responseJson(context)).toEqual(expected)

        const compact = yield* request(`/api/session/${missing}/compact`, { method: "POST", headers })
        expect(compact.status).toBe(404)
        expect(yield* responseJson(compact)).toEqual(expected)

        const wait = yield* request(`/api/session/${missing}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(404)
        expect(yield* responseJson(wait)).toEqual(expected)

        const resume = yield* request(`/api/session/${missing}/resume`, { method: "POST", headers })
        expect(resume.status).toBe(404)
        expect(yield* responseJson(resume)).toEqual(expected)

        const interrupt = yield* request(`/api/session/${missing}/interrupt`, { method: "POST", headers })
        expect(interrupt.status).toBe(404)
        expect(yield* responseJson(interrupt)).toEqual(expected)

        const synthetic = yield* request(`/api/session/${missing}/synthetic`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ text: "remember this" }),
        })
        expect(synthetic.status).toBe(404)
        expect(yield* responseJson(synthetic)).toEqual(expected)

        const switchAgent = yield* request(`/api/session/${missing}/agent`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ agent: "reviewer" }),
        })
        expect(switchAgent.status).toBe(404)
        expect(yield* responseJson(switchAgent)).toEqual(expected)

        const switchModel = yield* request(`/api/session/${missing}/model`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ model: { providerID: "test", id: "test-model" } }),
        })
        expect(switchModel.status).toBe(404)
        expect(yield* responseJson(switchModel)).toEqual(expected)

        const shell = yield* request(`/api/session/${missing}/shell`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ command: "echo missing" }),
        })
        expect(shell.status).toBe(404)
        expect(yield* responseJson(shell)).toEqual(expected)

        const command = yield* request(`/api/session/${missing}/command`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ command: "demo" }),
        })
        expect(command.status).toBe(404)
        expect(yield* responseJson(command)).toEqual(expected)

        const skill = yield* request(`/api/session/${missing}/skill`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ skill: "demo" }),
        })
        expect(skill.status).toBe(404)
        expect(yield* responseJson(skill)).toEqual(expected)

        const cancelTool = yield* request(`/api/session/${missing}/tool/call-missing/cancel`, {
          method: "POST",
          headers,
        })
        expect(cancelTool.status).toBe(404)
        expect(yield* responseJson(cancelTool)).toEqual(expected)

        const prompt = yield* request(`/api/session/${missing}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ prompt: { text: "hello" } }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(expected)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "interrupts an idle v2 session as a no-op",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 interrupt" })

        const interrupt = yield* request(`/api/session/${session.id}/interrupt`, { method: "POST", headers })
        expect(interrupt.status).toBe(204)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.live(
    "interrupts active v2 session work",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.hang

        const directory = yield* tmpdirScoped({
          git: true,
          config: {
            ...testProviderConfig(llm.url),
            session: { turn_completion: { enabled: true } },
          },
        })
        const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
        const forwarded: GlobalEvent[] = []
        const listener = (event: GlobalEvent) => forwarded.push(event)
        GlobalBus.on("event", listener)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", id: "test-model" },
            location: { directory },
          }),
        })

        const prompted = yield* request(`/api/session/${created.data.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", id: "test-model" },
            prompt: { text: "please hang" },
          }),
        })
        expect(prompted.status).toBe(200)
        yield* llm.wait(1)

        const interrupted = yield* request(`/api/session/${created.data.id}/interrupt`, { method: "POST", headers })
        expect(interrupted.status).toBe(204)

        yield* pollWithTimeout(
          Database.Service.use(({ db }) =>
            db
              .select({ status: SessionActivityTable.status })
              .from(SessionActivityTable)
              .where(eq(SessionActivityTable.session_id, SessionID.make(created.data.id)))
              .get()
              .pipe(
                Effect.orDie,
                Effect.map((activity) => (activity?.status === "interrupted" ? activity : undefined)),
              ),
          ),
          "active v2 session was not interrupted",
          "5 seconds",
        )
        yield* pollWithTimeout(
          Effect.sync(() =>
            forwarded.find(
              (event) =>
                event.payload.type === "session.turn.completed" &&
                event.payload.properties?.sessionID === created.data.id &&
                event.payload.properties.status === "incomplete",
            ),
          ),
          "interrupted v2 activity did not publish incomplete turn completion",
          "5 seconds",
        )
        expect(
          forwarded.filter(
            (event) =>
              event.payload.type === "session.turn.completed" &&
              event.payload.properties?.sessionID === created.data.id,
          ),
        ).toHaveLength(1)
        expect(yield* getLatestActivityCompletion(SessionID.make(created.data.id))).toMatchObject({
          status: "interrupted",
          completionState: "done",
          completionResult: "incomplete",
          completionAttempts: 1,
        })
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    10_000,
  )

  it.live(
    "terminalizes failed v2 session work once",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer

        const directory = yield* tmpdirScoped({
          git: true,
          config: {
            ...testProviderConfig(llm.url),
            session: { turn_completion: { enabled: true } },
          },
        })
        const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
        const forwarded: GlobalEvent[] = []
        const listener = (event: GlobalEvent) => forwarded.push(event)
        GlobalBus.on("event", listener)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", id: "test-model" },
            location: { directory },
          }),
        })
        yield* llm.pushMatch(
          (hit) => {
            const body = JSON.stringify(hit.body)
            return body.includes("fail this turn") && !body.includes("Generate a title for this conversation")
          },
          ...Array.from({ length: 4 }, () =>
            reply().text("partial provider response").pendingTool("bash", { command: "echo incomplete" }).toolCalls(),
          ),
        )

        expect(
          (yield* request(`/api/session/${created.data.id}/prompt`, {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt: { text: "fail this turn" } }),
          })).status,
        ).toBe(200)
        expect((yield* request(`/api/session/${created.data.id}/wait`, { method: "POST", headers })).status).toBe(204)

        expect(yield* getLatestActivityCompletion(SessionID.make(created.data.id))).toMatchObject({
          status: "failed",
          completionState: "done",
          completionResult: "incomplete",
          completionAttempts: 1,
        })
        expect(
          forwarded
            .filter(
              (event) =>
                event.payload.type === "session.turn.completed" &&
                event.payload.properties?.sessionID === created.data.id,
            )
            .map((event) => event.payload.properties?.status),
        ).toEqual(["incomplete"])
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    10_000,
  )

  it.live(
    "accepts an explicit v2 resume before provider work settles",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const gate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
        yield* llm.hold("resume accepted", gate.promise)

        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", id: "test-model" },
            location: { directory },
          }),
        })
        const prompted = yield* request(`/api/session/${created.data.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: { text: "resume accepted" }, resume: false }),
        })
        expect(prompted.status).toBe(200)

        const resumed = yield* request(`/api/session/${created.data.id}/resume`, { method: "POST", headers }).pipe(
          Effect.timeout("1 second"),
        )
        expect(resumed.status).toBe(204)
        yield* llm.wait(1)

        gate.resolve()
        expect((yield* request(`/api/session/${created.data.id}/wait`, { method: "POST", headers })).status).toBe(204)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    10_000,
  )

  it.live(
    "joins an active prompt resume without duplicating provider work",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const gate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
        yield* llm.hold("joined once", gate.promise)
        yield* llm.text("duplicate", { usage: { input: 1, output: 1 } })

        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", id: "test-model" },
            location: { directory },
          }),
        })
        expect(
          (yield* request(`/api/session/${created.data.id}/prompt`, {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt: { text: "join active work" } }),
          })).status,
        ).toBe(200)
        yield* llm.wait(1)

        const resumed = yield* request(`/api/session/${created.data.id}/resume`, { method: "POST", headers }).pipe(
          Effect.timeout("1 second"),
        )
        expect(resumed.status).toBe(204)

        gate.resolve()
        expect((yield* request(`/api/session/${created.data.id}/wait`, { method: "POST", headers })).status).toBe(204)
        const activityCount = yield* Database.Service.use(({ db }) =>
          db
            .select({ count: sql<number>`count(*)` })
            .from(SessionActivityTable)
            .where(eq(SessionActivityTable.session_id, SessionID.make(created.data.id)))
            .get()
            .pipe(Effect.orDie),
        )
        expect(activityCount?.count).toBe(1)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    10_000,
  )

  it.live(
    "waits for active v2 session work",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.text("done", { usage: { input: 1, output: 1 } })

        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", id: "test-model" },
            location: { directory },
          }),
        })

        const prompted = yield* request(`/api/session/${created.data.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: { text: "please answer" } }),
        })
        expect(prompted.status).toBe(200)

        const waited = yield* request(`/api/session/${created.data.id}/wait`, { method: "POST", headers })
        expect(waited.status).toBe(204)
        yield* llm.wait(1)

        const messages = yield* requestJson<{ data: SessionMessage.Message[] }>(
          `/api/session/${created.data.id}/message`,
          {
            headers,
          },
        )
        expect(messages.data.some((message) => message.type === "assistant")).toBe(true)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    10_000,
  )

  it.live(
    "forwards V2 prompt activity through the shared OpenCode event bridge",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const gate = Promise.withResolvers<void>()
        yield* llm.hold("bridged", gate.promise)

        const directory = yield* tmpdirScoped({
          git: true,
          config: {
            ...testProviderConfig(llm.url),
            session: { turn_completion: { enabled: true } },
          },
        })
        const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
        const forwarded: GlobalEvent[] = []
        const listener = (event: GlobalEvent) => forwarded.push(event)
        GlobalBus.on("event", listener)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", id: "test-model" },
            location: { directory },
          }),
        })
        const prompted = yield* request(`/api/session/${created.data.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: { text: "bridge this activity" } }),
        })
        expect(prompted.status).toBe(200)
        yield* llm.wait(1)
        expect(
          (yield* requestJson<Record<string, { type: string }>>(SessionPaths.status, { headers }))[created.data.id],
        ).toEqual({ type: "busy" })
        gate.resolve()
        expect((yield* request(`/api/session/${created.data.id}/wait`, { method: "POST", headers })).status).toBe(204)

        const raw = forwarded
          .filter((event) => event.payload.properties?.sessionID === created.data.id)
          .map((event) => event.payload.type)
        expect(raw).toContain("session.next.activity.started")
        expect(raw).toContain("session.next.text.ended")
        expect(raw).toContain("session.next.activity.completed")
        const sync = forwarded.flatMap((event) =>
          event.payload.type === "sync" && event.payload.syncEvent?.data.sessionID === created.data.id
            ? [event.payload.syncEvent.type]
            : [],
        )
        expect(sync).toContain("session.next.activity.started.1")
        expect(sync).toContain("session.next.text.ended.1")
        expect(sync).toContain("session.next.activity.completed.1")
        expect(
          forwarded
            .filter(
              (event) =>
                event.payload.type === "session.turn.completed" &&
                event.payload.properties?.sessionID === created.data.id,
            )
            .map((event) => event.payload.properties?.status),
        ).toEqual(["done"])
        expect(yield* getLatestActivityCompletion(SessionID.make(created.data.id))).toMatchObject({
          status: "completed",
          completionState: "done",
          completionResult: "done",
          completionAttempts: 1,
        })
        expect(
          (yield* requestJson<Record<string, { type: string }>>(SessionPaths.status, { headers }))[created.data.id],
        ).toBeUndefined()
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    10_000,
  )

  it.live(
    "uses the ordinary done completion state for the plan preset",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.text("plan complete", { usage: { input: 1, output: 1 } })
        const directory = yield* tmpdirScoped({
          git: true,
          config: {
            ...testProviderConfig(llm.url),
            session: { turn_completion: { enabled: true } },
          },
        })
        const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
        const forwarded: GlobalEvent[] = []
        const listener = (event: GlobalEvent) => forwarded.push(event)
        GlobalBus.on("event", listener)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "plan",
            model: { providerID: "test", id: "test-model" },
            location: { directory },
          }),
        })

        expect(
          (yield* request(`/api/session/${created.data.id}/prompt`, {
            method: "POST",
            headers,
            body: JSON.stringify({ agent: "plan", prompt: { text: "make a plan" } }),
          })).status,
        ).toBe(200)
        expect((yield* request(`/api/session/${created.data.id}/wait`, { method: "POST", headers })).status).toBe(204)

        expect(
          forwarded
            .filter(
              (event) =>
                event.payload.type === "session.turn.completed" &&
                event.payload.properties?.sessionID === created.data.id,
            )
            .map((event) => event.payload.properties?.status),
        ).toEqual(["done"])
        expect(yield* getLatestActivityCompletion(SessionID.make(created.data.id))).toMatchObject({
          status: "completed",
          completionState: "done",
          completionResult: "done",
          completionAttempts: 1,
        })
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    10_000,
  )

  it.live(
    "includes project skills in v2 prompt context",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.text("skill context ok", { usage: { input: 1, output: 1 } })

        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        yield* Effect.promise(async () => {
          await mkdir(path.join(directory, ".opencode", "skills", "project-rest-skill"), { recursive: true })
          await Bun.write(
            path.join(directory, ".opencode", "skills", "project-rest-skill", "SKILL.md"),
            [
              "---",
              "name: project-rest-skill",
              "description: A project skill visible to V2 prompts.",
              "---",
              "",
              "# Project REST Skill",
            ].join("\n"),
          )
        })
        const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", id: "test-model" },
            location: { directory },
          }),
        })

        const prompted = yield* request(`/api/session/${created.data.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", id: "test-model" },
            prompt: { text: "hello skill context" },
          }),
        })
        expect(prompted.status).toBe(200)
        const waited = yield* request(`/api/session/${created.data.id}/wait`, { method: "POST", headers })
        expect(waited.status).toBe(204)
        yield* llm.wait(1)
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs[0])).toContain("project-rest-skill")
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    10_000,
  )

  it.instance(
    "resolves v2 command templates into durable prompts",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const attachment = path.join(test.directory, "demo.txt")
        yield* Effect.promise(() => Bun.write(attachment, "demo attachment"))
        const attachmentUri = pathToFileURL(attachment).href
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ agent: "build", location: { directory: test.directory } }),
        })

        const response = yield* request(`/api/session/${created.data.id}/command`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: "msg_http_command",
            command: "demo",
            arguments: "hello world",
            files: [{ uri: attachmentUri, mime: "text/plain", name: "demo.txt" }],
            resume: false,
          }),
        })
        const responseText = yield* response.text
        expect(response.status, responseText).toBe(200)

        const body = JSON.parse(responseText) as {
          data: {
            id: string
            delivery: string
            prompt: { text: string; files?: { uri: string; mime: string; name?: string }[] }
          }
        }
        expect(body.data).toMatchObject({
          id: "msg_http_command",
          delivery: "steer",
          prompt: {
            files: [{ uri: expect.stringMatching(/^attachment:\/\//), mime: "text/plain", name: "demo.txt" }],
          },
        })
        expect(body.data.prompt.text).toBe("Hooked command: hello world")

        const messages = yield* requestJson<{ data: SessionMessage.Message[] }>(
          `/api/session/${created.data.id}/message`,
          {
            headers,
          },
        )
        expect(messages.data).toHaveLength(0)

        const input = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_http_command")))
            .get()
            .pipe(Effect.orDie),
        )
        expect(input).toMatchObject({
          id: "msg_http_command",
          session_id: created.data.id,
          delivery: "steer",
          promoted_seq: null,
        })

        const agentModelResponse = yield* request(`/api/session/${created.data.id}/command`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: "msg_http_command_agent_model",
            command: "agent-model-demo",
            model: { providerID: "test", id: "request-model" },
            resume: false,
          }),
        })
        const agentModelText = yield* agentModelResponse.text
        expect(agentModelResponse.status, agentModelText).toBe(200)
        const agentModelBody = JSON.parse(agentModelText) as {
          data: { prompt: { agent?: string; model?: { providerID: string; id: string } } }
        }
        expect(agentModelBody.data.prompt).toMatchObject({
          agent: "command-agent",
          model: { providerID: "test", id: "request-model" },
        })
      }),
    {
      git: true,
      config: {
        formatter: false,
        lsp: false,
        plugin: [commandHookPlugin],
        agent: {
          "command-agent": { model: "test/agent-model" },
        },
        command: {
          demo: { template: "Demo $1\nArguments: $ARGUMENTS\n!`echo dynamic`" },
          "agent-model-demo": { template: "Agent model demo", agent: "command-agent" },
        },
      },
    },
    10_000,
  )

  it.instance(
    "uses the current v2 session model when a same-agent command has no model override",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const created = yield* requestJson<{ data: { id: string; model?: { providerID: string; id: string } } }>(
          "/api/session",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "openai", id: "gpt-5.6-luna" },
              location: { directory: test.directory },
            }),
          },
        )

        expect(created.data.model).toMatchObject({ providerID: "openai", id: "gpt-5.6-luna" })

        const switched = yield* request(`/api/session/${created.data.id}/model`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: { providerID: "openrouter", id: "openrouter/free" } }),
        })
        expect(switched.status).toBe(204)

        const response = yield* request(`/api/session/${created.data.id}/command`, {
          method: "POST",
          headers,
          body: JSON.stringify({ command: "demo", arguments: "session model", resume: false }),
        })
        const responseText = yield* response.text
        expect(response.status, responseText).toBe(200)

        const body = JSON.parse(responseText) as {
          data: { prompt: { model?: { providerID: string; id: string } } }
        }
        expect(body.data.prompt.model).toMatchObject({ providerID: "openrouter", id: "openrouter/free" })
      }),
    {
      git: true,
      config: {
        formatter: false,
        lsp: false,
        command: { demo: { template: "Demo $ARGUMENTS", agent: "build" } },
      },
    },
    30_000,
  )

  it.instance(
    "preserves the focused goal until stateful goal command hooks run",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ location: { directory: test.directory } }),
        })
        const send = (id: string, args: string) => requestJson<{ data: { prompt: { text: string } } }>(
          `/api/session/${created.data.id}/command`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id, command: "goal-control-probe", arguments: args, resume: false }),
          },
        )
        yield* send("msg_goal_original", "set original goal")
        for (const [index, args] of ["add second goal", "edit revised goal", "sisyphus first; second"].entries()) {
          const response = yield* send(`msg_goal_operation_${index}`, args)
          expect(JSON.parse(response.data.prompt.text)).toEqual({ arguments: args })
          const current = yield* requestJson<{ data: { metadata?: Record<string, unknown> } }>(
            `/api/session/${created.data.id}`, { headers },
          )
          expect(current.data.metadata).toEqual({ "opencode.session.goal": "original goal", "opencode.session.goal_run": expect.any(String) })
        }
      }),
    {
      git: true,
      config: {
        formatter: false,
        lsp: false,
        plugin: [goalCommandObserver],
        command: { "goal-control-probe": { template: "$ARGUMENTS", action: "session-goal" } },
      },
    },
    30_000,
  )

  it.instance(
    "applies declarative session-goal controls before any optional provider turn",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ location: { directory: test.directory } }),
        })
        const sessionPath = `/api/session/${created.data.id}`

        const sendGoalCommand = (id: string, argumentsText: string) =>
          request(`${sessionPath}/command`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id, command: "session-goal-control", arguments: argumentsText, resume: false }),
          })
        const sessionInfo = () =>
          requestJson<{ data: { metadata?: Record<string, unknown> } }>(sessionPath, { headers })

        expect((yield* sendGoalCommand("msg_goal_set", "set ship it")).status).toBe(200)
        const firstGoal = (yield* sessionInfo()).data.metadata
        expect(firstGoal).toEqual({ "opencode.session.goal": "ship it", "opencode.session.goal_run": expect.any(String) })
        expect((yield* sendGoalCommand("msg_goal_set", "set ship it")).status).toBe(200)
        expect((yield* sessionInfo()).data.metadata).toEqual(firstGoal)

        expect((yield* sendGoalCommand("msg_goal_set_again", "set ship it")).status).toBe(200)
        const secondGoal = (yield* sessionInfo()).data.metadata
        expect(secondGoal).toEqual({ "opencode.session.goal": "ship it", "opencode.session.goal_run": expect.any(String) })
        expect(secondGoal?.["opencode.session.goal_run"]).not.toBe(firstGoal?.["opencode.session.goal_run"])
        expect((yield* sendGoalCommand("msg_goal_set", "set ship it")).status).toBe(200)
        expect((yield* sessionInfo()).data.metadata).toEqual(secondGoal)
        expect((yield* sendGoalCommand("msg_goal_set", "set different")).status).toBe(409)
        expect((yield* sessionInfo()).data.metadata).toEqual(secondGoal)

        expect((yield* sendGoalCommand("msg_goal_status", "status")).status).toBe(200)
        expect((yield* sessionInfo()).data.metadata).toEqual(secondGoal)

        expect((yield* sendGoalCommand("msg_goal_edit", "edit updated goal")).status).toBe(200)
        expect((yield* sessionInfo()).data.metadata).toEqual(secondGoal)

        expect((yield* sendGoalCommand("msg_goal_add", "add final goal")).status).toBe(200)
        expect((yield* sessionInfo()).data.metadata).toEqual(secondGoal)

        expect((yield* sendGoalCommand("msg_goal_focus", "focus now")).status).toBe(200)
        expect((yield* sessionInfo()).data.metadata).toEqual(secondGoal)

        expect((yield* sendGoalCommand("msg_goal_clear", "clear")).status).toBe(200)
        expect((yield* sessionInfo()).data.metadata).toEqual({})
      }),
    {
      git: true,
      config: {
        formatter: false,
        lsp: false,
        command: {
          "session-goal-control": { template: "Goal control $ARGUMENTS", action: "session-goal" },
        },
      },
    },
    10_000,
  )

  if (!mcpTransientChild) {
    test(
      mcpTransientTestName,
      async () => {
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            "test",
            "test/server/httpapi-session.test.ts",
            "-t",
            mcpTransientTestName,
            "--timeout",
            "30000",
          ],
          cwd: path.resolve(import.meta.dir, "../.."),
          env: { ...process.env, OPENCODE_HTTPAPI_MCP_TRANSIENT_CHILD: "1" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        const output = `${stdout}\n${stderr}`
        expect(exitCode, output).toBe(0)
        expect(output).toContain("3 expect() calls")
      },
      60_000,
    )
  }
  if (mcpTransientChild)
    it.live(
      mcpTransientTestName,
      () =>
        Effect.gen(function* () {
          const promptAttempts = path.join(
            process.env.TEMP ?? process.env.TMP ?? process.cwd(),
            `opencode-mcp-prompt-attempts-${process.pid}.txt`,
          )
          yield* Effect.addFinalizer(() =>
            Effect.promise(() =>
              Bun.file(promptAttempts)
                .delete()
                .catch(() => {}),
            ),
          )
          const mcpPromptServer = `import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { GetPromptRequestSchema, ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

const server = new Server({ name: "demo", version: "1.0.0" }, { capabilities: { prompts: {} } })
const attemptsPath = ${JSON.stringify(promptAttempts)}

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  const promptListAttempts = existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, "utf8")) + 1 : 1
  writeFileSync(attemptsPath, String(promptListAttempts))
  if (promptListAttempts === 1) throw new Error("transient prompt discovery failure")
  return {
    prompts: [
      {
        name: "brief",
        description: "Create a project brief",
        arguments: [
          { name: "topic", description: "Topic", required: true },
          { name: "scope", description: "Scope", required: true },
        ],
      },
    ],
  }
})

server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
  messages: [
    {
      role: "user",
      content: {
        type: "text",
        text: \`MCP topic=\${request.params.arguments?.topic} scope=\${request.params.arguments?.scope}\`,
      },
    },
  ],
}))

await server.connect(new StdioServerTransport())`
          const directory = yield* tmpdirScoped({
            git: true,
            config: {
              formatter: false,
              lsp: false,
              command: {},
              mcp: {
                demo: {
                  type: "local",
                  command: [process.execPath, "--eval", mcpPromptServer],
                  cwd: process.cwd(),
                  timeout: 5_000,
                },
              },
            },
          })
          const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
          const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
            method: "POST",
            headers,
            body: JSON.stringify({ agent: "build", location: { directory } }),
          })

          const response = yield* request(`/api/session/${created.data.id}/command`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              id: "msg_http_mcp_command",
              command: "demo:brief",
              arguments: "v2-cutover final path",
              resume: false,
            }),
          })
          const responseText = yield* response.text
          expect(response.status, responseText).toBe(200)
          const body = JSON.parse(responseText) as { data: { prompt: { text: string } } }
          expect(body.data.prompt.text).toBe("MCP topic=v2-cutover scope=final path")

          const input = yield* Database.Service.use(({ db }) =>
            db
              .select()
              .from(SessionInputTable)
              .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_http_mcp_command")))
              .get()
              .pipe(Effect.orDie),
          )
          expect(input).toMatchObject({
            id: "msg_http_mcp_command",
            session_id: created.data.id,
            delivery: "steer",
            promoted_seq: null,
          })
        }).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer)),
      30_000,
    )

  it.instance(
    "returns public errors for missing v2 commands",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ agent: "build", location: { directory: test.directory } }),
        })

        const missing = yield* request(`/api/session/${created.data.id}/command`, {
          method: "POST",
          headers,
          body: JSON.stringify({ command: "missing", resume: false }),
        })
        expect(missing.status).toBe(400)
        expect(yield* responseJson(missing)).toMatchObject({
          _tag: "InvalidRequestError",
          field: "command",
          kind: "command_not_found",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    10_000,
  )

  it.live(
    "runs v2 subtask commands through the task tool",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.text("child subtask done", { usage: { input: 1, output: 1 } })

        const directory = yield* tmpdirScoped({
          git: true,
          config: {
            ...testProviderConfig(llm.url),
            permission: { task: "allow" },
            command: {
              delegate: { template: "Delegate $ARGUMENTS", subtask: true },
            },
          },
          // The private mirror copies tracked files only. This fixture's local
          // provider configuration is deliberately part of its repository.
          init: (directory) => Effect.promise(async () => {
            const child = Bun.spawn(["git", "add", "--", "opencode.json"], {
              cwd: directory, stdout: "ignore", stderr: "pipe",
            })
            if (await child.exited !== 0) throw new Error("Could not index fixture provider config")
          }),
        })
        const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ agent: "build", location: { directory } }),
        })

        const commandBody = JSON.stringify({
          id: SessionMessage.ID.create(), command: "delegate", arguments: "real work",
          model: { providerID: "test", id: "test-model" },
        })
        const response = yield* request(`/api/session/${created.data.id}/command`, {
          method: "POST",
          headers,
          body: commandBody,
        })
        const responseText = yield* response.text
        expect(response.status, responseText).toBe(200)

        const completed = yield* pollWithTimeout(
          Effect.gen(function* () {
            const messages = yield* requestJson<{ data: SessionMessage.Message[] }>(
              `/api/session/${created.data.id}/message`,
              { headers },
            )
            const assistant = messages.data.find(
              (message): message is SessionMessage.Assistant => message.type === "assistant",
            )
            const tool = assistant?.content.find(
              (part): part is SessionMessage.AssistantTool => part.type === "tool" && part.name === "task",
            )
            return tool?.state.status === "completed" || tool?.state.status === "error" ? tool.state : undefined
          }),
          "v2 subtask command did not produce a terminal task tool",
          "5 seconds",
        )
        expect(completed.status, JSON.stringify(completed)).toBe("completed")
        expect(completed.structured).toMatchObject({ state: "completed", text: "child subtask done" })
        yield* llm.wait(1)
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs)).toContain("Delegate real work")
        expect(completed.content.some((part) => part.type === "text" && part.text.includes("child subtask done"))).toBe(
          true,
        )
        expect((yield* request(`/api/session/${created.data.id}/wait`, { method: "POST", headers })).status).toBe(204)
        const retried = yield* request(`/api/session/${created.data.id}/command`, {
          method: "POST", headers, body: commandBody,
        })
        expect(retried.status).toBe(200)
        expect((yield* request(`/api/session/${created.data.id}/wait`, { method: "POST", headers })).status).toBe(204)
        expect(yield* llm.inputs).toHaveLength(1)
        const children = yield* requestJson<Session.Info[]>(pathFor(SessionPaths.children, { sessionID: created.data.id }), { headers })
        expect(children).toHaveLength(1)
        expect(children[0]?.directory).not.toBe(directory)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    // Includes mirror setup, complete settlement, exact retry and both runtimes' cleanup.
    20_000,
  )

  it.live("refuses denied subtask commands without child or provider work", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: {
        ...testProviderConfig(llm.url), permission: { task: "deny" },
        command: { delegate: { template: "Delegate $ARGUMENTS", subtask: true } },
      } })
      const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
      const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
        method: "POST", headers, body: JSON.stringify({ agent: "build", location: { directory } }),
      })
      const response = yield* request(`/api/session/${created.data.id}/command`, {
        method: "POST", headers, body: JSON.stringify({ command: "delegate", arguments: "denied work",
          model: { providerID: "test", id: "test-model" } }),
      })
      expect(response.status).toBe(200)
      expect((yield* request(`/api/session/${created.data.id}/wait`, { method: "POST", headers })).status).toBe(204)
      const messages = yield* requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${created.data.id}/message`, { headers })
      const assistant = messages.data.find((message): message is SessionMessage.Assistant => message.type === "assistant")
      const tool = assistant?.content.find((part): part is SessionMessage.AssistantTool => part.type === "tool" && part.name === "task")
      expect(tool?.state.status).toBe("error")
      expect(yield* llm.inputs).toHaveLength(0)
      expect(yield* requestJson<Session.Info[]>(pathFor(SessionPaths.children, { sessionID: created.data.id }), { headers })).toHaveLength(0)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)), 10_000,
  )

  it.instance(
    "denies skill command and synthetic injection before shell expansion",
    () => Effect.gen(function* () {
      const test = yield* TestInstance
      const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
      const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
        method: "POST", headers, body: JSON.stringify({ agent: "build", location: { directory: test.directory } }),
      })
      const list = yield* requestJson<{ data: { name: string; effective?: { invocation: string; visible: boolean } }[] }>("/api/skill", { headers })
      expect(list.data.find((skill) => skill.name === "blocked")?.effective).toMatchObject({ invocation: "manual", visible: false })
      for (const [endpoint, body] of [
        ["command", { command: "blocked", resume: false }],
        ["skill", { skill: "blocked" }],
      ] as const) {
        const response = yield* request(`/api/session/${created.data.id}/${endpoint}`, {
          method: "POST", headers, body: JSON.stringify(body),
        })
        expect(response.status).toBe(400)
      }
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, "skill-side-effect.txt")).exists())).toBe(false)
      const messages = yield* requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${created.data.id}/message`, { headers })
      expect(messages.data.some((message) => message.type === "synthetic")).toBe(false)
    }),
    {
      git: true,
      config: { formatter: false, lsp: false, permission: { skill: { blocked: "deny" } } },
      init: (directory) => Effect.promise(async () => {
        const skill = path.join(directory, ".agents", "skills", "blocked")
        await mkdir(skill, { recursive: true })
        await Bun.write(path.join(skill, "SKILL.md"), "---\nname: blocked\ndescription: blocked skill\ndisable-model-invocation: true\n---\n!`echo unsafe > skill-side-effect.txt`\n")
      }),
    },
    30_000,
  )

  it.instance(
    "requires bash permission before expanding an allowed skill command",
    () => Effect.gen(function* () {
      const test = yield* TestInstance
      const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
      const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
        method: "POST", headers, body: JSON.stringify({ agent: "build", location: { directory: test.directory } }),
      })
      const response = yield* request(`/api/session/${created.data.id}/command`, {
        method: "POST", headers, body: JSON.stringify({ command: "shell-skill", resume: false }),
      })
      expect(response.status).toBe(400)
      expect(yield* response.text).toContain("Skill shell expansion denied")
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, "skill-side-effect.txt")).exists())).toBe(false)
    }),
    {
      git: true,
      config: { formatter: false, lsp: false, permission: { skill: "allow", bash: "deny" } },
      init: (directory) => Effect.promise(async () => {
        const skill = path.join(directory, ".agents", "skills", "shell-skill")
        await mkdir(skill, { recursive: true })
        await Bun.write(path.join(skill, "SKILL.md"), "---\nname: shell-skill\ndescription: shell skill\n---\n!`echo unsafe > skill-side-effect.txt`\n")
      }),
    },
    30_000,
  )

  it.instance(
    "injects v2 skill content as a synthetic message",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const directory = path.join(test.directory, "workspace")
        yield* Effect.promise(() => mkdir(directory, { recursive: true }))
        const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ agent: "build", location: { directory } }),
        })

        const response = yield* request(`/api/session/${created.data.id}/skill`, {
          method: "POST",
          headers,
          body: JSON.stringify({ skill: "demo" }),
        })
        expect(response.status).toBe(204)

        const messages = yield* requestJson<{ data: SessionMessage.Message[] }>(
          `/api/session/${created.data.id}/message`,
          {
            headers,
          },
        )
        const synthetic = messages.data.find(
          (message): message is SessionMessage.Synthetic => message.type === "synthetic",
        )
        expect(synthetic?.text).toContain('<skill_content name="demo">')
        expect(synthetic?.text).toContain("Use demo guidance.")

        const traversal = yield* request(`/api/session/${created.data.id}/skill`, {
          method: "POST",
          headers,
          body: JSON.stringify({ skill: "../../outside" }),
        })
        expect(traversal.status).toBe(400)
        expect(yield* traversal.text).toContain("Skill not found")
      }),
    {
      git: true,
      config: { formatter: false, lsp: false },
      init: (directory) =>
        Effect.promise(async () => {
          await mkdir(path.join(directory, ".agents", "skills", "demo"), { recursive: true })
          await Bun.write(
            path.join(directory, ".agents", "skills", "demo", "SKILL.md"),
            "---\nname: demo\ndescription: Demo skill\n---\n# Demo Skill\n\nUse demo guidance.",
          )
        }),
    },
    30_000,
  )

  it.instance(
    "runs v2 shell commands through shell messages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ agent: "build", location: { directory: test.directory } }),
        })

        const response = yield* request(`/api/session/${created.data.id}/shell`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            command: `"${process.execPath.replaceAll("\\", "/")}" -e "console.log('shell-ok')"`,
          }),
        })
        expect(response.status).toBe(204)

        const messages = yield* requestJson<{ data: SessionMessage.Message[] }>(
          `/api/session/${created.data.id}/message`,
          {
            headers,
          },
        )
        const shell = messages.data.find((message): message is SessionMessage.Shell => message.type === "shell")
        expect(shell?.command).toContain("shell-ok")
        expect(shell?.output).toContain("shell-ok")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "switches v2 agent and model without scheduling execution",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "v2 switch context" })
        const model = { providerID: "test", id: "test-model", variant: "high" }

        const agentResponse = yield* request(`/api/session/${session.id}/agent`, {
          method: "POST",
          headers,
          body: JSON.stringify({ agent: "reviewer" }),
        })
        const modelResponse = yield* request(`/api/session/${session.id}/model`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model }),
        })
        expect(agentResponse.status).toBe(204)
        expect(modelResponse.status).toBe(204)

        const info = yield* requestJson<{ data: { agent?: string; model?: typeof model } }>(
          `/api/session/${session.id}`,
          { headers },
        )
        expect(info.data).toMatchObject({ agent: "reviewer", model })

        const messages = yield* requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${session.id}/message`, {
          headers,
        })
        expect(messages.data.map((message) => message.type)).toEqual(["model-switched", "agent-switched"])

        const activities = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(SessionActivityTable)
            .where(eq(SessionActivityTable.session_id, session.id))
            .all()
            .pipe(Effect.orDie),
        )
        expect(activities).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
    10_000,
  )

  it.instance(
    "rejects agent-and-prompt handoffs without an active target switch capability",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "v2 forged handoff" })
        const response = yield* request(`/api/session/${session.id}/switch-agent-and-prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "plan",
            prompt: { text: "This must not be admitted" },
            confirmation: {
              requestID: "que_forged",
              revision: 1,
              actionID: "handoff",
              invocationID: "inv_forged",
              token: "forged",
            },
          }),
        })

        expect(response.status).toBe(400)
        const info = yield* requestJson<{ data: { agent?: string } }>(`/api/session/${session.id}`, { headers })
        expect(info.data.agent).not.toBe("plan")
        const messages = yield* requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${session.id}/message`, {
          headers,
        })
        expect(messages.data).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
    10_000,
  )

  for (const currentAgent of ["plan", "build"]) it.instance(
    `accepts one exact Daily Review confirmation from ${currentAgent} and reuses its completed invocation`,
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "v2 confirmed handoff", agent: currentAgent })
        const planDocument = yield* Database.Service.use((database) =>
          SessionPlanDocument.Service.use((service) =>
            service.replace({ sessionID: SessionSchema.ID.make(session.id), markdown: dailyReviewPlanMarkdown }),
          ).pipe(
            Effect.provide(SessionPlanDocument.layer.pipe(Layer.provide(Layer.succeed(Database.Service, database)))),
          ),
        )
        const pending = yield* Surface.Service.use((service) =>
          service.present({
            sessionID: SessionSchema.ID.make(session.id),
            mode: "interactive",
            surface: dailyReviewSurface(planDocument),
            tool: {
              name: "switch_agent",
              confirmationToken: "confirmed-agent-handoff",
              purpose: "daily_review_implementation",
              authorizationScope: "accepted-items-in-plan-snapshot",
              planDocument: {
                revision: planDocument.revision,
                updatedAt: planDocument.updatedAt,
                sha256: createHash("sha256").update(planDocument.markdown).digest("hex"),
                markdown: planDocument.markdown,
              },
              messageID: "msg_confirmed_handoff",
              callID: "call_confirmed_handoff",
            },
          }),
        ).pipe(Effect.provide(Surface.layer.pipe(Layer.provide(EventV2.defaultLayer))))
        const payload = {
          agent: "build",
          prompt: { text: AgentSwitchTool.dailyReviewBuildPrompt },
          confirmation: {
            requestID: pending.id,
            revision: pending.revision,
            actionID: "handoff",
            invocationID: "inv_confirmed_handoff",
            token: "confirmed-agent-handoff",
          },
        }
        const handoff = () =>
          request(`/api/session/${session.id}/switch-agent-and-prompt`, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          })

        const first = yield* handoff()
        const retried = yield* handoff()
        expect(first.status).toBe(200)
        const retryError = retried.status === 200 ? "" : yield* retried.text
        expect({ status: retried.status, error: retryError }).toEqual({ status: 200, error: "" })
        const firstBody = yield* responseJson(first)
        const retriedBody = yield* responseJson(retried)
        expect(firstBody).toEqual(retriedBody)
        const invocations = yield* Surface.Service.use((service) =>
          service.actionInvocations(SessionSchema.ID.make(session.id)),
        ).pipe(Effect.provide(Surface.layer.pipe(Layer.provide(EventV2.defaultLayer))))
        expect(invocations).toEqual([
          expect.objectContaining({
            invocation: expect.objectContaining({ state: "completed", source: "switch_agent" }),
            request: expect.objectContaining({
              sessionID: session.id,
              tool: expect.objectContaining({
                purpose: "daily_review_implementation",
                authorizationScope: "accepted-items-in-plan-snapshot",
                planDocument: expect.objectContaining({ revision: planDocument.revision, markdown: dailyReviewPlanMarkdown }),
              }),
            }),
          }),
        ])

        const tampered = yield* request(`/api/session/${session.id}/switch-agent-and-prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...payload, prompt: { text: "Changed after confirmation" } }),
        })
        expect(tampered.status).toBe(400)

        const info = yield* requestJson<{ data: { agent?: string } }>(`/api/session/${session.id}`, { headers })
        expect(info.data.agent).toBe("build")
        const inputs = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.session_id, session.id))
            .all()
            .pipe(Effect.orDie),
        )
        expect(inputs).toHaveLength(1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "rejects a stale Daily Review plan snapshot before claiming or mutating a handoff",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "v2 stale Daily Review handoff", agent: "plan" })
        const original = yield* Database.Service.use((database) =>
          SessionPlanDocument.Service.use((service) =>
            service.replace({ sessionID: SessionSchema.ID.make(session.id), markdown: dailyReviewPlanMarkdown }),
          ).pipe(
            Effect.provide(SessionPlanDocument.layer.pipe(Layer.provide(Layer.succeed(Database.Service, database)))),
          ),
        )
        const pending = yield* Surface.Service.use((service) =>
          service.present({
            sessionID: SessionSchema.ID.make(session.id),
            mode: "interactive",
            surface: dailyReviewSurface(original),
            tool: {
              name: "switch_agent",
              confirmationToken: "stale-agent-handoff",
              purpose: "daily_review_implementation",
              authorizationScope: "accepted-items-in-plan-snapshot",
              planDocument: {
                revision: original.revision,
                updatedAt: original.updatedAt,
                sha256: createHash("sha256").update(original.markdown).digest("hex"),
                markdown: original.markdown,
              },
              messageID: "msg_stale_handoff",
              callID: "call_stale_handoff",
            },
          }),
        ).pipe(Effect.provide(Surface.layer.pipe(Layer.provide(EventV2.defaultLayer))))
        expect(AgentSwitchTool.confirmation(pending, {
          sessionID: session.id,
          revision: pending.revision,
          actionID: "handoff",
          agent: "build",
          prompt: AgentSwitchTool.dailyReviewBuildPrompt,
          confirmationToken: "stale-agent-handoff",
          planDocument: original,
        })).toBeDefined()
        yield* Database.Service.use((database) =>
          SessionPlanDocument.Service.use((service) =>
            service.replace({
              sessionID: SessionSchema.ID.make(session.id),
              markdown: "Updated Daily Review",
              expectedRevision: original.revision,
            }),
          ).pipe(
            Effect.provide(SessionPlanDocument.layer.pipe(Layer.provide(Layer.succeed(Database.Service, database)))),
          ),
        )

        const response = yield* request(`/api/session/${session.id}/switch-agent-and-prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            prompt: { text: AgentSwitchTool.dailyReviewBuildPrompt },
            confirmation: {
              requestID: pending.id,
              revision: pending.revision,
              actionID: "handoff",
              invocationID: "inv_stale_daily_handoff",
              token: "stale-agent-handoff",
            },
          }),
        })
        expect(response.status).toBe(400)

        const invocations = yield* Surface.Service.use((service) =>
          service.actionInvocations(SessionSchema.ID.make(session.id)),
        ).pipe(Effect.provide(Surface.layer.pipe(Layer.provide(EventV2.defaultLayer))))
        expect(invocations).toEqual([])
        const info = yield* requestJson<{ data: { agent?: string } }>(`/api/session/${session.id}`, { headers })
        expect(info.data.agent).toBe("plan")
        const inputs = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.session_id, session.id))
            .all()
            .pipe(Effect.orDie),
        )
        expect(inputs).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "appends synthetic v2 messages without scheduling execution",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "v2 synthetic" })

        const response = yield* request(`/api/session/${session.id}/synthetic`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "msg_http_synthetic", text: "remember this" }),
        })
        expect(response.status).toBe(204)

        const messages = yield* requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${session.id}/message`, {
          headers,
        })
        expect(messages.data).toMatchObject([
          { id: "msg_http_synthetic", sessionID: session.id, type: "synthetic", text: "remember this" },
        ])

        const input = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_http_synthetic")))
            .get()
            .pipe(Effect.orDie),
        )
        expect(input).toBeUndefined()

        const activities = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(SessionActivityTable)
            .where(eq(SessionActivityTable.session_id, session.id))
            .all()
            .pipe(Effect.orDie),
        )
        expect(activities).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
    10_000,
  )

  it.instance(
    "durably records one v2 prompt for exact message-ID retries",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 prompt recording" })

        const recordPrompt = () =>
          request(`/api/session/${session.id}/prompt`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "hello" }, resume: false }),
          })
        const first = yield* recordPrompt()
        const retried = yield* recordPrompt()
        type PromptBody = { id: string; prompt: { text: string }; delivery: string; promotedSeq?: number }
        const firstBody = yield* json<{ data: PromptBody }>(first)
        const retriedBody = yield* json<{ data: PromptBody }>(retried)
        expect(first.status).toBe(200)
        expect(retried.status).toBe(200)
        expect(retriedBody).toEqual(firstBody)
        expect(firstBody).toMatchObject({
          data: { id: "msg_http_prompt", prompt: { text: "hello" }, delivery: "steer" },
        })

        const messages = yield* requestJson<{ data: PromptBody[] }>(`/api/session/${session.id}/message`, {
          headers,
        })
        expect(messages.data).toHaveLength(0)
        const admitted = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_http_prompt")))
            .get()
            .pipe(Effect.orDie),
        )
        expect(admitted).toMatchObject({
          id: "msg_http_prompt",
          session_id: session.id,
          delivery: "steer",
          promoted_seq: null,
        })
        const conflict = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "goodbye" } }),
        })
        expect(conflict.status).toBe(409)
        expect(yield* responseJson(conflict)).toEqual({
          _tag: "ConflictError",
          message: "Prompt message ID conflicts with an existing durable record: msg_http_prompt",
          resource: "msg_http_prompt",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    10_000,
  )

  it.live(
    "compacts idle v2 sessions through the provider and serializes summary failure as 503",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST", headers,
          body: JSON.stringify({ agent: "build", model: { providerID: "test", id: "test-model" }, location: { directory } }),
        })
        const session = created.data
        yield* llm.text("## Goal\n- remember this before compact\n## Next Steps\n- Keep the original history")

        const synthetic = yield* request(`/api/session/${session.id}/synthetic`, {
          method: "POST",
          headers,
          body: JSON.stringify({ text: "remember this before compact" }),
        })
        expect(synthetic.status).toBe(204)

        const compact = yield* request(`/api/session/${session.id}/compact`, { method: "POST", headers })
        expect(compact.status).toBe(204)

        const messages = yield* requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${session.id}/message`, {
          headers,
        })
        const compaction = messages.data.find(
          (message): message is SessionMessage.Compaction => message.type === "compaction",
        )
        expect(compaction?.reason).toBe("manual")
        expect(compaction?.summary).toContain("remember this before compact")

        // A raw authentication failure must override synthetic stream-cleanup retries.
        yield* llm.pushMatch(
          (hit) => JSON.stringify(hit.body).includes("Update the anchored summary"),
          {
            type: "http-error" as const, status: 401,
            body: { error: { message: "summarizer access denied", type: "authentication_error" } },
          },
        )
        const failed = yield* request(`/api/session/${session.id}/compact`, { method: "POST", headers })
        expect(failed.status).toBe(503)
        expect(yield* llm.pending).toBe(0)
        expect(yield* llm.calls).toBe(2)
        expect(yield* responseJson(failed)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "the provider returned no usable summary",
          service: "session-compaction",
        })

        const wait = yield* request(`/api/session/${session.id}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(204)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    40_000,
  )

  it.live(
    "settles real local activity after required compaction cannot fit a finite model",
    () => Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const config = testProviderConfig(llm.url)
      config.provider.test.models["test-model"].limit = { context: 1000, output: 100 }
      const directory = yield* tmpdirScoped({ git: true, config })
      const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
      const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
        method: "POST", headers,
        body: JSON.stringify({ agent: "build", model: { providerID: "test", id: "test-model" }, location: { directory } }),
      })
      const sessionID = SessionID.make(created.data.id)
      const prompted = yield* request(`/api/session/${sessionID}/prompt`, {
        method: "POST", headers,
        body: JSON.stringify({ prompt: { text: "Preserve original oversized history ".repeat(2000) } }),
      })
      expect(prompted.status).toBe(200)
      const settled = yield* pollWithTimeout(
        Database.Service.use(({ db }) => db.select().from(SessionActivityTable)
          .where(eq(SessionActivityTable.session_id, sessionID)).all().pipe(
            Effect.orDie,
            Effect.map((rows) => rows.length === 1 && rows.every((row) => row.status !== "running" && row.status !== "recovering") ? rows : undefined),
          )),
        "finite compaction failure did not settle local activity", "5 seconds",
      )
      expect(settled).toHaveLength(1)
      const wait = yield* request(`/api/session/${sessionID}/wait`, { method: "POST", headers })
      expect(wait.status).toBe(204)
      const messages = yield* requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${sessionID}/message`, { headers })
      expect(messages.data.some((message) => message.type === "user" && message.text.includes("Preserve original oversized history"))).toBeTrue()
      expect(messages.data.find((message) => message.type === "assistant"), JSON.stringify(settled)).toMatchObject({
        finish: "error", failure: { code: "provider.context-overflow" },
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    15_000,
  )

  it.instance(
    "returns safe v2 unknown errors for corrupt projected messages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 corrupt message" })
        yield* insertCorruptV2Message(session.id)

        const messages = yield* request(`/api/session/${session.id}/message`, {
          headers: { "x-opencode-directory": test.directory },
        })
        const messagesBody = yield* responseJson(messages)
        expect(messages.status).toBe(500)
        expect(messagesBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((messagesBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(messagesBody)).not.toContain("assistant")

        const context = yield* request(`/api/session/${session.id}/context`, {
          headers: { "x-opencode-directory": test.directory },
        })
        const contextBody = yield* responseJson(context)
        expect(context.status).toBe(500)
        expect(contextBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((contextBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(contextBody)).not.toContain("assistant")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves sessions with migrated summary diffs missing file details",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "legacy diff" })
        yield* setLegacySummaryDiff(session.id)

        const response = yield* request(pathFor(SessionPaths.get, { sessionID: session.id }), {
          headers: { "x-opencode-directory": test.directory },
        })

        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).summary?.diffs).toEqual([{ additions: 1, deletions: 0 }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves lifecycle mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }

        const createdEmpty = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
        })
        expect(createdEmpty.id).toBeTruthy()

        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created" }),
        })
        expect(created.title).toBe("created")

        const updated = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: created.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "updated", time: { archived: 1 } }),
        })
        expect(updated).toMatchObject({ id: created.id, title: "updated", time: { archived: 1 } })

        const forked = yield* requestJson<Session.Info>(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
        })
        expect(forked.id).not.toBe(created.id)

        const forkedWithoutContentType = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers: { "x-opencode-directory": test.directory },
          },
        )
        expect(forkedWithoutContentType.id).not.toBe(created.id)

        const invalidFork = yield* request(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: "{",
        })
        expect(invalidFork.status).toBe(400)

        const forkedWhitespace = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers,
            body: "  \n",
          },
        )
        expect(forkedWhitespace.id).not.toBe(created.id)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.remove, { sessionID: created.id }), {
            method: "DELETE",
            headers,
          }),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "persists selected workspace id when creating a session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        const project = yield* Project.use.fromDirectory(test.directory)
        const workspace = yield* createLocalWorkspace({
          projectID: project.project.id,
          type: "session-create-workspace",
          directory: path.join(test.directory, ".workspace-local"),
        })

        const created = yield* requestJson<Session.Info>(`${SessionPaths.create}?workspace=${workspace.id}`, {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ title: "workspace session" }),
        })
        const messages = yield* request(
          `${pathFor(SessionPaths.messages, { sessionID: created.id })}?workspace=${workspace.id}`,
          {
            headers: { "x-opencode-directory": test.directory },
          },
        )

        expect(created).toMatchObject({ id: created.id, workspaceID: workspace.id })
        expect(messages.status).toBe(200)
        expect(yield* getWorkspaceID(created.id)).toEqual({ workspaceID: workspace.id })
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "validates archived timestamp values",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "archived" })
        const body = JSON.stringify({ time: { archived: -1 } })

        const response = yield* request(pathFor(SessionPaths.update, { sessionID: session.id }), {
          method: "PATCH",
          headers,
          body,
        })
        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).time.archived).toBe(-1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "uses project-scoped path and directory precedence",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const currentDir = path.join(test.directory, "packages", "opencode", "src")
        yield* Effect.promise(() => mkdir(currentDir, { recursive: true }))

        const store = yield* InstanceStore.Service
        const { pathSession, pathlessSession } = yield* store.provide(
          { directory: currentDir },
          Effect.gen(function* () {
            return {
              pathSession: yield* createSession(),
              pathlessSession: yield* createSession(),
            }
          }).pipe(Effect.provideService(TestInstance, { directory: currentDir }), Effect.provide(Session.defaultLayer)),
        )
        yield* clearSessionPath(pathlessSession.id)

        const query = new URLSearchParams({
          scope: "project",
          path: "packages/opencode/src",
          directory: currentDir,
        })
        const headers = { "x-opencode-directory": test.directory }
        const sessions = (yield* json<Session.Info[]>(
          yield* request(`${SessionPaths.list}?${query}`, { headers }),
        )).map((item) => item.id)

        expect(sessions).toContain(pathSession.id)
        expect(sessions).not.toContain(pathlessSession.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves paginated message link headers",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "messages" })
        yield* createTextMessage(session.id, "first")
        yield* createTextMessage(session.id, "second")
        const route = `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=1`

        const response = yield* request(route, { headers })

        expect(response.headers["x-next-cursor"]).toBeTruthy()
        expect(response.headers["link"]).toContain("limit=1")
        expect(response.headers["access-control-expose-headers"]?.toLowerCase()).toContain("x-next-cursor")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves message mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "messages" })
        const first = yield* createTextMessage(session.id, "first")
        const second = yield* createTextMessage(session.id, "second")

        const updated = yield* requestJson<SessionV1.Part>(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: first.info.id,
            partID: first.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...first.part, text: "updated" }),
          },
        )
        expect(updated).toMatchObject({ id: first.part.id, type: "text", text: "updated" })

        const file = yield* requestJson<SessionV1.FilePart>(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: first.info.id,
            partID: first.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              id: first.part.id,
              sessionID: session.id,
              messageID: first.info.id,
              type: "file",
              mime: "image/png",
              filename: "tiny.png",
              url: "data:image/png;base64,aGVsbG8=",
            }),
          },
        )
        expect(file.url).toStartWith("attachment://")
        const database = yield* Database.Service
        const durable = JSON.stringify({
          part: yield* database.db
            .select({ data: PartTable.data })
            .from(PartTable)
            .where(eq(PartTable.id, first.part.id))
            .get(),
          events: yield* database.db
            .select({ data: EventTable.data })
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, session.id))
            .all(),
        })
        expect(durable).toContain("attachment://")
        expect(durable).not.toContain("data:image")

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deletePart, {
              sessionID: session.id,
              messageID: first.info.id,
              partID: first.part.id,
            }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deleteMessage, { sessionID: session.id, messageID: second.info.id }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects part updates whose path and body ids disagree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "part mismatch" })
        const message = yield* createTextMessage(session.id, "first")
        const response = yield* request(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: message.info.id,
            partID: message.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...message.part, id: PartID.ascending() }),
          },
        )

        expect(response.status).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves remaining non-LLM session mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "remaining" })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.revert, { sessionID: session.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ messageID: MessageID.ascending() }),
          }),
        ).toMatchObject({ id: session.id })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.unrevert, { sessionID: session.id }), {
            method: "POST",
            headers,
          }),
        ).toMatchObject({ id: session.id })

        const permissionID = String(PermissionV1.ID.ascending())
        const permission = yield* request(
          pathFor(SessionPaths.permissions, {
            sessionID: session.id,
            permissionID,
          }),
          {
            method: "POST",
            headers,
            body: JSON.stringify({ response: "once" }),
          },
        )
        expect(permission.status).toBe(404)
        expect(yield* responseJson(permission)).toEqual({
          _tag: "PermissionNotFoundError",
          requestID: permissionID,
          message: `Permission request not found: ${permissionID}`,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
