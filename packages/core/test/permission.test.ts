import { describe, expect, test } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ConfigAccessControl } from "@opencode-ai/core/config/access-control"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionSafetyReview } from "@opencode-ai/core/permission/safety-review"
import { PermissionTable } from "@opencode-ai/core/permission/sql"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ContentStore } from "@opencode-ai/core/content-store"
import { SessionActivityTable, SessionInputTable, SessionMessageTable, SessionTable, SessionDispatchTable, SessionLinkTable } from "@opencode-ai/core/session/sql"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { PermissionSafetyReviewIntent } from "@opencode-ai/core/permission/safety-review-intent"
import { eq } from "drizzle-orm"
import * as TestConsole from "effect/testing/TestConsole"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

test("voice permission inputs cannot persist an always approval", () => {
  expect(
    PermissionV2.singleUse({
      sessionID: SessionV2.ID.make("ses_voice"),
      action: "edit",
      resources: ["notes.md"],
      save: ["notes.md"],
      metadata: { source: "tool" },
    }),
  ).toEqual({
    sessionID: SessionV2.ID.make("ses_voice"),
    action: "edit",
    resources: ["notes.md"],
    save: undefined,
    metadata: { source: "tool", [PermissionV2.SINGLE_USE_METADATA_KEY]: true },
  })
})

test("a narrower edit to the same resource gets a fresh safety decision", () => {
  const broad = PermissionV2.reviewCacheKey("ses_test", "edit", ["localization.json"], { path: "localization.json", oldString: "entire file", newString: "replacement file" })
  const narrow = PermissionV2.reviewCacheKey("ses_test", "edit", ["localization.json"], { path: "localization.json", oldString: "one key", newString: "one value" })
  expect(narrow).not.toBe(broad)
  expect(PermissionV2.reviewCacheKey("ses_test", "edit", ["localization.json"], { path: "localization.json", oldString: "entire file", newString: "replacement file" })).toBe(broad)
})

const database = Database.layerFromPath(":memory:")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const events = EventV2.layer.pipe(Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = SessionV2.layer.pipe(
  Layer.provide(ContentStore.defaultLayer),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(Project.defaultLayer),
  Layer.provide(SessionExecution.noopLayer),
)
const saved = PermissionSaved.layer.pipe(Layer.provide(database))
const created = DateTime.makeUnsafe(0)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const layer = PermissionV2.locationLayer.pipe(
  Layer.provideMerge(database),
  Layer.provideMerge(store),
  Layer.provideMerge(events),
  Layer.provideMerge(current),
  Layer.provideMerge(sessions),
  Layer.provideMerge(SessionExecution.noopLayer),
  Layer.provideMerge(saved),
)
const it = testEffect(layer)

const safetyReviews: PermissionSafetyReview.ReviewInput[] = []
const safetyDecision = { value: false }
const safetyReviewGate: { value?: Deferred.Deferred<void> } = {}
const itWithSafety = testEffect(
  layer.pipe(
    Layer.provideMerge(
      Layer.succeed(
        PermissionSafetyReview.Service,
        PermissionSafetyReview.Service.of({
          review: (input) =>
            Effect.gen(function* () {
              safetyReviews.push(input)
              if (safetyReviewGate.value) yield* Deferred.await(safetyReviewGate.value)
              return safetyDecision.value
                ? { approved: true, cause: "primary_safe", risk: "low", attempts: [] }
                : { approved: false, cause: "unsafe_consensus", risk: "high", attempts: [] }
            }),
        }),
      ),
    ),
  ),
)
const approvingSafety = Layer.succeed(
  PermissionSafetyReview.Service,
  PermissionSafetyReview.Service.of({
    review: (input) =>
      Effect.gen(function* () {
        safetyReviews.push(input)
        return { approved: true, cause: "primary_safe", risk: "low", attempts: [] }
      }),
  }),
)
const redirectingSafety = Layer.succeed(
  PermissionSafetyReview.Service,
  PermissionSafetyReview.Service.of({
    review: () => Effect.succeed({
      approved: false,
      cause: "unsafe_consensus",
      risk: "high",
      attempts: [{ role: "primary", model: "test/reviewer", status: "unsafe", reason: "Edit only the requested localization entry" }],
    }),
  }),
)
const itWithRedirect = testEffect(layer.pipe(Layer.provideMerge(redirectingSafety)))
const failingSafety = Layer.succeed(
  PermissionSafetyReview.Service,
  PermissionSafetyReview.Service.of({
    review: (input) =>
      Effect.sync(() => {
        safetyReviews.push(input)
        throw new Error("safety review unavailable")
      }),
  }),
)

function globalSafetyLayer(safety_review: ConfigAccessControl.SafetyReview) {
  return Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            path: "/config/opencode.json",
            info: new Config.Info({ access_control: { safety_review } }),
          }),
          new Config.Directory({ type: "directory", path: AbsolutePath.make("/config") }),
          new Config.Document({
            type: "document",
            path: "/project/opencode.json",
            info: new Config.Info({
              access_control: { mode: "ask", safety_review: { model: "test/project" } },
            }),
          }),
        ]),
    }),
  )
}

const itWithGlobalSafety = testEffect(
  layer.pipe(
    Layer.provideMerge(approvingSafety),
    Layer.provideMerge(globalSafetyLayer({ model: "test/global", fallback: { model: "test/global-fallback" } })),
  ),
)
const itWithGlobalSafetyNoSave = testEffect(
  layer.pipe(
    Layer.provideMerge(approvingSafety),
    Layer.provideMerge(globalSafetyLayer({ model: "test/global", auto_save: false })),
  ),
)
const itWithFailingSafety = testEffect(layer.pipe(Layer.provideMerge(failingSafety)))

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const message = new SessionMessage.User({
      id: SessionMessage.ID.make("msg_permission_intent"),
      type: "user",
      text: "Update the requested project safely",
      files: [],
      agents: [],
      time: { created },
    })
    const { id, type, ...data } = encodeMessage(message)
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: SessionMessage.ID.make(id),
        session_id: SessionV2.ID.make("ses_test"),
        type,
        seq: 1,
        time_created: DateTime.toEpochMillis(created),
        data,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const update = yield* agents.transform()
    yield* update((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function setInheritedPermissions(permissionLayers: PermissionV2.Ruleset[]) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({
        agent_policy: {
          tools: { mode: "explicit", entries: { read: { visible: true, permission: "allow" } } },
          permissionLayers,
          source: { type: "task", sessionID: "ses_parent", agent: AgentV2.ID.make("parent") },
        },
      })
      .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
      .run()
      .pipe(Effect.orDie)
  })
}

function setAccessControl(access_control: Record<string, unknown>) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ metadata: { access_control } })
      .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
      .run()
      .pipe(Effect.orDie)
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

function waitForRequest(input: Partial<PermissionV2.AssertInput> = {}) {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(assertion(input)).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("PermissionV2", () => {
  it.effect("snapshots configured, inherited, access-mode and remembered permission inputs without asking", () =>
    Effect.gen(function* () {
      const rules: PermissionV2.Ruleset = [{ action: "read", resource: "*", effect: "ask" }]
      yield* setup(rules)
      yield* setAccessControl({ mode: "ask" })
      const service = yield* PermissionV2.Service
      const saved = yield* PermissionSaved.Service
      const snapshot = service.policySnapshot
      if (!snapshot) return yield* Effect.die("Production permission policy snapshot is missing")
      const input = { sessionID: SessionV2.ID.make("ses_test") }
      const initial = yield* snapshot(input)
      expect(initial).toMatchObject({ configured: rules, inherited: [], accessControl: { mode: "ask" }, remembered: [], reviewed: [], rejected: [] })
      yield* setAccessControl({ mode: "full_access" })
      expect((yield* snapshot(input)).accessControl.mode).toBe("full_access")
      const inherited: PermissionV2.Ruleset = [{ action: "write", resource: "*", effect: "deny" }]
      yield* setInheritedPermissions([inherited])
      expect((yield* snapshot(input)).inherited).toEqual([inherited])
      yield* saved.add({ projectID: Project.ID.global, action: "read", resources: ["z.txt", "a.txt"] })
      expect((yield* snapshot(input)).remembered).toEqual([
        { action: "read", resource: "a.txt", effect: "allow" },
        { action: "read", resource: "z.txt", effect: "allow" },
      ])
      for (const grant of yield* saved.list({ projectID: Project.ID.global })) yield* saved.remove(grant.id)
      expect((yield* snapshot(input)).remembered).toEqual([])
      expect(yield* service.list()).toEqual([])
    }),
  )
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("forces descendant voice-conversation approvals to remain single-use", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      const rootID = SessionV2.ID.make("ses_voice_root")
      yield* db
        .insert(SessionTable)
        .values({
          id: rootID,
          project_id: Project.ID.global,
          slug: "voice",
          directory: "/project",
          title: "Voice conversation",
          version: "test",
          agent: "ordinary-plugin-source",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({ parent_id: rootID })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)

      yield* db.insert(SessionLinkTable).values({ plugin_id: "second-test-plugin", permission_policy: "single-use",
        source_session_id: rootID, target_session_id: SessionV2.ID.make("ses_test") }).run().pipe(Effect.orDie)
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "edit", save: ["src/*"] }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toMatchObject({
        save: undefined,
        metadata: { [PermissionV2.SINGLE_USE_METADATA_KEY]: true },
      })
    }),
  )

  it.effect("requires single-use clicks only for the linked worker activity, even after the voice link ends", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "edit", resource: "*", effect: "allow" }])
      yield* setAccessControl({ mode: "full_access" })
      const { db } = yield* Database.Service
      const workerID = SessionV2.ID.make("ses_test")
      const voiceID = SessionV2.ID.make("ses_bound_voice")
      const inputID = SessionMessage.ID.make("msg_voice_instruction")
      const messageID = SessionMessage.ID.make("msg_voice_tool")
      yield* db.insert(SessionTable).values({ id: voiceID, project_id: Project.ID.global,
        slug: "voice", directory: "/project", title: "Voice", version: "test", agent: "voice-moderator" }).run().pipe(Effect.orDie)
      yield* db.insert(SessionLinkTable).values({ plugin_id: "test-links", permission_policy: "single-use", source_session_id: voiceID, target_session_id: workerID }).run().pipe(Effect.orDie)
      yield* db.insert(SessionDispatchTable).values({ plugin_id: "test-links", source_session_id: voiceID, target_session_id: workerID, target_input_id: inputID,
        source_message_id: SessionMessage.ID.make("msg_origin"), source_call_id: "call_origin", text: "Fix it",
        delivery: "queue", result_input_id: SessionMessage.ID.create() }).run().pipe(Effect.orDie)
      yield* db.insert(SessionInputTable).values({ id: inputID, session_id: workerID,
        prompt: { text: "Fix it", files: [], agents: [] }, delivery: "queue", admitted_seq: 2 }).run().pipe(Effect.orDie)
      yield* db.insert(SessionMessageTable).values({ id: messageID, session_id: workerID, type: "assistant", seq: 5,
        data: encodeMessage(new SessionMessage.Assistant({ id: messageID, type: "assistant", agent: "test",
          model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test", providerID: "test" }), content: [], time: { created } })),
      }).run().pipe(Effect.orDie)
      yield* db.insert(SessionActivityTable).values({ id: "voice_activity", session_id: workerID,
        kind: "prompt", status: "running", opened_seq: 2 }).run().pipe(Effect.orDie)
      const service = yield* PermissionV2.Service
      const input = assertion({ action: "edit", save: ["src/*"], source: { type: "tool", messageID, callID: "call_edit" } })
      expect(yield* service.ask(input)).toMatchObject({ effect: "allow" })
      yield* db.update(SessionInputTable).set({ promoted_seq: 3 }).where(eq(SessionInputTable.id, inputID)).run().pipe(Effect.orDie)
      expect(yield* service.ask(input)).toMatchObject({ effect: "ask" })
      expect(yield* service.get(input.id)).toMatchObject({ save: undefined,
        metadata: { [PermissionV2.SINGLE_USE_METADATA_KEY]: true } })
      expect(yield* service.reply({ requestID: input.id, reply: "always" }).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.RejectedError)
      yield* service.reply({ requestID: input.id, reply: "once" })
      yield* db.update(SessionLinkTable).set({ time_ended: 100 }).run().pipe(Effect.orDie)
      expect(yield* service.ask({ ...input, id: PermissionV2.ID.create() })).toMatchObject({ effect: "ask" })
      yield* setRules([{ action: "edit", resource: "*", effect: "deny" }])
      expect(yield* service.ask({ ...input, id: PermissionV2.ID.create() })).toMatchObject({ effect: "deny" })
      yield* setRules([{ action: "edit", resource: "*", effect: "allow" }])
      yield* db.update(SessionActivityTable).set({ status: "completed", closed_seq: 6 }).run().pipe(Effect.orDie)
      yield* db.update(SessionMessageTable).set({ seq: 8 }).where(eq(SessionMessageTable.id, messageID)).run().pipe(Effect.orDie)
      expect(yield* service.ask({ ...input, id: PermissionV2.ID.create() })).toMatchObject({ effect: "allow" })
      expect(yield* service.ask({ ...input, id: PermissionV2.ID.create(), source: { type: "tool", callID: "call_edit", messageID: "msg_foreign" } })).toMatchObject({ effect: "allow" })
      expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, workerID)).get().pipe(Effect.orDie))?.parent_id).toBeNull()
    }),
  )

  for (const mode of ["ask", "full_access", "approve_for_me"] as const) {
    itWithSafety.effect(`voice approvals require a visible click even under ${mode}`, () =>
      Effect.gen(function* () {
        yield* setup([{ action: "*", resource: "*", effect: "allow" }])
        yield* setAccessControl({ mode })
        const saved = yield* PermissionSaved.Service
        yield* saved.add({ projectID: Project.ID.global, action: "edit", resources: ["*"] })
        const service = yield* PermissionV2.Service
        const input = { ...PermissionV2.singleUse(assertion({ action: "edit", save: ["*"] })), id: PermissionV2.ID.create() }
        expect(yield* service.ask(input)).toMatchObject({ effect: "ask" })
        expect(yield* service.reply({ requestID: input.id, reply: "always" }).pipe(Effect.flip)).toBeInstanceOf(
          PermissionV2.RejectedError,
        )
        expect(yield* service.get(input.id)).toBeDefined()
        yield* service.reply({ requestID: input.id, reply: "once" })
        expect(yield* service.get(input.id)).toBeUndefined()
        expect(yield* service.ask({ ...input, id: PermissionV2.ID.create() })).toMatchObject({ effect: "ask" })
        yield* setRules([{ action: "edit", resource: "*", effect: "deny" }])
        expect(yield* service.ask({ ...input, id: PermissionV2.ID.create() })).toMatchObject({ effect: "deny" })
      }),
    )
  }

  for (const mode of ["ask", "full_access", "approve_for_me"] as const) {
    itWithSafety.effect(`Main task consent returns an actual host receipt under ${mode}`, () => Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      yield* setAccessControl({ mode })
      yield* (yield* PermissionSaved.Service).add({ projectID: Project.ID.global, action: "task_main_write", resources: ["*"] })
      const service = yield* PermissionV2.Service
      const authorize = service.assertSingleUse
      if (!authorize) return yield* Effect.die("Native receipt support missing")
      const events = yield* EventV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const unsubscribe = yield* events.listen((event) => event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, Schema.decodeUnknownSync(PermissionV2.Request)(event.data)).pipe(Effect.asVoid) : Effect.void)
      yield* Effect.addFinalizer(() => unsubscribe)
      const input = assertion({ action: "task_main_write", resources: ["task:fixture:exact-digest"], save: ["*"] })
      const fiber = yield* authorize(input).pipe(Effect.forkChild)
      const request = yield* Deferred.await(asked)
      expect(request.metadata?.[PermissionV2.SINGLE_USE_METADATA_KEY]).toBe(true)
      expect(request.save).toBeUndefined()
      expect(yield* service.reply({ requestID: request.id, reply: "always" }).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.RejectedError)
      yield* service.reply({ requestID: request.id, reply: "once" })
      expect(yield* Fiber.join(fiber)).toBe(request.id)
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "task_main_write", resource: "*", effect: "deny" }])
      expect(yield* authorize(input).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.DeniedError)
    }))
  }

  for (const mode of ["ask", "full_access", "approve_for_me"] as const) {
    itWithSafety.effect(`spawn requires a fresh host click under ${mode}, preserving Deny`, () =>
      Effect.gen(function* () {
        yield* setup([{ action: "spawn_agent", resource: "*", effect: "ask" }])
        yield* setAccessControl({ mode })
        yield* (yield* PermissionSaved.Service).add({ projectID: Project.ID.global, action: "spawn_agent", resources: ["*"] })
        const input = PermissionV2.singleUse(assertion({ action: "spawn_agent", resources: ["*"], save: ["*"] }))
        const first = yield* waitForRequest(input)
        expect(first.request.action).toBe("spawn_agent")
        expect(first.request.save).toBeUndefined()
        expect(yield* first.service.reply({ requestID: first.request.id, reply: "always" }).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.RejectedError)
        yield* first.service.reply({ requestID: first.request.id, reply: "once" })
        yield* Fiber.join(first.fiber)

        const second = yield* waitForRequest({ ...input, id: PermissionV2.ID.create() })
        expect(second.request.id).not.toBe(first.request.id)
        yield* second.service.reply({ requestID: second.request.id, reply: "reject" })
        const rejected = yield* Fiber.await(second.fiber)
        expect(rejected._tag).toBe("Failure")
        expect(JSON.stringify(rejected)).toContain("PermissionV2.DeclinedError")
        expect(yield* second.service.list()).toEqual([])
        yield* setRules([{ action: "spawn_agent", resource: "*", effect: "deny" }])
        expect(yield* second.service.assert(input).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.DeniedError)
        expect(yield* second.service.list()).toEqual([])
      }),
    )
  }

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.update((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const denied = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(denied).toBeInstanceOf(PermissionV2.DeniedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("never widens an inherited parent permission layer", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      yield* setInheritedPermissions([[{ action: "read", resource: "*", effect: "ask" }]])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "ask" })

      yield* setInheritedPermissions([[{ action: "read", resource: "*", effect: "deny" }]])
      yield* setAccessControl({ mode: "full_access" })
      expect(yield* service.ask(assertion())).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("full_access skips prompts but preserves agent denies and materialization boundaries", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "deny" }])
      yield* setAccessControl({ mode: "full_access" })
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ action: "bash", resources: ["rm -rf build"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
      const denied = yield* service.assert(assertion({ action: "read", resources: ["src/index.ts"] })).pipe(Effect.flip)
      expect(denied).toBeInstanceOf(PermissionV2.DeniedError)
      expect(yield* service.materializationRules({ sessionID: SessionV2.ID.make("ses_test") })).toEqual([
        { action: "*", resource: "*", effect: "deny" },
      ])
      expect(yield* service.list()).toEqual([])
    }),
  )

  for (const mode of ["full_access", "ask", "approve_for_me"] as const) {
    itWithSafety.effect(`routes external directory approval through ${mode}`, () =>
      Effect.gen(function* () {
        safetyReviews.length = 0
        safetyDecision.value = true
        yield* setup([{ action: "external_directory", resource: "*", effect: "ask" }])
        yield* setAccessControl({ mode, safety_review: { model: "test/model" } })
        const service = yield* PermissionV2.Service
        const resources = ["/external/dir/*"]
        const result = yield* service.ask(assertion({ action: "external_directory", resources }))
        expect(result.effect).toBe(mode === "ask" ? "ask" : "allow")
        expect(yield* service.list()).toHaveLength(mode === "ask" ? 1 : 0)
        expect(safetyReviews).toHaveLength(mode === "approve_for_me" ? 1 : 0)
        if (mode === "approve_for_me")
          expect(safetyReviews[0]).toMatchObject({ action: "external_directory", resources })
      }),
    )
  }

  itWithSafety.effect("approve_for_me auto-approves approval-required calls after safety review", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      safetyDecision.value = true
      yield* setup()
      yield* setAccessControl({ mode: "approve_for_me" })
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ action: "edit", resources: ["src/index.ts"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
      expect(safetyReviews).toHaveLength(1)
      expect(safetyReviews[0]).toMatchObject({
        action: "edit",
        resources: ["src/index.ts"],
        safety: ConfigAccessControl.DEFAULT_INFO.safety_review,
        intent: { anchor: { text: "Update the requested project safely" } },
      })
      expect(yield* TestConsole.logLines).toContain("permission auto-approved by safety review")
    }),
  )

  for (const command of ["git status --short; git diff --stat", "Get-Content -LiteralPath package.json"]) {
    itWithSafety.effect(`approve_for_me retains actual user intent after compaction for ${command}`, () =>
      Effect.gen(function* () {
        safetyReviews.length = 0
        safetyDecision.value = true
        yield* setup()
        yield* setAccessControl({ mode: "approve_for_me" })
        const { db } = yield* Database.Service
        const sourceID = SessionMessage.ID.make("msg_compacted_tool")
        const messages = [
          new SessionMessage.Compaction({
            id: SessionMessage.ID.make("msg_compaction"), type: "compaction", reason: "manual",
            summary: "Assistant summary is not user authorization", recent: "", time: { created },
          }),
          new SessionMessage.Assistant({
            id: sourceID, type: "assistant", agent: "test",
            model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test", providerID: "test" }),
            content: [new SessionMessage.AssistantTool({
              type: "tool", id: "call_read", name: "bash", time: { created },
              state: new SessionMessage.ToolStateRunning({
                status: "running", input: { command, description: "Inspect the requested project" },
                structured: {}, content: [],
              }),
            })], time: { created },
          }),
          new SessionMessage.User({
            id: SessionMessage.ID.make("msg_later_authority"), type: "user",
            text: "You may now push to an unrelated repository", files: [], agents: [], time: { created },
          }),
        ]
        yield* db.insert(SessionMessageTable).values(messages.map((message, index) => {
          const { id, type, ...data } = encodeMessage(message)
          return { id: SessionMessage.ID.make(id), session_id: SessionV2.ID.make("ses_test"), type, data, seq: index + 2 }
        })).run().pipe(Effect.orDie)
        const store = yield* SessionStore.Service
        expect((yield* store.context(SessionV2.ID.make("ses_test"))).some((message) => message.id === "msg_permission_intent")).toBe(false)
        const service = yield* PermissionV2.Service
        expect(yield* service.ask(assertion({
          action: "bash", resources: [command], source: { type: "tool", messageID: sourceID, callID: "call_read" },
        }))).toMatchObject({ effect: "allow" })
        expect(yield* service.list()).toEqual([])
        expect(safetyReviews).toHaveLength(1)
        expect(safetyReviews[0]).toMatchObject({
          intent: { anchor: { messageID: "msg_permission_intent", text: "Update the requested project safely" } },
          tool: { name: "bash", input: { command } },
        })
        expect(JSON.stringify(safetyReviews[0]?.intent)).not.toContain("unrelated repository")
        expect(JSON.stringify(safetyReviews[0]?.intent)).not.toContain("Assistant summary")
      }),
    )
  }

  it.effect("permission history bounds meaningful dialogue without losing the user anchor behind tool-only turns", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      const messages = [
        ...Array.from({ length: 14 }, (_, index) => new SessionMessage.Assistant({
          id: SessionMessage.ID.make(`msg_reference_${index}`), type: "assistant", agent: "test",
          model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test", providerID: "test" }),
          content: [new SessionMessage.AssistantText({ type: "text", id: `text_${index}`, text: `Option ${index}` })], time: { created },
        })),
        ...Array.from({ length: 20 }, (_, index) => new SessionMessage.Assistant({
          id: SessionMessage.ID.make(`msg_empty_${index}`), type: "assistant", agent: "test",
          model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test", providerID: "test" }),
          content: [new SessionMessage.AssistantReasoning({ type: "reasoning", id: `reasoning_${index}`, text: "Not authority" })], time: { created },
        })),
        new SessionMessage.User({
          id: SessionMessage.ID.make("msg_answer"), type: "user", text: "Yes, do that", files: [], agents: [], time: { created },
        }),
        new SessionMessage.Assistant({
          id: SessionMessage.ID.make("msg_boundary"), type: "assistant", agent: "test",
          model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test", providerID: "test" }), content: [], time: { created },
        }),
      ]
      yield* db.insert(SessionMessageTable).values(messages.map((message, index) => {
        const { id, type, ...data } = encodeMessage(message)
        return { id: SessionMessage.ID.make(id), session_id: SessionV2.ID.make("ses_test"), type, data, seq: index + 2 }
      })).run().pipe(Effect.orDie)
      const limit = PermissionSafetyReviewIntent.MAX_RECENT_MESSAGES
      const history = yield* SessionHistory.loadForPermission(db, SessionV2.ID.make("ses_test"), SessionMessage.ID.make("msg_boundary"), limit)
      // recentLimit meaningful messages plus one sentinel plus the anchor plus the source.
      expect(history?.map((message) => message.id.toString())).toEqual([
        ...Array.from({ length: limit + 1 }, (_, index) => `msg_reference_${index + 3}`), "msg_answer", "msg_boundary",
      ])
      // The sentinel keeps Intent.build's truncation signal honest.
      const intent = PermissionSafetyReviewIntent.build({
        messages: history!.flatMap(PermissionV2.intentMessage),
        anchorBeforeMessageID: "msg_boundary",
      })!
      expect(intent.recent).toHaveLength(limit)
      expect(intent.recent[0]?.messageID).toBe("msg_reference_4")
      expect(intent.truncated).toBe(true)
      expect(yield* SessionHistory.loadForPermission(db, SessionV2.ID.make("ses_test"), undefined, limit)).toHaveLength(limit + 2)
      expect(yield* SessionHistory.loadForPermission(db, SessionV2.ID.make("ses_other"), SessionMessage.ID.make("msg_boundary"), limit)).toBeUndefined()
      expect(yield* SessionHistory.loadForPermission(db, SessionV2.ID.make("ses_test"), SessionMessage.ID.make("msg_missing"), limit)).toBeUndefined()
      expect(yield* SessionHistory.loadForPermission(db, SessionV2.ID.make("ses_test"), SessionMessage.ID.make("msg_answer"), limit)).toBeUndefined()
    }),
  )

  it.effect("whitespace-only dialogue never consumes the meaningful-message budget or becomes the anchor", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      const whitespaceRows = [
        ...Array.from({ length: 6 }, (_, index) => new SessionMessage.User({
          id: SessionMessage.ID.make(`msg_ws_user_${index}`), type: "user", text: "\t\r\n ", files: [], agents: [], time: { created },
        })),
        ...Array.from({ length: 6 }, (_, index) => new SessionMessage.Assistant({
          id: SessionMessage.ID.make(`msg_ws_assistant_${index}`), type: "assistant", agent: "test",
          model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test", providerID: "test" }),
          content: [new SessionMessage.AssistantText({ type: "text", id: `ws_text_${index}`, text: "\u00A0\u2028 " })], time: { created },
        })),
        ...Array.from({ length: 3 }, (_, index) => new SessionMessage.User({
          id: SessionMessage.ID.make(`msg_space_${index}`), type: "user", text: " ".repeat(index + 1), files: [], agents: [], time: { created },
        })),
      ]
      const messages = [
        ...Array.from({ length: 12 }, (_, index) => new SessionMessage.Assistant({
          id: SessionMessage.ID.make(`msg_ref_${index}`), type: "assistant", agent: "test",
          model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test", providerID: "test" }),
          content: [new SessionMessage.AssistantText({ type: "text", id: `ref_text_${index}`, text: `Reference ${index}` })], time: { created },
        })),
        ...whitespaceRows,
        new SessionMessage.User({
          id: SessionMessage.ID.make("msg_real_answer"), type: "user", text: "Yes, do that", files: [], agents: [], time: { created },
        }),
        // The latest user row before the source is whitespace-only; it must not become the anchor.
        new SessionMessage.User({
          id: SessionMessage.ID.make("msg_ws_latest"), type: "user", text: "\t", files: [], agents: [], time: { created },
        }),
        new SessionMessage.Assistant({
          id: SessionMessage.ID.make("msg_ws_boundary"), type: "assistant", agent: "test",
          model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test", providerID: "test" }), content: [], time: { created },
        }),
      ]
      yield* db.insert(SessionMessageTable).values(messages.map((message, index) => {
        const { id, type, ...data } = encodeMessage(message)
        return { id: SessionMessage.ID.make(id), session_id: SessionV2.ID.make("ses_test"), type, data, seq: index + 2 }
      })).run().pipe(Effect.orDie)
      const limit = PermissionSafetyReviewIntent.MAX_RECENT_MESSAGES
      const history = yield* SessionHistory.loadForPermission(db, SessionV2.ID.make("ses_test"), SessionMessage.ID.make("msg_ws_boundary"), limit)
      expect(history?.map((message) => message.id.toString())).toEqual([
        ...Array.from({ length: limit + 1 }, (_, index) => `msg_ref_${index + 1}`), "msg_real_answer", "msg_ws_boundary",
      ])
      const intent = PermissionSafetyReviewIntent.build({
        messages: history!.flatMap(PermissionV2.intentMessage),
        anchorBeforeMessageID: "msg_ws_boundary",
      })!
      expect(intent.anchor).toMatchObject({ messageID: "msg_real_answer", text: "Yes, do that" })
      expect(intent.truncated).toBe(true)
      expect(intent.recent.map((message) => message.messageID)).toEqual([...Array.from({ length: 10 }, (_, index) => `msg_ref_${index + 2}`)])
      expect(JSON.stringify(intent)).not.toContain("\\t")
      expect(JSON.stringify(intent)).not.toContain("\u{00A0}\u{2028}")
    }),
  )

  it.effect("permission history bounds the examined candidate rows on long tool-only sessions", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      const messages = [
        new SessionMessage.Assistant({
          id: SessionMessage.ID.make("msg_beyond_window"), type: "assistant", agent: "test",
          model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test", providerID: "test" }),
          content: [new SessionMessage.AssistantText({ type: "text", id: "text_beyond", text: "Reference beyond the window" })], time: { created },
        }),
        // SQL trim only strips spaces, so these tab-only rows pass the cheap
        // prefilter and fill the candidate window without being meaningful.
        ...Array.from({ length: SessionHistory.CANDIDATE_ROW_LIMIT + 5 }, (_, index) => new SessionMessage.Assistant({
          id: SessionMessage.ID.make(`msg_filler_${index}`), type: "assistant", agent: "test",
          model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test", providerID: "test" }),
          content: [new SessionMessage.AssistantText({ type: "text", id: `filler_text_${index}`, text: "\t" })], time: { created },
        })),
        new SessionMessage.User({
          id: SessionMessage.ID.make("msg_window_answer"), type: "user", text: "Inspect the repository", files: [], agents: [], time: { created },
        }),
        new SessionMessage.Assistant({
          id: SessionMessage.ID.make("msg_window_boundary"), type: "assistant", agent: "test",
          model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test", providerID: "test" }), content: [], time: { created },
        }),
      ]
      yield* db.insert(SessionMessageTable).values(messages.map((message, index) => {
        const { id, type, ...data } = encodeMessage(message)
        return { id: SessionMessage.ID.make(id), session_id: SessionV2.ID.make("ses_test"), type, data, seq: index + 2 }
      })).run().pipe(Effect.orDie)
      const history = yield* SessionHistory.loadForPermission(
        db,
        SessionV2.ID.make("ses_test"),
        SessionMessage.ID.make("msg_window_boundary"),
        PermissionSafetyReviewIntent.MAX_RECENT_MESSAGES,
      )
      expect(history?.map((message) => message.id.toString())).toEqual(["msg_window_answer", "msg_window_boundary"])
    }),
  )

  itWithSafety.effect("missing and non-assistant permission sources never invoke a reviewer or borrow newer authority", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      safetyDecision.value = true
      yield* setup()
      yield* setAccessControl({ mode: "approve_for_me" })
      const service = yield* PermissionV2.Service
      for (const messageID of ["msg_missing", "msg_permission_intent"]) {
        expect(yield* service.ask(assertion({
          id: PermissionV2.ID.create(), action: "bash", resources: ["git status"],
          source: { type: "tool", messageID, callID: "call_read" },
        }))).toMatchObject({ effect: "ask" })
      }
      expect(safetyReviews).toHaveLength(0)
    }),
  )

  itWithGlobalSafety.effect("uses the global safety reviewer with a session-scoped approval mode", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      yield* setup()
      yield* setAccessControl({
        mode: "approve_for_me",
        safety_review: { model: "test/session", fallback: { model: "test/session-fallback" } },
      })
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ action: "edit", resources: ["src/index.ts"] }))).toMatchObject({
        effect: "allow",
      })
      expect(safetyReviews).toHaveLength(1)
      expect(safetyReviews[0]?.safety).toEqual({
        model: "test/global",
        fallback: { model: "test/global-fallback" },
      })
    }),
  )

  itWithSafety.effect("does not use a session-scoped safety reviewer when global config is unavailable", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      safetyDecision.value = true
      yield* setup()
      yield* setAccessControl({ mode: "approve_for_me", safety_review: { model: "test/session" } })
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ action: "edit", resources: ["src/index.ts"] }))).toMatchObject({
        effect: "allow",
      })
      expect(safetyReviews).toHaveLength(1)
      expect(safetyReviews[0]?.safety).toEqual(ConfigAccessControl.DEFAULT_INFO.safety_review)
    }),
  )

  itWithSafety.effect("fails closed when approve_for_me has no persisted safety-review snapshot", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      safetyDecision.value = true
      yield* setup()
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ action: "edit", resources: ["src/index.ts"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(safetyReviews).toHaveLength(1)
      expect(safetyReviews[0]?.safety).toBeUndefined()
    }),
  )

  itWithSafety.effect("approve_for_me falls back to a normal prompt when safety review rejects", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      safetyDecision.value = false
      yield* setup()
      yield* setAccessControl({ mode: "approve_for_me", safety_review: { model: "test/model" } })
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ action: "edit", resources: ["src/index.ts"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "ask",
      })
      expect(yield* service.list()).toHaveLength(1)
      expect((yield* service.list())[0]?.metadata?.["$opencode.permission.safety_review"]).toMatchObject({
        cause: "unsafe_consensus",
      })
      expect(safetyReviews).toHaveLength(1)
      expect(yield* TestConsole.logLines).not.toContain("permission auto-approved by safety review")
    }),
  )

  itWithSafety.effect("approve_for_me keeps configured deny rules direct", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      safetyDecision.value = true
      yield* setup([{ action: "read", resource: ".opencode/plugin-sources/*", effect: "deny" }])
      yield* setAccessControl({ mode: "approve_for_me", safety_review: { model: "test/model" } })
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ resources: [".opencode/plugin-sources/git-workbench-app"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
      expect(yield* service.list()).toEqual([])
      expect(safetyReviews).toHaveLength(0)
    }),
  )

  itWithSafety.effect("approve_for_me keeps configured allow rules direct", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      safetyDecision.value = false
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      yield* setAccessControl({ mode: "approve_for_me", safety_review: { model: "test/model" } })
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
      expect(safetyReviews).toHaveLength(0)
    }),
  )

  itWithSafety.effect("approve_for_me preserves materialization rules for direct denies", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      safetyDecision.value = true
      yield* setup([{ action: "bash", resource: "*", effect: "deny" }])
      yield* setAccessControl({ mode: "approve_for_me", safety_review: { model: "test/model" } })
      const service = yield* PermissionV2.Service

      expect(yield* service.materializationRules({ sessionID: SessionV2.ID.make("ses_test") })).toEqual([
        { action: "bash", resource: "*", effect: "deny" },
      ])
    }),
  )

  itWithSafety.effect("approve_for_me caches safety review decisions within a session", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      safetyDecision.value = true
      yield* setup()
      yield* setAccessControl({ mode: "approve_for_me", safety_review: { model: "test/model" } })
      const service = yield* PermissionV2.Service

      const first = yield* service.ask(assertion({ action: "edit", resources: ["src/index.ts"] }))
      const second = yield* service.ask(assertion({ action: "edit", resources: ["src/index.ts"] }))
      expect(first).toMatchObject({ effect: "allow" })
      expect(second).toMatchObject({ effect: "allow" })
      expect(safetyReviews).toHaveLength(1)
    }),
  )

  itWithSafety.effect("approve_for_me does not share positive safety cache entries across sessions", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      safetyDecision.value = true
      yield* setup()
      const { db } = yield* Database.Service
      const otherSessionID = SessionV2.ID.make("ses_other_cache")
      yield* db
        .insert(SessionTable)
        .values({
          id: otherSessionID,
          project_id: Project.ID.global,
          slug: "other-cache",
          directory: "/project",
          title: "other-cache",
          version: "test",
          agent: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const message = new SessionMessage.User({
        id: SessionMessage.ID.make("msg_other_cache_intent"),
        type: "user",
        text: "Update the requested project safely",
        files: [],
        agents: [],
        time: { created },
      })
      const { id, type, ...data } = encodeMessage(message)
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(id),
          session_id: otherSessionID,
          type,
          seq: 1,
          time_created: DateTime.toEpochMillis(created),
          data,
        })
        .run()
        .pipe(Effect.orDie)
      yield* setAccessControl({ mode: "approve_for_me" })
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ action: "edit" }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(
          assertion({ sessionID: otherSessionID, id: PermissionV2.ID.create("per_other_cache"), action: "edit" }),
        ),
      ).toMatchObject({ effect: "allow" })
      expect(safetyReviews).toHaveLength(2)
    }),
  )

  itWithSafety.effect("approve_for_me coalesces equivalent safety reviews while one is in flight", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      safetyDecision.value = true
      const gate = Deferred.makeUnsafe<void>()
      safetyReviewGate.value = gate
      yield* setup()
      yield* setAccessControl({ mode: "approve_for_me", safety_review: { model: "test/model" } })
      const service = yield* PermissionV2.Service

      const both = yield* Effect.all(
        [
          service.ask(assertion({ id: PermissionV2.ID.create("per_first"), action: "edit" })),
          service.ask(assertion({ id: PermissionV2.ID.create("per_second"), action: "edit" })),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkScoped)
      while (safetyReviews.length < 1) yield* Effect.yieldNow
      yield* Deferred.succeed(gate, undefined)
      const [first, second] = yield* Fiber.join(both)
      safetyReviewGate.value = undefined

      expect(first).toMatchObject({ effect: "allow" })
      expect(second).toMatchObject({ effect: "allow" })
      expect(safetyReviews).toHaveLength(1)
    }),
  )

  itWithSafety.effect("keeps a coalesced safety review alive when its first caller is interrupted", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      safetyDecision.value = true
      const gate = Deferred.makeUnsafe<void>()
      safetyReviewGate.value = gate
      yield* setup()
      yield* setAccessControl({ mode: "approve_for_me", safety_review: { model: "test/model" } })
      const service = yield* PermissionV2.Service

      const first = yield* service
        .ask(assertion({ id: PermissionV2.ID.create("per_interrupted"), action: "edit" }))
        .pipe(Effect.forkScoped)
      while (safetyReviews.length < 1) yield* Effect.yieldNow
      const second = yield* service
        .ask(assertion({ id: PermissionV2.ID.create("per_waiting"), action: "edit" }))
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(first)
      yield* Deferred.succeed(gate, undefined)

      expect(yield* Fiber.join(second)).toMatchObject({ effect: "allow" })
      safetyReviewGate.value = undefined
      expect(safetyReviews).toHaveLength(1)
    }),
  )

  itWithSafety.effect("approve_for_me does not cache unsafe review decisions and retries on the next call", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      safetyDecision.value = false
      yield* setup()
      yield* setAccessControl({ mode: "approve_for_me", safety_review: { model: "test/model" } })
      const service = yield* PermissionV2.Service

      const first = yield* service.ask(assertion({ action: "edit", resources: ["src/index.ts"] }))
      yield* service.reply({ requestID: first.id, reply: "once" })
      const second = yield* service.ask(assertion({ action: "edit", resources: ["src/index.ts"] }))
      expect(first).toMatchObject({ effect: "ask" })
      expect(second).toMatchObject({ effect: "ask" })
      // Unsafe is never cached ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the model is called again on the second request.
      expect(safetyReviews).toHaveLength(2)
    }),
  )

  itWithRedirect.effect("redirects an unsafe tool call to the agent without showing a prompt or retrying the same call", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* setAccessControl({ mode: "approve_for_me", safety_review: { model: "test/model" } })
      const service = yield* PermissionV2.Service
      const first = yield* Effect.exit(service.assert(assertion({ action: "edit", resources: ["localization.json"] })))
      expect(first._tag).toBe("Failure")
      expect(JSON.stringify(first)).toContain("Edit only the requested localization entry")
      expect(yield* service.list()).toEqual([])
      expect(yield* service.ask(assertion({ action: "edit", resources: ["localization.json"] }))).toMatchObject({ effect: "deny" })
    }),
  )

  itWithFailingSafety.effect("approve_for_me fails closed and retries after a failed safety review", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      yield* setup()
      yield* setAccessControl({ mode: "approve_for_me" })
      const service = yield* PermissionV2.Service

      const first = yield* service.ask(assertion({ action: "edit", resources: ["src/index.ts"] }))
      expect(first).toMatchObject({ effect: "ask" })
      expect(yield* service.list()).toHaveLength(1)
      yield* service.reply({ requestID: first.id, reply: "once" })

      const second = yield* service.ask(assertion({ action: "edit", resources: ["src/index.ts"] }))
      expect(second).toMatchObject({ effect: "ask" })
      expect(safetyReviews).toHaveLength(2)
    }),
  )

  itWithSafety.effect("approve_for_me coalesces equivalent pending prompts", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      safetyDecision.value = false
      yield* setup()
      yield* setAccessControl({ mode: "approve_for_me", safety_review: { model: "test/model" } })
      const service = yield* PermissionV2.Service

      const first = yield* service.ask(assertion({ action: "bash", resources: ["Get-Command ffprobe"] }))
      const second = yield* service.ask(assertion({ action: "bash", resources: ["Get-Command ffprobe"] }))
      expect(second).toEqual(first)
      expect(yield* service.list()).toHaveLength(1)
      expect(safetyReviews).toHaveLength(2)
    }),
  )

  itWithSafety.effect("approve_for_me persists safety-review approvals as saved rules", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      safetyDecision.value = true
      yield* setup()
      yield* setAccessControl({ mode: "approve_for_me", safety_review: { model: "test/model" } })
      const service = yield* PermissionV2.Service

      yield* service.ask(assertion({ action: "edit", resources: ["src/index.ts"], save: ["src/*"] }))
      const saved = yield* PermissionSaved.Service
      const rules = yield* saved.list({ projectID: Project.ID.global })
      expect(rules).toContainEqual(expect.objectContaining({ action: "edit", resource: "src/*" }))
    }),
  )

  itWithGlobalSafetyNoSave.effect("approve_for_me skips auto-persist when global auto_save is false", () =>
    Effect.gen(function* () {
      safetyReviews.length = 0
      yield* setup()
      yield* setAccessControl({ mode: "approve_for_me" })
      const service = yield* PermissionV2.Service

      yield* service.ask(assertion({ action: "edit", resources: ["src/index.ts"], save: ["src/*"] }))
      const saved = yield* PermissionSaved.Service
      const rules = yield* saved.list({ projectID: Project.ID.global })
      expect(rules.filter((rule) => rule.action === "edit")).toHaveLength(0)
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      const update = yield* agents.transform()
      yield* update((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) => {
        editor.remove(AgentV2.ID.make("test"))
        editor.remove(AgentV2.ID.make("build"))
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest({ save: ["src/*"] })
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  itWithSafety.effect("denying a safety prompt corrects the agent and prevents the same request again", () =>
    Effect.gen(function* () {
      yield* setup()
      safetyDecision.value = false
      yield* setAccessControl({ mode: "approve_for_me", safety_review: { model: "test/model" } })
      const service = yield* PermissionV2.Service
      const input = assertion({ action: "edit", resources: ["localization.json"] })
      const fiber = yield* service.assert(input).pipe(Effect.forkScoped)
      while ((yield* service.list()).length === 0) yield* Effect.yieldNow
      const [request] = yield* service.list()
      yield* service.reply({ requestID: request!.id, reply: "reject" })
      expect(JSON.stringify(yield* Fiber.await(fiber))).toContain("The user declined this safety prompt")
      expect(yield* service.ask(input)).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("rejects one asked permission and clears same-session pending asks", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest({ save: ["src/*"] })
      const second = yield* service
        .assert(assertion({ id: PermissionV2.ID.create("per_second"), resources: ["src/other.ts"] }))
        .pipe(Effect.forkScoped)
      let pending = yield* service.list()
      while (pending.length < 2) {
        yield* Effect.yieldNow
        pending = yield* service.list()
      }

      yield* service.reply({ requestID: request.id, reply: "reject" })

      expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
      expect((yield* Fiber.await(second))._tag).toBe("Failure")
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores an always approval and resolves matching same-session pending asks", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      const otherSessionID = SessionV2.ID.make("ses_other")
      yield* db
        .insert(SessionTable)
        .values({
          id: otherSessionID,
          project_id: Project.ID.global,
          slug: "other",
          directory: "/project",
          title: "other",
          version: "test",
          agent: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const { service, fiber, request } = yield* waitForRequest({ save: ["src/*"] })
      const second = yield* service
        .assert(assertion({ id: PermissionV2.ID.create("per_second"), resources: ["src/other.ts"] }))
        .pipe(Effect.forkScoped)
      const other = yield* service
        .assert(
          assertion({
            id: PermissionV2.ID.create("per_other"),
            sessionID: otherSessionID,
            resources: ["src/other.ts"],
          }),
        )
        .pipe(Effect.forkScoped)
      let pending = yield* service.list()
      while (pending.length < 3) {
        yield* Effect.yieldNow
        pending = yield* service.list()
      }

      yield* service.reply({ requestID: request.id, reply: "always" })

      yield* Fiber.join(fiber)
      yield* Fiber.join(second)
      const remaining = yield* service.list()
      expect(remaining).toMatchObject([{ id: PermissionV2.ID.create("per_other"), sessionID: otherSessionID }])
      yield* service.reply({ requestID: remaining[0]!.id, reply: "reject" })
      expect((yield* Fiber.await(other))._tag).toBe("Failure")
    }),
  )

  it.effect("publishes a reject reply when an asked permission is interrupted", () =>
    Effect.gen(function* () {
      yield* setup()
      const events = yield* EventV2.Service
      const published: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Replied.type
          ? Effect.sync(() => {
              published.push(event)
            })
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { service, fiber, request } = yield* waitForRequest()

      yield* Fiber.interrupt(fiber)

      expect(yield* service.list()).toEqual([])
      expect(published.map((event) => event.data)).toEqual([
        { sessionID: request.sessionID, requestID: request.id, reply: "reject" },
      ])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: Project.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )
})
