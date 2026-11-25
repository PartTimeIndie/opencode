import { describe, expect } from "bun:test"
import { randomUUID } from "node:crypto"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import fs from "node:fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "node:path"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AttachmentTable } from "@opencode-ai/core/attachment.sql"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { QuestionV2 } from "@opencode-ai/core/question"
import { QuestionTable } from "@opencode-ai/core/question/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { DelegationPreferences } from "@opencode-ai/core/session/delegation-preferences"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecutionView } from "@opencode-ai/core/session/execution-view"
import { SessionFork } from "@opencode-ai/core/session/fork"
import { SessionHostContext } from "@opencode-ai/core/session/host-context"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionAgentPolicy } from "@opencode-ai/core/session/agent-policy"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { WorkspaceCheckout } from "@opencode-ai/core/session/workspace/checkout"
import { WorkspaceBasis } from "@opencode-ai/core/session/workspace/basis"
import { MirrorRoot } from "@opencode-ai/core/session/workspace/mirror-root"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution/owner"
import { LegacyDelegationGuard } from "@opencode-ai/core/session/legacy-delegation/guard"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionActivityTable, SessionContextEpochTable, SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { TaskAdmission } from "@opencode-ai/core/session/task-admission"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { TaskTool } from "@opencode-ai/core/tool/task"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)
const parentID = SessionSchema.ID.make("ses_admission_parent")
const childID = SessionSchema.ID.make("ses_admission_child")
const assistantMessageID = SessionMessage.ID.make("msg_admission_assistant")
const promptID = SessionMessage.ID.make("msg_admission_prompt")
const build = AgentV2.ID.make("build")
const worker = AgentV2.ID.make("worker")
const model = { id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("fixture") }

const fixtureGit = (directory: string, args: string[], input?: Buffer) =>
  Effect.promise(async () => {
    const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd: directory, stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...Object.fromEntries(Object.entries(globalThis.process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(stderr)
    return stdout
  })
const initSource = (source: string) => Effect.gen(function* () {
  yield* fixtureGit(source, ["init", "--quiet"])
  yield* fixtureGit(source, ["config", "core.fsmonitor", "false"])
  yield* fixtureGit(source, ["config", "commit.gpgsign", "false"])
  yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "committed\n"))
  yield* fixtureGit(source, ["add", "--", "tracked.txt"])
  yield* fixtureGit(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"])
})
const exists = (target: string) => Effect.promise(() => fs.stat(target).then(() => true, () => false))
// A prepared root also carries the host ownership marker; only task-owned mirrors count.
const mirrorsIn = (root: string) => Effect.promise(() => fs.readdir(root).then((names) => names.filter((name) => name.startsWith("opencode-agent-"))))
// Resolves with the next blocking question the native UI receives for this fixture.
const asked = Effect.fn("TaskAdmissionTest.asked")(function* () {
  const events = yield* EventV2.Service
  const pending = yield* Deferred.make<QuestionV2.BlockingRequest>()
  const unsubscribe = yield* events.listen((event) =>
    event.type === QuestionV2.Event.Requested.type
      ? Deferred.succeed(pending, event.data as QuestionV2.BlockingRequest).pipe(Effect.asVoid)
      : Effect.void,
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  return pending
})
// Another volume than the OS temp dir, when this machine has one. The probe only
// stats roots; nothing is ever written there.
const otherVolumeRoot = await (async () => {
  const roots = process.platform === "win32"
    ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `${letter}:\\`)
    : ["/dev/shm", "/Volumes", "/mnt", "/media", "/run"]
  const temp = String((await fs.stat(osTmpdir())).dev)
  for (const root of roots) {
    const stat = await fs.stat(root).catch(() => undefined)
    if (stat?.isDirectory() && String(stat.dev) !== temp) return root
  }
  return undefined
})()

// A `nested` layout places the checkout at <tmp>/projects/source so the default
// mirror root (a hidden container beside the checkout) stays inside the tmp dir.
const fixture = <R>(body: (dependencies: TaskAdmission.Dependencies, input: TaskAdmission.Input) => Effect.Effect<void, unknown, R>, alias = false, nested = false) =>
  Effect.acquireUseRelease(Effect.promise(() => tmpdir()), (tmp) => {
    const database = Database.layerFromPath(":memory:")
    const events = EventV2.layer.pipe(Layer.provide(database))
    const projector = SessionProjector.layer.pipe(Layer.provide(database), Layer.provide(events))
    const store = SessionStore.layer.pipe(Layer.provide(database))
    const content = ContentStore.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer), Layer.provide(Global.layerWith({ data: tmp.path })))
    return Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      const content = yield* ContentStore.Service
      const agents = yield* AgentV2.Service
      const registry = yield* ToolRegistry.Service
      const checkouts = yield* WorkspaceCheckout.Service
      if (alias) yield* Effect.promise(async () => {
        for (const name of ["first", "second"]) {
          const initialized = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "init", "--quiet", "--", path.join(tmp.path, name)], {
            cwd: tmp.path, stdout: "ignore", stderr: "pipe",
            env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
              GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
          })
          const error = await new Response(initialized.stderr).text()
          if (await initialized.exited !== 0) throw new Error(`Fixture Git initialization failed: ${error}`)
        }
        await fs.symlink(path.join(tmp.path, "first"), path.join(tmp.path, "alias"), process.platform === "win32" ? "junction" : "dir")
      })
      if (nested) yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "projects", "source"), { recursive: true }))
      const location = Location.Ref.make({ directory: AbsolutePath.make(alias ? path.join(tmp.path, "alias") : nested ? path.join(tmp.path, "projects", "source") : tmp.path) })
      yield* agents.update((editor) => {
        editor.update(build, (agent) => { agent.mode = "primary" })
        editor.update(worker, (agent) => { agent.mode = "subagent" })
      })
      yield* db.insert(ProjectTable).values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: parentID, project_id: ProjectV2.ID.global, directory: location.directory, slug: "parent", title: "parent", version: "test", agent: build, model }).run()
      yield* db.insert(SessionContextEpochTable).values({ session_id: parentID, baseline: "parent context", baseline_seq: -1, snapshot: {}, agent: build }).run()
      yield* db.insert(SessionActivityTable).values({ id: "act_fixture", session_id: parentID, status: "running", kind: "prompt", owner_id: "owner_fixture", lease_until: Date.now() + 60_000 }).run()
      yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_parent_user"), sessionID: parentID, prompt: new Prompt({ text: "Parent evidence" }), delivery: "steer" })
      yield* SessionInput.promoteSteers(db, events, parentID, Number.MAX_SAFE_INTEGER)
      const timestamp = DateTime.makeUnsafe(10)
      yield* events.publish(SessionEvent.Step.Started, { sessionID: parentID, assistantMessageID, timestamp, agent: build, model })
      yield* events.publish(SessionEvent.Tool.Input.Started, { sessionID: parentID, assistantMessageID, timestamp, callID: "dispatch", name: "task" })
      yield* events.publish(SessionEvent.Tool.Input.Ended, { sessionID: parentID, assistantMessageID, timestamp, callID: "dispatch", text: "{}" })
      yield* events.publish(SessionEvent.Tool.Called, { sessionID: parentID, assistantMessageID, timestamp, callID: "dispatch", tool: "task", input: {}, provider: { executed: false } })
      const permission: PermissionV2.Interface = {
        assert: () => Effect.void, assertSingleUse: (request) => Effect.succeed(request.id ?? PermissionV2.ID.create()),
        ask: () => Effect.die("unused"), reply: () => Effect.die("unused"),
        get: () => Effect.succeed(undefined), forSession: () => Effect.succeed([]), list: () => Effect.succeed([]),
        materializationRules: () => Effect.succeed([]),
        policySnapshot: () => Effect.succeed({ configured: [], inherited: [], remembered: [], accessControl: { mode: "ask" }, safetyReviewAvailable: false, reviewed: [], rejected: [] }),
      }
      yield* SessionExecutionOwner.withOwner({ sessionID: parentID, activityID: "act_fixture", ownerID: "owner_fixture" }, body(
        { db, events, store, content, agents, registry, checkouts, permission, delegationLayers: () => Effect.succeed([]) },
        { create: { id: childID, parentID, agent: worker, model, location },
          prompt: { id: promptID, sessionID: childID, prompt: new Prompt({ text: "Child assignment" }), agent: worker, model, resume: false },
          workspace: "main", parentAgent: build, boundary: { assistantMessageID, toolCallID: "dispatch" } },
      ))
    }).pipe(Effect.provide(Layer.mergeAll(database, events, projector, store, content, AgentV2.layer, ToolRegistry.defaultLayer, WorkspaceCheckout.layer)))
  }, (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()))

describe("atomic native task admission", () => {
  for (const context of ["fork", "fresh"] as const) {
    it.live(`admits ${context} context with future queue work and keeps it out of the child`, () => fixture((dependencies, input) => Effect.gen(function* () {
      const queued = yield* SessionInput.admit(dependencies.db, dependencies.events, {
        id: SessionMessage.ID.create(), sessionID: parentID, prompt: new Prompt({ text: "Future queued work" }), delivery: "queue",
      })
      const request = { ...input, workspace: "readonly" as const, context }
      const child = yield* TaskAdmission.admit(dependencies, request)
      expect(child.agentPolicy?.taskContext).toBe(context)
      expect(SessionAgentPolicy.isReadOnly(child.agentPolicy)).toBe(true)
      const messages = yield* dependencies.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, childID)).all()
      expect(messages.some((row) => JSON.stringify(row.data).includes("Future queued work"))).toBe(false)
      expect(messages.filter((row) => row.type === "user").length).toBe(context === "fork" ? 1 : 0)
      expect((yield* SessionInput.find(dependencies.db, queued.id))?.promotedSeq).toBeUndefined()
      expect((yield* TaskAdmission.admit(dependencies, request)).id).toBe(child.id)
      expect(Exit.isFailure(yield* Effect.exit(TaskAdmission.admit(dependencies, { ...request, context: context === "fork" ? "fresh" : "fork" })))).toBe(true)
    })))

    for (const delivery of ["steer", "queue"] as const)
    for (const held of [false, true].filter((held) => delivery === "steer" || held)) it.live(`refuses ${held ? "held" : "pending"} ${delivery} before ${context} dispatch`, () => fixture((dependencies, input) => Effect.gen(function* () {
      yield* SessionInput.admit(dependencies.db, dependencies.events, {
        id: SessionMessage.ID.create(), sessionID: parentID, prompt: new Prompt({ text: "Current course correction" }), delivery,
      })
      if (held) yield* SessionInput.holdPending(dependencies.db, dependencies.events, parentID)
      const error = yield* TaskAdmission.admit(dependencies, { ...input, workspace: "readonly", context }).pipe(Effect.flip)
      expect(error).toMatchObject({ reason: "pending" })
      expect(yield* dependencies.store.get(childID)).toBeUndefined()
    })))

    for (const delivery of ["queue", "steer"] as const)
    it.live(`refuses new ${delivery} during awaited ${context} approval`, () => fixture((dependencies, input) => Effect.gen(function* () {
      const deps = { ...dependencies, permission: { ...dependencies.permission,
        assertSingleUse: () => Effect.gen(function* () {
          yield* SessionInput.admit(dependencies.db, dependencies.events, {
            id: SessionMessage.ID.create(), sessionID: parentID,
            prompt: new Prompt({ text: "New work while waiting for approval" }), delivery,
          })
          return PermissionV2.ID.create()
        }),
      } }
      expect(Exit.isFailure(yield* TaskAdmission.admit(deps, { ...input, context }).pipe(Effect.exit))).toBe(true)
      expect(yield* dependencies.store.get(childID)).toBeUndefined()
    })))

    for (const action of ["task", "multi_agent_fanout"] as const)
    for (const pending of ["steer", "held-steer", "held-queue"] as const)
    it.live(`admits only a new ${action}/${context} assignment after normal ${pending} promotion`, () => fixture((dependencies, input) => Effect.gen(function* () {
      const { db, events, store } = dependencies
      const correction = yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(), sessionID: parentID,
        prompt: new Prompt({ text: "Current request replaces the old assignment" }),
        delivery: pending === "held-queue" ? "queue" : "steer",
      })
      if (pending !== "steer") yield* SessionInput.holdPending(db, events, parentID)
      const rejected = { ...input, workspace: "readonly" as const, context, action }
      expect(yield* TaskAdmission.admit(dependencies, rejected).pipe(Effect.flip))
        .toBeInstanceOf(SessionFork.CaptureConflict)
      expect(yield* TaskAdmission.admit(dependencies, rejected).pipe(Effect.flip))
        .toMatchObject({ reason: "pending" })
      expect(yield* store.get(childID)).toBeUndefined()
      expect(yield* SessionInput.find(db, promptID)).toBeUndefined()
      expect((yield* SessionInput.find(db, correction.id))?.promotedSeq).toBeUndefined()

      // Settle the rejected call before the runner's normal safe-boundary promotion.
      const timestamp = DateTime.makeUnsafe(20)
      yield* events.publish(SessionEvent.Tool.Failed, {
        sessionID: parentID, assistantMessageID, timestamp, callID: "dispatch",
        error: { type: "unknown", message: "Task admission refused pending input" }, provider: { executed: false },
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: parentID, assistantMessageID, timestamp, finish: "tool-calls", cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      if (pending !== "steer") {
        expect(yield* SessionInput.promoteSteers(db, events, parentID, Number.MAX_SAFE_INTEGER)).toBe(0)
        expect(yield* SessionInput.promoteNextQueued(db, events, parentID)).toBe(false)
        yield* SessionInput.release(db, events, { id: correction.id, sessionID: parentID, prompt: correction.prompt })
      }
      if (correction.delivery === "queue") expect(yield* SessionInput.promoteNextQueued(db, events, parentID)).toBe(true)
      else expect(yield* SessionInput.promoteSteers(db, events, parentID, Number.MAX_SAFE_INTEGER)).toBe(1)
      expect((yield* SessionInput.find(db, correction.id))?.promotedSeq).toBeNumber()
      expect(Exit.isFailure(yield* TaskAdmission.admit(dependencies, rejected).pipe(Effect.exit))).toBe(true)

      const currentAssistant = SessionMessage.ID.create()
      const currentChild = SessionSchema.ID.create()
      const currentPrompt = SessionMessage.ID.create()
      const boundary = { assistantMessageID: currentAssistant, toolCallID: "current-dispatch" }
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: parentID, assistantMessageID: currentAssistant, timestamp, agent: build, model,
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID: parentID, assistantMessageID: currentAssistant, timestamp,
        callID: boundary.toolCallID, name: action,
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID: parentID, assistantMessageID: currentAssistant, timestamp,
        callID: boundary.toolCallID, text: "{}",
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID: parentID, assistantMessageID: currentAssistant, timestamp,
        callID: boundary.toolCallID, tool: action, input: {}, provider: { executed: false },
      })
      const capture = yield* SessionFork.capture(db, {
        sessionID: parentID, throughSeq: yield* SessionInput.latestSeq(db, parentID), dispatch: boundary, context,
      })
      expect(capture.dispatchInput?.message.id).toBe(correction.id)
      const child = yield* TaskAdmission.admit(dependencies, {
        ...rejected, boundary, create: { ...input.create, id: currentChild },
        prompt: { ...input.prompt, id: currentPrompt, sessionID: currentChild,
          prompt: new Prompt({ text: "Assignment for the current request" }) },
      })
      expect(child.id).toBe(currentChild)
      expect((yield* SessionInput.find(db, currentPrompt))?.prompt.text).toBe("Assignment for the current request")
      // No automatic replay or start of the rejected assignment, even after a new admission.
      expect(Exit.isFailure(yield* TaskAdmission.admit(dependencies, rejected).pipe(Effect.exit))).toBe(true)
      expect(yield* store.get(childID)).toBeUndefined()
      expect(yield* SessionInput.find(db, promptID)).toBeUndefined()
      expect(yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, childID)).all()).toEqual([])
      expect((yield* db.select().from(SessionTable).where(eq(SessionTable.parent_id, parentID)).all()).map((row) => row.id)).toEqual([currentChild])
    })))
  }

  it.live("fresh context does not import parent attachments or require their bytes", () => fixture((dependencies, input) => Effect.gen(function* () {
    const row = yield* dependencies.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_parent_user"))).get()
    if (!row || row.type !== "user") throw new Error("Missing fixture user")
    const data = { ...row.data,
      files: [{ uri: "attachment://att_missing_parent_file", mime: "text/plain" }],
    }
    yield* dependencies.db.update(SessionMessageTable).set({ data }).where(eq(SessionMessageTable.id, row.id)).run()
    const child = yield* TaskAdmission.admit(dependencies, { ...input, workspace: "readonly", context: "fresh" })
    expect(child.agentPolicy?.taskContext).toBe("fresh")
    expect(yield* dependencies.db.select().from(AttachmentTable).where(eq(AttachmentTable.session_id, childID)).all()).toEqual([])
    expect(yield* dependencies.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, childID)).all()).toEqual([])
    expect((yield* SessionInput.find(dependencies.db, promptID))?.prompt.text).toBe("Child assignment")
  })))

  it.live("admits a steer to a running dispatched child and keeps later assignments fenced", () =>
    fixture((dependencies, input) =>
      Effect.gen(function* () {
        const { db, events } = dependencies
        yield* TaskAdmission.admit(dependencies, input)
        const fenced = (sessionID: SessionSchema.ID, delivery: "steer" | "queue", text: string) =>
          SessionInput.admit(db, events, {
            id: SessionMessage.ID.create(),
            sessionID,
            prompt: new Prompt({ text }),
            delivery,
          }).pipe(
            Effect.catchDefect((defect) =>
              defect instanceof SessionInput.LifecycleConflict ? Effect.succeed("fenced" as const) : Effect.die(defect),
            ),
          )
        // Without an active run the steer stays fenced like any later assignment.
        expect(yield* fenced(childID, "steer", "Course correction without an active run")).toBe("fenced")
        yield* db.insert(SessionActivityTable).values({
          id: "act_child_steer", session_id: childID, status: "running", kind: "prompt",
          owner_id: "owner_child", lease_until: Date.now() + 60_000,
        }).run()
        const admitted = yield* SessionInput.admit(db, events, {
          id: SessionMessage.ID.create(), sessionID: childID,
          prompt: new Prompt({ text: "Prefer the mirror result in the summary" }),
          delivery: "steer",
        })
        expect(admitted.delivery).toBe("steer")
        expect(admitted.promotedSeq).toBeUndefined()
        // At the child's next safe turn the runtime holds the admitted steer and
        // releases it with the current agent/model stamp releaseInput adds; the
        // release fence must not die on that patch for steer rows.
        yield* SessionInput.holdPending(db, events, childID)
        const released = yield* SessionInput.release(db, events, {
          id: admitted.id, sessionID: childID,
          prompt: new Prompt({ ...admitted.prompt, agent: worker, model }),
        })
        expect(released?.id).toBe(admitted.id)
        // A queued extra assignment stays fenced; an ordinary parent steer is
        // and remains unfenced.
        expect(yield* fenced(childID, "queue", "Extra queued assignment")).toBe("fenced")
        expect(yield* fenced(parentID, "steer", "Parent course correction")).not.toBe("fenced")
      }),
    ),
  )

  for (const workspace of ["main", "readonly"] as const)
  for (const boundary of ["same-activity", "queue", "before-assignment", "expired", "later-activity", "completed", "no-owner"] as const)
  it.live(`workspace ${workspace} permits only an owned same-activity pending steer (${boundary})`, () =>
    fixture((dependencies, input) => Effect.gen(function* () {
      const { db, events } = dependencies
      yield* TaskAdmission.admit(dependencies, { ...input, workspace })
      const opened = yield* SessionInput.latestSeq(db, childID)
      yield* db.insert(SessionActivityTable).values({
        id: "act_child_scope", session_id: childID, status: "running", kind: "prompt",
        owner_id: "owner_child_scope", opened_seq: opened, lease_until: Date.now() + 60_000,
      }).run()
      yield* SessionInput.promoteSteers(db, events, childID, Number.MAX_SAFE_INTEGER)
      const bound = yield* SessionInput.find(db, promptID)
      if (bound?.promotedSeq === undefined) throw new Error("Expected promoted task assignment")
      const correction = yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(), sessionID: childID,
        prompt: new Prompt({ text: "Refine the running assignment" }), delivery: "steer",
      })
      if (boundary === "queue" || boundary === "before-assignment")
        yield* db.update(SessionInputTable).set(boundary === "queue" ? { delivery: "queue" } : { admitted_seq: -1 })
          .where(eq(SessionInputTable.id, correction.id)).run()
      if (boundary === "expired" || boundary === "later-activity" || boundary === "completed")
        yield* db.update(SessionActivityTable).set(boundary === "expired" ? { lease_until: 0 }
          : boundary === "completed" ? { status: "completed", closed_seq: correction.admittedSeq }
          : { opened_seq: bound.promotedSeq + 1 }).where(eq(SessionActivityTable.id, "act_child_scope")).run()
      const check = WorkspaceCheckout.assertSession(db, childID).pipe(Effect.exit)
      const result = yield* (boundary === "no-owner" ? check : SessionExecutionOwner.withOwner({
        sessionID: childID, activityID: "act_child_scope", ownerID: "owner_child_scope",
      }, check))
      expect(Exit.isSuccess(result)).toBe(boundary === "same-activity")
    })),
  )

  it.live("revalidates a direct reviewer assignment without grafting the parent's chain", () => fixture((dependencies, input) => Effect.gen(function* () {
    const inherited = { ...model, chain: { id: "parent-chain", name: "Parent chain", active: 0,
      steps: [model, { ...model, id: ModelV2.ID.make("fallback") }] } }
    yield* dependencies.db.update(SessionTable).set({ model: inherited }).where(eq(SessionTable.id, parentID)).run()
    const selected = { ...model, chain: null }
    const child = yield* TaskAdmission.admit({ ...dependencies, workflowModels: () => Effect.succeed([selected]) }, {
      ...input, action: "multi_agent_fanout",
      create: { ...input.create, model: selected }, prompt: { ...input.prompt, model: selected },
      modelSelection: { requested: `${model.providerID}/${model.id}`, workflow: "review" },
    })
    expect(child.model).toMatchObject(selected)
    const admitted = yield* SessionInput.find(dependencies.db, promptID)
    expect(admitted?.prompt.model?.chain).toBeNull()
  })))

  it.live("retains a bounded mirror root refusal without admitting or falling back to Main", () => fixture((dependencies, input) => Effect.gen(function* () {
    const mirrorRoot = path.join(input.create.location.directory, "..", "occupied-root")
    yield* Effect.promise(() => fs.writeFile(mirrorRoot, "occupied"))
    const result = yield* TaskAdmission.admit({ ...dependencies, mirrorRoot,
      permission: { ...dependencies.permission, assertSingleUse: () => Effect.die("No Main fallback") },
    }, { ...input, workspace: "mirror" }).pipe(Effect.flip)
    expect(result).toBeInstanceOf(TaskAdmission.Conflict)
    expect(result).toMatchObject({ reason: "placement", stage: "mirror-root", cause: { code: "not-folder" } })
    expect(result.message).toContain("placement/mirror-root")
    expect(result.message).toContain("occupied-root")
    expect(result.message.length).toBeLessThan(2100)
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* dependencies.db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, childID)).all()).toEqual([])
  }), false, true))

  it.live("does not fall back to Main when default mirror support is absent", () => fixture((dependencies, input) => Effect.gen(function* () {
    const outcome = yield* TaskAdmission.admit({ ...dependencies,
      permission: { ...dependencies.permission, assertSingleUse: () => Effect.die("Missing mirror must not ask for Main") },
    }, { ...input, workspace: undefined }).pipe(Effect.exit)
    expect(Exit.isFailure(outcome)).toBe(true)
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* dependencies.db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, childID)).all()).toEqual([])
  })))

  it.live("keeps a bounded mirror stage cause when the source index is unresolved after the root was accepted", () => fixture((dependencies, input) => Effect.gen(function* () {
    const source = input.create.location.directory
    yield* initSource(source)
    const hash = yield* fixtureGit(source, ["rev-parse", "HEAD:tracked.txt"])
    yield* fixtureGit(source, ["update-index", "--index-info"], Buffer.from(`100644 ${hash.trim()} 1\ttracked.txt\n100644 ${hash.trim()} 2\ttracked.txt\n`))
    const result = yield* TaskAdmission.admit({ ...dependencies, mirrorRoot: path.join(source, "..", "mirrors"),
      permission: { ...dependencies.permission, assertSingleUse: () => Effect.die("No Main fallback") },
    }, { ...input, workspace: "mirror" }).pipe(Effect.flip)
    expect(result).toMatchObject({ reason: "placement", stage: "mirror", cause: { message: "Cannot snapshot an unresolved Git index" } })
    expect(result.message).toContain("placement/mirror")
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* exists(path.join(source, "..", "mirrors"))).toBe(true)
  })))

  it.live("creates new mirrors beside the checkout on its own volume, never under the old global data root", () => fixture((dependencies, input) => Effect.gen(function* () {
    const source = input.create.location.directory
    yield* initSource(source)
    const deps = { ...dependencies, mirrorRoot: MirrorRoot.defaultRoot,
      permission: { ...dependencies.permission, assertSingleUse: () => Effect.die("Mirror must not request Main consent") } }
    const request = { ...input, workspace: "mirror" as const }
    const child = yield* TaskAdmission.admit(deps, request)
    const container = path.join(source, "..", ".opencode-task-mirrors")
    const roots = yield* Effect.promise(() => fs.readdir(container))
    expect(roots).toHaveLength(1)
    expect(roots[0]).toMatch(new RegExp(`^${path.basename(source)}-[a-f0-9]{12}$`))
    expect(child.location.directory.startsWith(path.join(container, roots[0]!, "opencode-agent-"))).toBe(true)
    expect(child.location.directory.startsWith(source + path.sep)).toBe(false)
    expect(child.agentPolicy?.mirrorWorkspace?.directory).toBe(child.location.directory)
    // The former Global-data root is not consulted for a new mirror.
    expect(yield* Effect.promise(() => fs.readdir(path.dirname(path.dirname(source))))).not.toContain("native-task-workspaces")
    // The saved descriptor stays authoritative for the exact retry even when the
    // host root resolver would now be refused: nothing is moved or re-created.
    const retried = yield* TaskAdmission.admit({ ...deps, mirrorRoot: path.join(source, "..", "missing", "root") }, request)
    expect(retried.location).toEqual(child.location)
    expect(retried.agentPolicy?.mirrorWorkspace).toEqual(child.agentPolicy?.mirrorWorkspace)
    expect(yield* mirrorsIn(path.join(container, roots[0]!))).toHaveLength(1)
  }), false, true))

  it.live("refuses a root on another volume, inside the checkout, or absent without admitting or asking for Main", () => fixture((dependencies, input) => Effect.gen(function* () {
    const deps = { ...dependencies, permission: { ...dependencies.permission, assertSingleUse: () => Effect.die("No Main fallback") } }
    const request = { ...input, workspace: "mirror" as const }
    if (otherVolumeRoot) {
      const root = path.join(otherVolumeRoot, `opencode-mirror-root-probe-${randomUUID()}`, "root")
      const volume = yield* TaskAdmission.admit({ ...deps, mirrorRoot: root }, request).pipe(Effect.flip)
      expect(volume).toMatchObject({ reason: "placement", stage: "mirror-root", cause: { code: "volume" } })
      expect(volume.message).toContain(otherVolumeRoot)
      expect(yield* exists(path.dirname(root))).toBe(false)
    }
    const inside = yield* TaskAdmission.admit({ ...deps, mirrorRoot: path.join(input.create.location.directory, "mirrors") }, request).pipe(Effect.flip)
    expect(inside).toMatchObject({ reason: "placement", stage: "mirror-root", cause: { code: "inside" } })
    const absent = yield* TaskAdmission.admit({ ...deps, mirrorRoot: () => undefined }, request).pipe(Effect.flip)
    expect(absent).toMatchObject({ reason: "placement", stage: "mirror-root", cause: { code: "absent" } })
    expect(absent.message.length).toBeLessThan(2100)
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* Effect.promise(() => fs.readdir(input.create.location.directory))).not.toContain("mirrors")
  })))

  it.live("offers exactly one folder choice through the native question UI and admits the mirror under the validated answer", () => fixture((dependencies, input) => Effect.gen(function* () {
    const source = input.create.location.directory
    yield* initSource(source)
    const questions = yield* QuestionV2.Service.pipe(Effect.provide(QuestionV2.layer))
    const pending = yield* asked()
    const occupied = path.join(source, "..", "occupied-root")
    yield* Effect.promise(() => fs.writeFile(occupied, "occupied"))
    const chosen = path.join(source, "..", "chosen-mirrors")
    const deps = { ...dependencies, mirrorRoot: occupied, mirrorRootChoice: TaskTool.mirrorRootChoice(questions),
      permission: { ...dependencies.permission, assertSingleUse: () => Effect.die("No Main fallback") } }
    const request = { ...input, workspace: "mirror" as const }
    const admission = yield* TaskAdmission.admit(deps, request).pipe(Effect.forkScoped)
    const surface = yield* Deferred.await(pending)
    // The receipt is keyed to the parent's exact tool call of this start.
    expect(surface.sessionID).toBe(parentID)
    expect(surface.tool).toEqual({ messageID: assistantMessageID, callID: "dispatch" })
    const question = surface.questions[0]!
    expect(question.type).toBe("form")
    expect(question.body?.[0]).toMatchObject({ type: "markdown", content: expect.stringContaining("occupied-root") })
    expect(question.form?.fields.map((field) => [field.id, field.type, field.multiple])).toEqual([
      ["binding", "hidden", undefined], ["folder", "folder_picker", false],
    ])
    expect(String(question.form?.fields[0]?.defaultValue)).toContain(childID)
    yield* questions.reply({ requestID: surface.id, answers: [[JSON.stringify({ version: 1, type: "opencode.form.answer",
      formID: question.form?.id, values: { binding: question.form?.fields[0]?.defaultValue, folder: [chosen] } })]] })
    const child = yield* Fiber.join(admission)
    expect(child.location.directory.startsWith(path.join(chosen, "opencode-agent-"))).toBe(true)
    expect(child.agentPolicy?.mirrorWorkspace?.directory).toBe(child.location.directory)
    expect(yield* exists(path.join(chosen, ".opencode-mirror-root.json"))).toBe(true)
    expect(yield* questions.list()).toEqual([])
    const receipts = yield* dependencies.db.select({ messageID: QuestionTable.assistant_message_id, callID: QuestionTable.tool_call_id, state: QuestionTable.state })
      .from(QuestionTable).all()
    expect(receipts).toEqual([{ messageID: assistantMessageID, callID: "dispatch", state: "replied" }])
    // An exact retry reconciles through the saved descriptor without a second question.
    expect((yield* TaskAdmission.admit(deps, request)).location).toEqual(child.location)
    expect((yield* dependencies.db.select({ id: QuestionTable.id }).from(QuestionTable).all()).length).toBe(1)
    expect(yield* Effect.promise(() => fs.readdir(chosen))).toEqual([".opencode-mirror-root.json", path.basename(path.dirname(child.location.directory))])
  }), false, true))

  it.live("rejects a folder answer bound to a different start and a retried start whose dispatch binding drifted", () => fixture((dependencies, input) => Effect.gen(function* () {
    const source = input.create.location.directory
    yield* initSource(source)
    const questions = yield* QuestionV2.Service.pipe(Effect.provide(QuestionV2.layer))
    const pending = yield* asked()
    const occupied = path.join(source, "..", "occupied-root")
    yield* Effect.promise(() => fs.writeFile(occupied, "occupied"))
    const chosen = path.join(source, "..", "chosen-mirrors")
    const deps = { ...dependencies, mirrorRoot: occupied, mirrorRootChoice: TaskTool.mirrorRootChoice(questions) }
    const request = { ...input, workspace: "mirror" as const }
    const first = yield* TaskAdmission.admit(deps, request).pipe(Effect.forkScoped)
    const surface = yield* Deferred.await(pending)
    const question = surface.questions[0]!
    yield* questions.reply({ requestID: surface.id, answers: [[JSON.stringify({ version: 1, type: "opencode.form.answer",
      formID: question.form?.id, values: { binding: "another start", folder: [chosen] } })]] })
    const drifted = yield* Effect.flip(Fiber.join(first))
    expect(drifted).toMatchObject({ reason: "placement", stage: "mirror-root", cause: { code: "answer" } })
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* exists(chosen)).toBe(false)
    // The child agent policy changed after the first attempt, so the same tool
    // call now carries a different dispatch binding: its question receipt no
    // longer matches and the start is refused instead of re-asked or admitted.
    yield* dependencies.agents.update((editor) => editor.update(worker, (agent) => {
      agent.permissions = [...agent.permissions, { action: "write", resource: "drift-fixture", effect: "deny" }]
    }))
    const retried = yield* TaskAdmission.admit(deps, request).pipe(Effect.flip)
    expect(retried).toMatchObject({ reason: "placement", stage: "mirror-root" })
    expect((retried as TaskAdmission.Conflict).cause).toBeInstanceOf(QuestionV2.ConflictError)
    expect(retried.message).toContain("different question payload")
    expect((yield* dependencies.db.select({ id: QuestionTable.id }).from(QuestionTable).all()).length).toBe(1)
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
  }), false, true))

  it.live("dismissal means no start and the same call is not asked again", () => fixture((dependencies, input) => Effect.gen(function* () {
    const source = input.create.location.directory
    yield* initSource(source)
    const questions = yield* QuestionV2.Service.pipe(Effect.provide(QuestionV2.layer))
    const pending = yield* asked()
    const occupied = path.join(source, "..", "occupied-root")
    yield* Effect.promise(() => fs.writeFile(occupied, "occupied"))
    const deps = { ...dependencies, mirrorRoot: occupied, mirrorRootChoice: TaskTool.mirrorRootChoice(questions),
      permission: { ...dependencies.permission, assertSingleUse: () => Effect.die("No Main fallback") } }
    const request = { ...input, workspace: "mirror" as const }
    const admission = yield* TaskAdmission.admit(deps, request).pipe(Effect.forkScoped)
    const surface = yield* Deferred.await(pending)
    yield* questions.reject(surface.id)
    const dismissed = yield* Effect.flip(Fiber.join(admission))
    expect(dismissed).toMatchObject({ reason: "dismissed" })
    expect(dismissed.message).toContain("no task was started")
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* dependencies.db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, childID)).all()).toEqual([])
    expect(yield* questions.list()).toEqual([])
    const second = yield* asked()
    const again = yield* TaskAdmission.admit(deps, request).pipe(Effect.flip)
    expect(again).toMatchObject({ reason: "dismissed" })
    expect((yield* Deferred.await(second).pipe(Effect.timeoutOption("500 millis")))._tag).toBe("None")
    expect((yield* dependencies.db.select({ id: QuestionTable.id }).from(QuestionTable).all()).length).toBe(1)
    expect(yield* exists(path.join(source, "..", "chosen-mirrors"))).toBe(false)
  }), false, true))

  it.live("binds a private mirror and immutable basis without Main consent, including concurrent exact retries", () => fixture((dependencies, input) => Effect.gen(function* () {
    const source = input.create.location.directory
    yield* Effect.promise(async () => {
      await fs.writeFile(path.join(source, "tracked.txt"), "committed\n")
      for (const args of [["add", "--", "tracked.txt"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]]) {
        const process = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
          cwd: source, stdout: "ignore", stderr: "pipe",
          env: { ...Object.fromEntries(Object.entries(globalThis.process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
            GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
        })
        const error = await new Response(process.stderr).text()
        if (await process.exited !== 0) throw new Error(error)
      }
      await fs.writeFile(path.join(source, "tracked.txt"), "dirty source\n")
      await fs.writeFile(path.join(source, "private-untracked.txt"), "must not be copied")
      await fs.writeFile(path.join(source, "selected.ts"), "export const selected = true")
    })
    const deps = { ...dependencies, mirrorRoot: path.join(source, "..", "mirrors"),
      permission: { ...dependencies.permission, assertSingleUse: () => Effect.die("Mirror must not request Main consent") } }
    const request = { ...input, workspace: undefined, untrackedPaths: ["selected.ts"] }
    const children = yield* Effect.all([TaskAdmission.admit(deps, request), TaskAdmission.admit(deps, request)], { concurrency: 2 })
    const child = children[0]
    if (!child) return yield* Effect.die("Missing mirror child")
    expect(children[1]?.location).toEqual(child.location)
    expect(child.location.directory).not.toBe(source)
    expect(child.agentPolicy?.mainWriteConsent).toBeUndefined()
    expect(child.agentPolicy?.mirrorWorkspace?.basis.files.map((file) => file.path)).toEqual(["selected.ts", "tracked.txt"])
    expect(yield* Effect.promise(() => Bun.file(path.join(child.location.directory, "private-untracked.txt")).exists())).toBe(false)
    expect(yield* Effect.promise(() => Bun.file(path.join(child.location.directory, "selected.ts")).text())).toBe("export const selected = true")
    expect(yield* WorkspaceCheckout.assertSession(dependencies.db, childID)).toBe(true)
    expect(yield* Effect.promise(() => fs.readFile(path.join(child.location.directory, "tracked.txt"), "utf8"))).toBe("dirty source\n")
    yield* Effect.promise(() => fs.writeFile(path.join(child.location.directory, "tracked.txt"), "private child\n"))
    expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("dirty source\n")
    expect((yield* TaskAdmission.admit(deps, request)).location).toEqual(child.location)
    expect(yield* mirrorsIn(deps.mirrorRoot)).toHaveLength(1)
    expect(Exit.isFailure(yield* WorkspaceCheckout.assertWrite(dependencies.db, childID,
      path.join(child.location.directory, "tracked.txt")).pipe(Effect.exit))).toBe(true)
    yield* dependencies.db.insert(SessionActivityTable).values({ id: "act_mirror", session_id: childID,
      status: "running", kind: "prompt", owner_id: "mirror_owner", lease_until: Date.now() + 60_000 }).run()
    yield* SessionExecutionOwner.withOwner({ sessionID: childID, activityID: "act_mirror", ownerID: "mirror_owner" }, Effect.gen(function* () {
      yield* WorkspaceCheckout.assertWrite(dependencies.db, childID, path.join(child.location.directory, "tracked.txt"))
      expect(Exit.isFailure(yield* WorkspaceCheckout.assertWrite(dependencies.db, childID, path.join(source, "tracked.txt")).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* WorkspaceCheckout.assertWrite(dependencies.db, childID, `${child.location.directory}-sibling/file`).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* WorkspaceCheckout.assertWrite(dependencies.db, childID, undefined).pipe(Effect.exit))).toBe(true)
    }))
    const opened = yield* SessionInput.latestSeq(dependencies.db, childID)
    yield* dependencies.db.update(SessionActivityTable).set({ opened_seq: opened })
      .where(eq(SessionActivityTable.id, "act_mirror")).run()
    yield* SessionInput.promoteSteers(dependencies.db, dependencies.events, childID, Number.MAX_SAFE_INTEGER)
    const bound = yield* SessionInput.find(dependencies.db, promptID)
    if (bound?.promotedSeq === undefined) return yield* Effect.die("Missing promoted mirror assignment")
    const correction = yield* SessionInput.admit(dependencies.db, dependencies.events, {
      id: SessionMessage.ID.create(), sessionID: childID, delivery: "steer", prompt: new Prompt({ text: "Refine the mirror assignment" }),
    })
    const guarded = SessionExecutionOwner.withOwner({ sessionID: childID, activityID: "act_mirror", ownerID: "mirror_owner" },
      WorkspaceCheckout.assertSession(dependencies.db, childID).pipe(Effect.exit))
    expect(Exit.isFailure(yield* WorkspaceCheckout.assertSession(dependencies.db, childID).pipe(Effect.exit))).toBe(true)
    expect(Exit.isSuccess(yield* guarded)).toBe(true)
    yield* dependencies.db.update(SessionActivityTable).set({ opened_seq: bound.promotedSeq + 1 })
      .where(eq(SessionActivityTable.id, "act_mirror")).run()
    expect(Exit.isFailure(yield* guarded)).toBe(true)
    yield* dependencies.db.update(SessionActivityTable).set({ opened_seq: opened })
      .where(eq(SessionActivityTable.id, "act_mirror")).run()
    yield* dependencies.db.update(SessionInputTable).set({ delivery: "queue" }).where(eq(SessionInputTable.id, correction.id)).run()
    expect(Exit.isFailure(yield* guarded)).toBe(true)
    yield* dependencies.db.update(SessionInputTable).set({ delivery: "steer" }).where(eq(SessionInputTable.id, correction.id)).run()
    yield* SessionInput.promoteSteers(dependencies.db, dependencies.events, childID, Number.MAX_SAFE_INTEGER)
    expect(yield* WorkspaceCheckout.assertSession(dependencies.db, childID)).toBe(true)
    const saved = child.agentPolicy
    const mirror = saved?.mirrorWorkspace
    if (!saved || !mirror) return yield* Effect.die("Missing mirror binding")
    yield* dependencies.db.update(SessionTable).set({ agent_policy: { ...saved,
      mirrorWorkspace: { ...mirror, basisDigest: "0".repeat(64) } } }).where(eq(SessionTable.id, childID)).run()
    expect(Exit.isFailure(yield* WorkspaceCheckout.assertSession(dependencies.db, childID).pipe(Effect.exit))).toBe(true)
  }), true))

  it.live("admits a technically readonly Main reader without a writing exception and binds exact retries", () => fixture((dependencies, input) => Effect.gen(function* () {
    const reader = { ...input, workspace: "readonly" as const }
    const deps = { ...dependencies, permission: { ...dependencies.permission,
      assertSingleUse: () => Effect.die("Readonly must not request a Main writing exception"),
    } }
    const child = yield* TaskAdmission.admit(deps, reader)
    expect(SessionAgentPolicy.isReadOnly(child.agentPolicy)).toBe(true)
    expect(child.agentPolicy?.mainWriteConsent).toBeUndefined()
    expect(child.agentPolicy?.readOnlyInputID).toBe(promptID)
    expect(yield* WorkspaceCheckout.assertSession(dependencies.db, childID)).toBe(true)
    expect((yield* TaskAdmission.admit(deps, reader)).id).toBe(childID)
    const changed = yield* SessionInput.admit(dependencies.db, dependencies.events, {
      id: SessionMessage.ID.make("msg_new_readonly_assignment"), sessionID: childID,
      prompt: new Prompt({ text: "A different task" }), delivery: "steer",
    }).pipe(Effect.exit)
    expect(Exit.isFailure(changed)).toBe(true)
    const widened = yield* TaskAdmission.admit(deps, input).pipe(Effect.exit)
    expect(Exit.isFailure(widened)).toBe(true)
    const policy = child.agentPolicy
    if (!policy) return yield* Effect.die("Missing reader policy")
    yield* dependencies.db.update(SessionTable).set({ agent_policy: { ...policy, permissionLayers: [] } })
      .where(eq(SessionTable.id, childID)).run()
    expect(Exit.isFailure(yield* WorkspaceCheckout.assertSession(dependencies.db, childID).pipe(Effect.exit))).toBe(true)
  })))

  const publishFollowupBoundary = (dependencies: TaskAdmission.Dependencies, callID: string) => {
    const assistant = SessionMessage.ID.make(`msg_followup_${callID}`)
    return Effect.gen(function* () {
      const timestamp = DateTime.makeUnsafe(20)
      yield* dependencies.events.publish(SessionEvent.Step.Started, {
        sessionID: parentID, assistantMessageID: assistant, timestamp, agent: build, model,
      })
      yield* dependencies.events.publish(SessionEvent.Tool.Called, {
        sessionID: parentID, assistantMessageID: assistant, timestamp, callID, tool: "task",
        input: {}, provider: { executed: false },
      })
      return { assistantMessageID: assistant, toolCallID: callID }
    })
  }

  for (const context of ["fork", "fresh"] as const)
  it.live(`preserves ${context} history on follow-up and refuses an explicit context switch`, () => fixture((dependencies, input) => Effect.gen(function* () {
    yield* TaskAdmission.admit(dependencies, { ...input, workspace: "readonly", context })
    yield* SessionInput.promoteSteers(dependencies.db, dependencies.events, childID, Number.MAX_SAFE_INTEGER)
    const messages = yield* dependencies.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, childID)).all()
    const boundary = yield* publishFollowupBoundary(dependencies, `context-${context}`)
    const request = { childID, parentID, parentAgent: build, boundary, agent: worker, model, action: "task" as const,
      prompt: { id: SessionMessage.ID.create(), sessionID: childID,
        prompt: new Prompt({ text: "Continue with your own history" }), agent: worker, model, resume: false } }
    expect(yield* TaskAdmission.followup(dependencies, { ...request, context: context === "fork" ? "fresh" : "fork" }).pipe(Effect.flip))
      .toMatchObject({ reason: "input" })
    const child = yield* TaskAdmission.followup(dependencies, request)
    expect(child.agentPolicy?.taskContext).toBe(context)
    expect(SessionHostContext.render(child).includes("directly assigned native execution fork")).toBe(context === "fork")
    expect((yield* TaskAdmission.followup(dependencies, { ...request, context })).id).toBe(childID)
    expect(yield* dependencies.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, childID)).all()).toEqual(messages)
  })))

  it.live("admits a terminal main-writing follow-up with one fresh consent per scope and exact retries", () => fixture((dependencies, input) => Effect.gen(function* () {
    const consents: string[] = []
    const deps = { ...dependencies, permission: { ...dependencies.permission,
      assertSingleUse: (request: Parameters<NonNullable<PermissionV2.Interface["assertSingleUse"]>>[0]) =>
        Effect.sync(() => { consents.push(request.resources[0] ?? ""); return PermissionV2.ID.create() }) } }
    const child = yield* TaskAdmission.admit(deps, input)
    const original = child.agentPolicy?.mainWriteConsent
    if (!original) return yield* Effect.die("Missing original consent")
    const database = yield* Database.Service
    const originalBinding = { parentSessionID: parentID, sessionID: childID, messageID: original.inputID,
      dispatchDigest: original.dispatchDigest, placementIdentity: original.placementIdentity }
    expect(yield* SessionExecutionView.readMainTask(database, originalBinding)).toEqual({ phase: "admitted" })
    yield* SessionInput.promoteSteers(dependencies.db, dependencies.events, childID, Number.MAX_SAFE_INTEGER)
    const messages = yield* dependencies.db.select({ id: SessionMessageTable.id }).from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, childID)).all()
    const boundary = yield* publishFollowupBoundary(dependencies, "followup")
    const request = { childID, parentID, parentAgent: build, boundary, agent: worker, model, action: "task" as const,
      prompt: { id: SessionMessage.ID.make("msg_followup_prompt"), sessionID: childID,
        prompt: new Prompt({ text: "Second assignment" }), agent: worker, model, resume: false } }
    const updated = yield* TaskAdmission.followup(deps, request)
    const consent = updated.agentPolicy?.mainWriteConsent
    if (!consent) return yield* Effect.die("Missing follow-up consent")
    expect(yield* SessionExecutionView.readMainTask(database, originalBinding)).toEqual({ phase: "task_binding_mismatch" })
    expect(yield* SessionExecutionView.readMainTask(database, {
      ...originalBinding, messageID: consent.inputID, dispatchDigest: consent.dispatchDigest,
    })).toEqual({ phase: "admitted" })
    expect(consent?.inputID).toBe(request.prompt.id)
    expect(consent?.permissionID).not.toBe(original.permissionID)
    expect(consent?.dispatchDigest).not.toBe(original.dispatchDigest)
    expect(consents.at(-1)).toBe(`task:${childID}:followup:${request.prompt.id}`)
    expect(consents).toHaveLength(2)
    expect(yield* WorkspaceCheckout.assertSession(dependencies.db, childID)).toBe(true)
    expect((yield* dependencies.db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, childID)).all())
      .map((row) => row.id).sort()).toEqual([promptID, request.prompt.id].sort())
    expect((yield* dependencies.db.select({ id: SessionMessageTable.id }).from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, childID)).all())).toEqual(messages)
    const retried = yield* TaskAdmission.followup(deps, request)
    expect(retried.agentPolicy?.mainWriteConsent?.inputID).toBe(request.prompt.id)
    expect(consents).toHaveLength(2)
    const changed = yield* TaskAdmission.followup(deps, { ...request,
      prompt: { ...request.prompt, prompt: new Prompt({ text: "Changed assignment" }) } })
      .pipe(Effect.as("unexpected"), Effect.catchTag("TaskAdmission.Conflict", (error) => Effect.succeed(error.reason)))
    expect(changed).toBe("retry")
    // The chained scope requires the previous follow-up to have actually run.
    yield* SessionInput.promoteSteers(dependencies.db, dependencies.events, childID, Number.MAX_SAFE_INTEGER)
    const second = { ...request, prompt: { ...request.prompt, id: SessionMessage.ID.make("msg_followup_prompt_2"),
      prompt: new Prompt({ text: "Third assignment" }) } }
    const chained = yield* TaskAdmission.followup(deps, second)
    expect(chained.agentPolicy?.mainWriteConsent?.inputID).toBe(second.prompt.id)
    expect(consents).toHaveLength(3)
    expect((yield* dependencies.db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, childID)).all()))
      .toHaveLength(3)
  })))

  for (const pending of ["steer", "held-steer", "held-queue", "queue"] as const)
  for (const timing of ["before", "during-consent"] as const)
  it.live(`follow-up respects parent ${pending} ${timing}`, () => fixture((dependencies, input) => Effect.gen(function* () {
    const original = yield* TaskAdmission.admit(dependencies, input)
    yield* SessionInput.promoteSteers(dependencies.db, dependencies.events, childID, Number.MAX_SAFE_INTEGER)
    const boundary = yield* publishFollowupBoundary(dependencies, "pending-followup")
    const request = { childID, parentID, parentAgent: build, boundary, agent: worker, model, action: "task" as const,
      prompt: { id: SessionMessage.ID.create(), sessionID: childID,
        prompt: new Prompt({ text: "Follow up on the current request" }), agent: worker, model, resume: false } }
    const admit = Effect.gen(function* () {
      yield* SessionInput.admit(dependencies.db, dependencies.events, { id: SessionMessage.ID.create(), sessionID: parentID,
        prompt: new Prompt({ text: "New parent instruction" }), delivery: pending.endsWith("queue") ? "queue" : "steer" })
      if (pending.startsWith("held")) yield* SessionInput.holdPending(dependencies.db, dependencies.events, parentID)
    })
    if (timing === "before") yield* admit
    const deps = timing === "before" ? dependencies : { ...dependencies, permission: { ...dependencies.permission,
      assertSingleUse: () => admit.pipe(Effect.as(PermissionV2.ID.create())) } }
    const outcome = yield* TaskAdmission.followup(deps, request).pipe(Effect.exit)
    if (pending === "queue" && timing === "before") {
      expect(Exit.isSuccess(outcome)).toBe(true)
      return
    }
    expect(Exit.isFailure(outcome)).toBe(true)
    if (pending !== "queue") expect(yield* TaskAdmission.followup(deps, request).pipe(Effect.flip)).toMatchObject({ reason: "pending" })
    expect((yield* dependencies.store.get(childID))?.agentPolicy).toEqual(original.agentPolicy)
    expect(yield* SessionInput.find(dependencies.db, request.prompt.id)).toBeUndefined()
    expect(yield* dependencies.db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, childID)).all()).toEqual([])
  })))

  it.live("refuses follow-ups for pending inputs, running activities and foreign children", () => fixture((dependencies, input) => Effect.gen(function* () {
    yield* TaskAdmission.admit(dependencies, input)
    const boundary = yield* publishFollowupBoundary(dependencies, "followup-refused")
    const request = { childID, parentID, parentAgent: build, boundary, agent: worker, model, action: "task" as const,
      prompt: { id: SessionMessage.ID.make("msg_followup_refused"), sessionID: childID,
        prompt: new Prompt({ text: "Too early" }), agent: worker, model, resume: false } }
    const isConflict = (error: unknown): error is TaskAdmission.Conflict => error instanceof TaskAdmission.Conflict
    const reason = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.as("unexpected"),
        Effect.catchIf(isConflict, (error) => Effect.succeed(isConflict(error) ? error.reason : "unexpected")))
    expect(yield* reason(TaskAdmission.followup(dependencies, request))).toBe("child")
    yield* SessionInput.promoteSteers(dependencies.db, dependencies.events, childID, Number.MAX_SAFE_INTEGER)
    yield* dependencies.db.insert(SessionActivityTable).values({ id: "act_child", session_id: childID,
      status: "running", kind: "prompt", owner_id: "child_owner", lease_until: Date.now() + 60_000 }).run()
    expect(yield* reason(TaskAdmission.followup(dependencies, request))).toBe("child")
    yield* dependencies.db.update(SessionActivityTable).set({ status: "completed" })
      .where(eq(SessionActivityTable.id, "act_child")).run()
    const terminal = yield* TaskAdmission.followup(dependencies, request)
    expect(terminal.agentPolicy?.mainWriteConsent?.inputID).toBe(request.prompt.id)
    expect(yield* reason(TaskAdmission.followup(dependencies, { ...request, childID: parentID,
      prompt: { ...request.prompt, sessionID: parentID } }))).toBe("child")
  })))

  it.live("rebinds a terminal mirror follow-up in place without Main consent or a second mirror", () => fixture((dependencies, input) => Effect.gen(function* () {
    const source = input.create.location.directory
    yield* Effect.promise(async () => {
      await fs.writeFile(path.join(source, "tracked.txt"), "committed\n")
      for (const args of [["add", "--", "tracked.txt"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]]) {
        const process = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
          cwd: source, stdout: "ignore", stderr: "pipe",
          env: { ...Object.fromEntries(Object.entries(globalThis.process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
            GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
        })
        const error = await new Response(process.stderr).text()
        if (await process.exited !== 0) throw new Error(error)
      }
      await fs.writeFile(path.join(source, "tracked.txt"), "dirty source\n")
    })
    const deps = { ...dependencies, mirrorRoot: path.join(source, "..", "mirrors"),
      permission: { ...dependencies.permission, assertSingleUse: () => Effect.die("Mirror follow-up must not request Main consent") } }
    const child = yield* TaskAdmission.admit(deps, { ...input, workspace: undefined })
    const mirror = child.agentPolicy?.mirrorWorkspace
    if (!mirror) return yield* Effect.die("Missing mirror binding")
    yield* SessionInput.promoteSteers(dependencies.db, dependencies.events, childID, Number.MAX_SAFE_INTEGER)
    const boundary = yield* publishFollowupBoundary(dependencies, "followup-mirror")
    const request = { childID, parentID, parentAgent: build, boundary, agent: worker, model, action: "task" as const,
      prompt: { id: SessionMessage.ID.make("msg_followup_mirror"), sessionID: childID,
        prompt: new Prompt({ text: "Continue in the mirror" }), agent: worker, model, resume: false } }
    const updated = yield* TaskAdmission.followup(deps, request)
    const rebound = updated.agentPolicy?.mirrorWorkspace
    expect(rebound?.inputID).toBe(request.prompt.id)
    expect(rebound?.dispatchDigest).not.toBe(mirror.dispatchDigest)
    expect(rebound?.taskID).toBe(mirror.taskID)
    expect(rebound?.basis).toEqual(mirror.basis)
    expect(rebound?.basisDigest).toBe(mirror.basisDigest)
    expect(rebound?.directory).toBe(mirror.directory)
    expect(updated.location).toEqual(child.location)
    expect(yield* mirrorsIn(deps.mirrorRoot)).toHaveLength(1)
    expect(yield* WorkspaceCheckout.assertSession(dependencies.db, childID)).toBe(true)
    const retried = yield* TaskAdmission.followup(deps, request)
    expect(retried.agentPolicy?.mirrorWorkspace?.inputID).toBe(request.prompt.id)
    expect(yield* mirrorsIn(deps.mirrorRoot)).toHaveLength(1)
  }), true))

  it.live("rebinds a terminal readonly follow-up and keeps the read ceiling", () => fixture((dependencies, input) => Effect.gen(function* () {
    const deps = { ...dependencies, permission: { ...dependencies.permission,
      assertSingleUse: () => Effect.die("Readonly follow-up must not request a Main writing exception") } }
    const child = yield* TaskAdmission.admit(deps, { ...input, workspace: "readonly" })
    yield* SessionInput.promoteSteers(dependencies.db, dependencies.events, childID, Number.MAX_SAFE_INTEGER)
    const boundary = yield* publishFollowupBoundary(dependencies, "followup-readonly")
    const request = { childID, parentID, parentAgent: build, boundary, agent: worker, model, action: "task" as const,
      prompt: { id: SessionMessage.ID.make("msg_followup_readonly"), sessionID: childID,
        prompt: new Prompt({ text: "Read more" }), agent: worker, model, resume: false } }
    const updated = yield* TaskAdmission.followup(deps, request)
    expect(SessionAgentPolicy.isReadOnly(updated.agentPolicy)).toBe(true)
    expect(updated.agentPolicy?.readOnlyInputID).toBe(request.prompt.id)
    expect(updated.agentPolicy?.mainWriteConsent).toBeUndefined()
    expect(yield* WorkspaceCheckout.assertSession(dependencies.db, childID)).toBe(true)
  })))

  it.live("enforces binding delegation rules before requesting a Main exception", () => fixture((dependencies, input) => Effect.gen(function* () {
    const reason = yield* TaskAdmission.admit({ ...dependencies,
      delegationLayers: () => Effect.succeed([{ scope: "global", source: "global config", value: { rules: [{ allowed: [{ agent: "different-worker" }] }] } }]),
      permission: { ...dependencies.permission, assertSingleUse: () => Effect.die("Disallowed selection must not request consent") },
    }, input).pipe(Effect.as("unexpected"), Effect.catchTag("TaskDispatchPolicy.DelegationDenied", (error) => Effect.succeed(error.reason)))
    expect(reason).toBe("selection")
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
  })))
  it.live("requires explicit topics when thematic hard rules exist and preserves advice as advice", () => fixture((dependencies, input) => Effect.gen(function* () {
    const guarded = { ...dependencies, delegationLayers: () => Effect.succeed([{ scope: "project" as const, value: {
      rules: [{ topic: "code", allowed: [{ agent: worker }] }],
      preferences: [{ topic: "code", selections: [{ agent: "preferred-but-not-allowed" }] }],
    } }]) }
    const reason = yield* TaskAdmission.admit(guarded, input).pipe(Effect.as("unexpected"),
      Effect.catchTag("TaskDispatchPolicy.DelegationDenied", (error) => Effect.succeed(error.reason)))
    expect(reason).toBe("topics")
    const child = yield* TaskAdmission.admit(guarded, { ...input, topics: ["code"] })
    expect(child.agent).toBe(worker)
  })))
  it.live("rechecks saved Session delegation rules after host approval without leaving a child", () => fixture((dependencies, input) => Effect.gen(function* () {
    const permission = { ...dependencies.permission, assertSingleUse: () => Effect.gen(function* () {
      yield* dependencies.db.update(SessionTable).set({ metadata: { [DelegationPreferences.METADATA_KEY]: {
        version: 1, revision: 1, session: { rules: [{ allowed: [{ agent: "different-worker" }] }] }, tasks: {},
      } } }).where(eq(SessionTable.id, parentID)).run().pipe(Effect.orDie)
      return PermissionV2.ID.create()
    }) }
    const reason = yield* TaskAdmission.admit({ ...dependencies, permission }, input).pipe(Effect.as("unexpected"),
      Effect.catchTag("TaskDispatchPolicy.DelegationDenied", (error) => Effect.succeed(error.reason)))
    expect(reason).toBe("selection")
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* SessionInput.find(dependencies.db, promptID)).toBeUndefined()
  })))
  it.live("binds one native single-use Main consent to this exact dispatch and reuses only its exact retry", () => fixture((dependencies, input) => Effect.gen(function* () {
    const requests: PermissionV2.AssertInput[] = []
    const guarded = { ...dependencies, permission: { ...dependencies.permission, assertSingleUse: (request: PermissionV2.AssertInput) => Effect.sync(() => { requests.push(request); return request.id ?? PermissionV2.ID.create() }) } }
    const child = yield* TaskAdmission.admit(guarded, input)
    const request = requests[0]
    expect(requests).toHaveLength(1)
    expect(request?.metadata?.[PermissionV2.SINGLE_USE_METADATA_KEY]).toBe(true)
    expect(request?.save).toBeUndefined()
    expect(request?.action).toBe("task_main_write")
    expect(request?.source).toEqual({ type: "tool", messageID: assistantMessageID, callID: "dispatch" })
    expect(child.agentPolicy?.mainWriteConsent?.permissionID).toBe(request?.id)
    expect(child.agentPolicy?.mainWriteConsent?.placementIdentity).toBe(child.agentPolicy?.executionPlacement?.identity)
    const retry = yield* TaskAdmission.admit(guarded, input)
    expect(retry.agentPolicy?.mainWriteConsent).toEqual(child.agentPolicy?.mainWriteConsent)
    expect(requests).toHaveLength(1)
    const changed = { ...input, prompt: { ...input.prompt, prompt: new Prompt({ text: "Different scope" }) } }
    expect(Exit.isFailure(yield* Effect.exit(TaskAdmission.admit(guarded, changed)))).toBe(true)
    expect(requests).toHaveLength(1)
  })))
  it.live("refuses declined Main consent without a child or first input", () => fixture((dependencies, input) => Effect.gen(function* () {
    const result = yield* Effect.exit(TaskAdmission.admit({ ...dependencies,
      permission: { ...dependencies.permission, assertSingleUse: () => Effect.fail(new PermissionV2.RejectedError()) } }, input))
    expect(Exit.isFailure(result)).toBe(true)
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* SessionInput.find(dependencies.db, promptID)).toBeUndefined()
  })))
  it.live("fails closed when the Permission owner lacks native receipt support", () => fixture((dependencies, input) => Effect.gen(function* () {
    const reason = yield* TaskAdmission.admit({ ...dependencies, permission: {
      ...dependencies.permission, assertSingleUse: undefined,
      assert: () => Effect.die("General permission allow must not replace a Main receipt"),
    } }, input).pipe(Effect.as("unexpected success"), Effect.catchTag("TaskAdmission.Conflict", (error) => Effect.succeed(error.reason)))
    expect(reason).toBe("consent")
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* SessionInput.find(dependencies.db, promptID)).toBeUndefined()
  })))
  it.live("rechecks the original owner after the host approval await", () => fixture((dependencies, input) => Effect.gen(function* () {
    const permission = { ...dependencies.permission, assertSingleUse: () => Effect.gen(function* () {
      yield* dependencies.db.update(SessionActivityTable).set({ owner_id: "different-owner" }).where(eq(SessionActivityTable.session_id, parentID)).run().pipe(Effect.orDie)
      return PermissionV2.ID.create()
    }) }
    expect(Exit.isFailure(yield* Effect.exit(TaskAdmission.admit({ ...dependencies, permission }, input)))).toBe(true)
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* SessionInput.find(dependencies.db, promptID)).toBeUndefined()
  })))
  it.live("refuses a later assignment under the original Main consent but preserves an exact retry", () => fixture((dependencies, input) => Effect.gen(function* () {
    yield* TaskAdmission.admit(dependencies, input)
    const original = yield* SessionInput.find(dependencies.db, promptID)
    if (!original) return yield* Effect.die("Missing admitted task")
    const exact = { id: promptID, sessionID: childID, prompt: original.prompt, delivery: original.delivery }
    expect(yield* SessionInput.admit(dependencies.db, dependencies.events, exact)).toEqual(original)
    const laterID = SessionMessage.ID.make("msg_later_assignment")
    expect(Exit.isFailure(yield* Effect.exit(SessionInput.admit(dependencies.db, dependencies.events,
      { ...exact, id: laterID, prompt: new Prompt({ text: "Expand the Main assignment" }) })))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(SessionInput.admit(dependencies.db, dependencies.events,
      { ...exact, prompt: new Prompt({ text: "Replace the Main assignment" }) })))).toBe(true)
    expect(yield* SessionInput.find(dependencies.db, laterID)).toBeUndefined()
    expect(yield* SessionInput.find(dependencies.db, promptID)).toEqual(original)
    let wakes = 0
    const refused = yield* SessionV2.admitPrompt({ ...dependencies, wake: () => Effect.sync(() => { wakes++ }) }, {
      id: laterID, sessionID: childID, prompt: new Prompt({ text: "A later transport input" }),
    }).pipe(Effect.as("unexpected success"), Effect.catchTag("Session.PromptConflictError", () => Effect.succeed("conflict")))
    expect(refused).toBe("conflict")
    expect(wakes).toBe(0)
    yield* SessionInput.holdPending(dependencies.db, dependencies.events, childID)
    expect(Exit.isFailure(yield* Effect.exit(SessionInput.release(dependencies.db, dependencies.events, {
      id: promptID, sessionID: childID, prompt: new Prompt({ text: "Changed held assignment" }),
    })))).toBe(true)
    expect((yield* SessionInput.held(dependencies.db, childID))).toHaveLength(1)
  })))
  it.live("refuses execution when the persisted Main consent no longer binds its task", () => fixture((dependencies, input) => Effect.gen(function* () {
    const child = yield* TaskAdmission.admit(dependencies, input)
    if (!child.agentPolicy?.mainWriteConsent) return yield* Effect.die("Missing native Main consent")
    yield* dependencies.db.update(SessionTable).set({ agent_policy: { ...child.agentPolicy,
      mainWriteConsent: { ...child.agentPolicy.mainWriteConsent, dispatchDigest: "a".repeat(64) } } }).where(eq(SessionTable.id, childID)).run()
    expect(Exit.isFailure(yield* Effect.exit(WorkspaceCheckout.assertSession(dependencies.db, childID)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(TaskAdmission.admit(dependencies, input)))).toBe(true)
  })))
  it.live("refuses execution after the Main consent input reference is replaced", () => fixture((dependencies, input) => Effect.gen(function* () {
    const child = yield* TaskAdmission.admit(dependencies, input)
    if (!child.agentPolicy?.mainWriteConsent) return yield* Effect.die("Missing native Main consent")
    yield* dependencies.db.update(SessionTable).set({ agent_policy: { ...child.agentPolicy,
      mainWriteConsent: { ...child.agentPolicy.mainWriteConsent, inputID: "msg_foreign" } } }).where(eq(SessionTable.id, childID)).run()
    expect(Exit.isFailure(yield* Effect.exit(WorkspaceCheckout.assertSession(dependencies.db, childID)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(TaskAdmission.admit(dependencies, input)))).toBe(true)
  })))
  it.live("refuses a model selected before agent model policy changed", () => fixture((dependencies, input) => Effect.gen(function* () {
    yield* dependencies.agents.update((editor) => editor.update(worker, (agent) => {
      agent.model = { ...model, id: ModelV2.ID.make("new-default"), variant: ModelV2.VariantID.make("new-variant") }
    }))
    const reason = yield* TaskAdmission.admit(dependencies, input).pipe(Effect.as("unexpected success"),
      Effect.catchTag("TaskDispatchPolicy.Changed", (error) => Effect.succeed(error._tag)))
    expect(reason).toBe("TaskDispatchPolicy.Changed")
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
  })))
  it.live("rolls back a reviewer removed from current workflow policy during import", () => fixture((dependencies, input) => Effect.gen(function* () {
    let approved = true
    const selected = { ...model, id: ModelV2.ID.make("configured-reviewer"), variant: ModelV2.VariantID.make("high") }
    yield* dependencies.events.beforeCommit((event) => Effect.sync(() => {
      if (event.type === "session.next.fork.history-boundary-imported") approved = false
    }))
    const reason = yield* TaskAdmission.admit({ ...dependencies, workflowModels: () => Effect.sync(() => approved ? [selected] : []) }, {
      ...input, create: { ...input.create, model: selected }, prompt: { ...input.prompt, model: selected },
      modelSelection: { requested: `${selected.providerID}/${selected.id}`, variant: selected.variant, workflow: "review" },
    }).pipe(Effect.as("unexpected success"), Effect.catchTag("TaskDispatchPolicy.Changed", (error) => Effect.succeed(error._tag)))
    expect(reason).toBe("TaskDispatchPolicy.Changed")
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* SessionInput.find(dependencies.db, promptID)).toBeUndefined()
  })))
  it.live("rolls back a checkout alias retargeted by an import hook", () => fixture((dependencies, input) => Effect.gen(function* () {
    const directory = input.create.location.directory
    yield* dependencies.events.beforeCommit((event) => event.type !== "session.next.fork.history-boundary-imported"
      ? Effect.void : Effect.promise(async () => {
        await fs.unlink(directory)
        await fs.symlink(path.join(path.dirname(directory), "second"), directory, process.platform === "win32" ? "junction" : "dir")
      }))
    expect(Exit.isFailure(yield* Effect.exit(TaskAdmission.admit(dependencies, input)))).toBe(true)
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* SessionInput.find(dependencies.db, promptID)).toBeUndefined()
  }), true))
  it.live("refuses execution after the persisted checkout alias changes", () => fixture((dependencies, input) => Effect.gen(function* () {
    const child = yield* TaskAdmission.admit(dependencies, input)
    expect(child.agentPolicy?.executionPlacement?.directory).toBe(input.create.location.directory)
    expect(yield* WorkspaceCheckout.assertSession(dependencies.db, childID)).toBe(true)
    yield* Effect.promise(async () => {
      const directory = input.create.location.directory
      await fs.unlink(directory)
      await fs.symlink(path.join(path.dirname(directory), "second"), directory, process.platform === "win32" ? "junction" : "dir")
    })
    const reason = yield* WorkspaceCheckout.assertSession(dependencies.db, childID).pipe(Effect.as("unexpected success"),
      Effect.catchTag("WorkspaceCheckout.Blocked", (error) => Effect.succeed(error._tag)))
    expect(reason).toBe("WorkspaceCheckout.Blocked")
  }), true))
  it.live("accepts the same Windows task directory with persisted slash and case differences", () => fixture((dependencies, input) => Effect.gen(function* () {
    if (process.platform !== "win32") return
    yield* TaskAdmission.admit(dependencies, input)
    const alias = input.create.location.directory.replaceAll("\\", "/").toLowerCase()
    yield* dependencies.db.update(SessionTable).set({ directory: alias }).where(eq(SessionTable.id, childID)).run()
    expect(yield* WorkspaceCheckout.assertSession(dependencies.db, childID)).toBe(true)
    yield* dependencies.db.update(SessionTable).set({ directory: `${alias}-other` }).where(eq(SessionTable.id, childID)).run()
    const reason = yield* WorkspaceCheckout.assertSession(dependencies.db, childID).pipe(Effect.as("unexpected success"),
      Effect.catchTag("WorkspaceCheckout.Blocked", (error) => Effect.succeed(error._tag)))
    expect(reason).toBe("WorkspaceCheckout.Blocked")
  })))
  it.live("refuses a native dispatch whose persisted execution placement is missing", () => fixture((dependencies, input) => Effect.gen(function* () {
    const child = yield* TaskAdmission.admit(dependencies, input)
    if (!child.agentPolicy) return yield* Effect.die("Missing native child policy")
    const { executionPlacement: _, ...policy } = child.agentPolicy
    yield* dependencies.db.update(SessionTable).set({ agent_policy: policy }).where(eq(SessionTable.id, childID)).run()
    const reason = yield* WorkspaceCheckout.assertSession(dependencies.db, childID).pipe(Effect.as("unexpected success"),
      Effect.catchTag("WorkspaceCheckout.Blocked", (error) => Effect.succeed(error._tag)))
    expect(reason).toBe("WorkspaceCheckout.Blocked")
    expect(yield* WorkspaceCheckout.assertSession(dependencies.db, parentID)).toBe(false)
  })))
  it.live("imports, admits and reconciles the exact retry once", () => fixture((dependencies, input) => Effect.gen(function* () {
    const child = yield* TaskAdmission.admit(dependencies, input)
    expect(child.agent).toBe(worker)
    expect((yield* dependencies.store.context(childID)).map((message) => message.type)).toEqual(["user"])
    const first = yield* SessionInput.find(dependencies.db, promptID)
    expect(first?.prompt.text).toBe("Child assignment")
    const retried = yield* TaskAdmission.admit(dependencies, input)
    expect(retried.id).toBe(child.id)
    expect(yield* SessionInput.find(dependencies.db, promptID)).toEqual(first)
    const changed = { ...input, prompt: { ...input.prompt, prompt: new Prompt({ text: "Different task" }) } }
    expect(Exit.isFailure(yield* Effect.exit(TaskAdmission.admit(dependencies, changed)))).toBe(true)
    expect(yield* SessionInput.find(dependencies.db, promptID)).toEqual(first)
  })))
  it.live("retains the native dispatch binding and admitted prompt through checkpoint replay", () => fixture((dependencies, input) => Effect.gen(function* () {
    yield* TaskAdmission.admit(dependencies, input)
    const before = yield* dependencies.db.select().from(SessionTable).where(eq(SessionTable.id, childID)).get()
    expect(before?.fork_dispatch_digest).toMatch(/^[a-f0-9]{64}$/)
    expect(before?.metadata).not.toHaveProperty("task_dispatch")
    const checkpoint = yield* dependencies.events.createCheckpoint(childID)
    if (!checkpoint) return yield* Effect.die("Missing task checkpoint")
    yield* dependencies.db.delete(SessionTable).where(eq(SessionTable.id, childID)).run()
    yield* dependencies.events.remove(childID)
    yield* dependencies.events.replayCheckpoint(checkpoint)
    const after = yield* dependencies.db.select().from(SessionTable).where(eq(SessionTable.id, childID)).get()
    expect(after?.fork_dispatch_digest).toBe(before?.fork_dispatch_digest)
    expect(after?.agent_policy?.executionPlacement).toEqual(before?.agent_policy?.executionPlacement)
    expect(yield* WorkspaceCheckout.assertSession(dependencies.db, childID)).toBe(true)
    expect((yield* TaskAdmission.admit(dependencies, input)).id).toBe(childID)
    expect((yield* SessionInput.find(dependencies.db, promptID))?.prompt.text).toBe("Child assignment")
  })))
  for (const count of [1, 130]) it.live(`reconciles a retry across ${count} persisted same-assistant progress events`, () => fixture((dependencies, input) => Effect.gen(function* () {
    yield* TaskAdmission.admit(dependencies, input)
    for (let index = 0; index < count; index++)
      yield* dependencies.events.publish(SessionEvent.Tool.Progress, { sessionID: parentID, assistantMessageID,
        timestamp: DateTime.makeUnsafe(Date.now()), callID: "dispatch", content: [], structured: { sessionID: childID } })
    expect((yield* TaskAdmission.admit(dependencies, input)).id).toBe(childID)
  })))
  it.live("refuses retry across progress outside the original source assistant", () => fixture((dependencies, input) => Effect.gen(function* () {
    yield* TaskAdmission.admit(dependencies, input)
    yield* dependencies.events.publish(SessionEvent.Tool.Progress, { sessionID: parentID,
      assistantMessageID: SessionMessage.ID.make("msg_foreign_progress"), timestamp: DateTime.makeUnsafe(Date.now()),
      callID: "foreign", content: [], structured: { unrelated: true } })
    expect(Exit.isFailure(yield* Effect.exit(TaskAdmission.admit(dependencies, input)))).toBe(true)
  })))
  it.live("binds original attachment content across exact retries", () => fixture((dependencies, input) => Effect.gen(function* () {
    const attachment = yield* dependencies.content.storeAttachment({ sessionID: parentID, key: "retry-file",
      bytes: new TextEncoder().encode("original evidence"), mime: "text/plain" })
    const user = yield* dependencies.db.select().from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_parent_user"))).get()
    if (!user) return yield* Effect.die("Missing parent evidence")
    const data = { ...user.data, text: `Parent evidence ${attachment.uri}` }
    yield* dependencies.db.update(SessionMessageTable).set({ data })
      .where(eq(SessionMessageTable.id, user.id)).run()
    yield* dependencies.db.update(SessionInputTable).set({ prompt: { text: data.text } })
      .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_parent_user"))).run()
    yield* TaskAdmission.admit(dependencies, input)
    const changed = yield* dependencies.content.putBlob({ bytes: new TextEncoder().encode("replaced evidence"), mime: "text/plain" })
    yield* dependencies.db.update(AttachmentTable).set({ blob_sha256: changed.sha256 })
      .where(eq(AttachmentTable.id, attachment.uri.slice("attachment://".length))).run()
    expect(Exit.isFailure(yield* Effect.exit(TaskAdmission.admit(dependencies, input)))).toBe(true)
    expect((yield* dependencies.content.resolve({ sessionID: childID, uri: attachment.uri }))?.bytes)
      .toEqual(new TextEncoder().encode("original evidence"))
  })))
  for (const drift of ["system", "epoch", "owner", "pending"] as const)
    it.live(`refuses a correlated retry after original ${drift} evidence changes`, () => fixture((dependencies, input) => Effect.gen(function* () {
      yield* TaskAdmission.admit(dependencies, input)
      if (drift === "system")
        yield* dependencies.agents.update((editor) => editor.update(worker, (agent) => { agent.system = "Changed worker identity" }))
      if (drift === "epoch")
        yield* dependencies.db.update(SessionContextEpochTable).set({ baseline: "Changed original epoch" })
          .where(eq(SessionContextEpochTable.session_id, parentID)).run()
      if (drift === "owner")
        yield* dependencies.db.update(SessionActivityTable).set({ owner_id: "new_owner" })
          .where(eq(SessionActivityTable.id, "act_fixture")).run()
      if (drift === "pending")
        yield* SessionInput.admit(dependencies.db, dependencies.events, { id: SessionMessage.ID.make("msg_retry_pending"),
          sessionID: parentID, prompt: new Prompt({ text: "New instruction" }), delivery: "steer" })
      const retry = TaskAdmission.admit(dependencies, input)
      const result = yield* Effect.exit(drift === "owner"
        ? SessionExecutionOwner.withOwner({ sessionID: parentID, activityID: "act_fixture", ownerID: "new_owner" }, retry)
        : retry)
      expect(Exit.isFailure(result)).toBe(true)
      expect((yield* SessionInput.find(dependencies.db, promptID))?.prompt.text).toBe("Child assignment")
    })))
  it.live("rolls child, import and input back when the enclosing atomic operation fails", () => fixture((dependencies, input) => Effect.gen(function* () {
    const remove = yield* dependencies.events.listen(() => Effect.void)
    yield* Effect.addFinalizer(() => remove)
    const result = yield* Effect.exit(EventV2.atomic(dependencies.db, Effect.gen(function* () {
      yield* TaskAdmission.admit(dependencies, input)
      return yield* Effect.fail("outer rollback")
    })))
    expect(Exit.isFailure(result)).toBe(true)
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* SessionInput.find(dependencies.db, promptID)).toBeUndefined()
  })))
  it.live("reconciles simultaneous preparations into one child and input", () => fixture((dependencies, input) => Effect.gen(function* () {
    const children = yield* Effect.all([TaskAdmission.admit(dependencies, input), TaskAdmission.admit(dependencies, input)], { concurrency: 2 })
    expect(children.map((child) => child.id)).toEqual([childID, childID])
    expect((yield* dependencies.store.context(childID))).toHaveLength(1)
    expect((yield* SessionInput.find(dependencies.db, promptID))?.prompt.text).toBe("Child assignment")
  })))
  for (const drift of ["owner", "policy"] as const)
    it.live(`rolls back a ${drift} change during awaited import`, () => fixture((dependencies, input) => Effect.gen(function* () {
      const update = yield* dependencies.agents.transform()
      yield* dependencies.events.beforeCommit((event) => Effect.gen(function* () {
        if (event.type !== "session.next.fork.history-boundary-imported") return
        if (drift === "owner")
          yield* dependencies.db.update(SessionActivityTable).set({ owner_id: "foreign" }).where(eq(SessionActivityTable.id, "act_fixture")).run().pipe(Effect.orDie)
        if (drift === "policy")
          yield* update((editor) => editor.update(worker, (agent) => { agent.system = "changed during import" }))
      }))
      expect(Exit.isFailure(yield* Effect.exit(TaskAdmission.admit(dependencies, input)))).toBe(true)
      expect(yield* dependencies.store.get(childID)).toBeUndefined()
      expect(yield* SessionInput.find(dependencies.db, promptID)).toBeUndefined()
    })))
  it.live("refuses a lost owner without leaving a child", () => fixture((dependencies, input) => Effect.gen(function* () {
    yield* dependencies.db.update(SessionActivityTable).set({ owner_id: "foreign" }).where(eq(SessionActivityTable.id, "act_fixture")).run()
    expect(Exit.isFailure(yield* Effect.exit(TaskAdmission.admit(dependencies, input)))).toBe(true)
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* SessionInput.find(dependencies.db, promptID)).toBeUndefined()
  })))
  it.live("types each checkout refusal with its construction-site reason and message", () => fixture((dependencies, input) => Effect.gen(function* () {
    const child = yield* TaskAdmission.admit(dependencies, input)
    const policy = child.agentPolicy
    if (!policy?.mainWriteConsent || !policy.executionPlacement) return yield* Effect.die("Missing Main consent or placement")
    const corrupt = (patch: Record<string, unknown>) => dependencies.db.update(SessionTable)
      .set({ agent_policy: { ...policy, ...patch } }).where(eq(SessionTable.id, childID)).run().pipe(Effect.orDie)
    const outcome = <A, E>(effect: Effect.Effect<A, E>) => Effect.gen(function* () {
      const exit = yield* Effect.exit(effect)
      if (Exit.isSuccess(exit)) return "unexpected success"
      const error = Cause.prettyErrors(exit.cause)[0] as { _tag?: string; reason?: string; message?: string }
      if (error?._tag === "WorkspaceCheckout.Blocked") return `${error.reason}|${error.message}`
      return `other failure: ${String(error?._tag ?? "unknown")}`
    })

    yield* corrupt({ mainWriteConsent: { ...policy.mainWriteConsent, dispatchDigest: "a".repeat(64) } })
    expect(yield* outcome(WorkspaceCheckout.assertSession(dependencies.db, childID)))
      .toBe("policy_mismatch|The task's policy or consent binding no longer matches this execution")
    yield* corrupt({ mainWriteConsent: policy.mainWriteConsent })

    // A pending steer injected directly into the ledger invalidates the bound
    // assignment at the next check; dispatch children refuse transport admits.
    const steerID = SessionMessage.ID.create()
    const steerSeq = (yield* SessionInput.latestSeq(dependencies.db, childID)) + 1
    yield* dependencies.db.insert(SessionInputTable).values({
      id: steerID, session_id: childID,
      prompt: { text: "Unrelated pending course correction" } as typeof Prompt.Encoded,
      delivery: "steer", admitted_seq: steerSeq,
    }).onConflictDoUpdate({ target: SessionInputTable.id, set: { admitted_seq: steerSeq } }).run().pipe(Effect.orDie)
    expect(yield* outcome(WorkspaceCheckout.assertSession(dependencies.db, childID)))
      .toBe("input_boundary|A pending session input invalidates this task assignment")
    yield* dependencies.db.delete(SessionInputTable).where(eq(SessionInputTable.id, steerID)).run().pipe(Effect.orDie)

    expect(yield* outcome(WorkspaceCheckout.assertRunner(dependencies.db, childID))).toBe("owner_lost|The task's execution owner is no longer active")

    const childActivity = "act_child_write_owner"
    yield* dependencies.db.insert(SessionActivityTable).values({
      id: childActivity, session_id: childID, status: "running", kind: "prompt",
      owner_id: "owner_child_write", lease_until: Date.now() + 60_000,
    }).onConflictDoNothing().run().pipe(Effect.orDie)
    const withOwner = <A, E>(effect: Effect.Effect<A, E>) =>
      SessionExecutionOwner.withOwner({ sessionID: childID, activityID: childActivity, ownerID: "owner_child_write" }, effect)
    expect(yield* withOwner(outcome(WorkspaceCheckout.assertWrite(dependencies.db, childID, undefined)))).toBe("no_target|The write target or checkout root is missing")
    expect(yield* withOwner(outcome(WorkspaceCheckout.assertWrite(dependencies.db, childID,
      path.join(path.dirname(path.dirname(child.location.directory)), "outside-escape.md")))))
      .toBe("outside_checkout|The write target is outside the task checkout")

    // Native dispatch children are managed writers: the guarded mutation fence
    // may re-run the final ownership check before commit. A plain parent
    // session without legacy claims stays unmanaged.
    const managed = yield* withOwner(LegacyDelegationGuard.assertFileWrite(
      { db: dependencies.db }, childID, child.location.directory))
    expect(managed).toBe(true)
    const unmanaged = yield* SessionExecutionOwner.withOwner({ sessionID: parentID, activityID: "act_fixture", ownerID: "owner_fixture" },
      LegacyDelegationGuard.assertFileWrite({ db: dependencies.db }, parentID, input.create.location.directory))
    expect(unmanaged).toBe(false)
  })))
  it.live("rolls back owner loss during the final awaited policy observation", () => fixture((dependencies, input) => Effect.gen(function* () {
    const policySnapshot = dependencies.permission.policySnapshot
    if (!policySnapshot) return yield* Effect.die("Missing fixture policy snapshot")
    let observations = 0
    const permission = { ...dependencies.permission, policySnapshot: (request: Parameters<typeof policySnapshot>[0]) =>
      Effect.gen(function* () {
        observations++
        const snapshot = yield* policySnapshot(request)
        if (observations === 3)
          yield* dependencies.db.update(SessionActivityTable).set({ owner_id: "foreign" })
            .where(eq(SessionActivityTable.id, "act_fixture")).run().pipe(Effect.orDie)
        return snapshot
      }) }
    const reason = yield* TaskAdmission.admit({ ...dependencies, permission }, input).pipe(
      Effect.as("unexpected success"),
      Effect.catchTag("SessionExecutionOwner.Lost", (error) => Effect.succeed(error._tag)),
    )
    expect(reason).toBe("SessionExecutionOwner.Lost")
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* SessionInput.find(dependencies.db, promptID)).toBeUndefined()
  })))
  it.live("admits a dispatch whose session access-control mode changed during admission", () => fixture((dependencies, input) => Effect.gen(function* () {
    const policySnapshot = dependencies.permission.policySnapshot
    if (!policySnapshot) return yield* Effect.die("Missing fixture policy snapshot")
    let observations = 0
    // The composer writes the session's approval mode concurrently with an
    // in-flight admission; that volatile UI state must not refuse the dispatch.
    const permission = { ...dependencies.permission, policySnapshot: (request: Parameters<typeof policySnapshot>[0]) =>
      Effect.map(policySnapshot(request), (snapshot) => (++observations === 1 ? snapshot
        : { ...snapshot, accessControl: { mode: "approve_for_me" as const } })) }
    const child = yield* TaskAdmission.admit({ ...dependencies, permission }, input)
    expect(child.agentPolicy?.source.type).toBe("task")
  })))
  it.live("refuses a dispatch whose configured task permission changed during admission", () => fixture((dependencies, input) => Effect.gen(function* () {
    const policySnapshot = dependencies.permission.policySnapshot
    if (!policySnapshot) return yield* Effect.die("Missing fixture policy snapshot")
    let observations = 0
    const permission = { ...dependencies.permission, policySnapshot: (request: Parameters<typeof policySnapshot>[0]) =>
      Effect.map(policySnapshot(request), (snapshot) => (++observations === 1 ? snapshot
        : { ...snapshot, configured: [{ action: "task", resource: "*", effect: "deny" as const }] })) }
    const reason = yield* TaskAdmission.admit({ ...dependencies, permission }, input).pipe(
      Effect.as("unexpected success"),
      Effect.catchTag("TaskDispatchPolicy.Changed", (error) => Effect.succeed(error._tag)),
    )
    expect(reason).toBe("TaskDispatchPolicy.Changed")
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* SessionInput.find(dependencies.db, promptID)).toBeUndefined()
  })))
  it.live("admits a dispatch whose parent published benign title state during admission", () => fixture((dependencies, input) => Effect.gen(function* () {
    const policySnapshot = dependencies.permission.policySnapshot
    if (!policySnapshot) return yield* Effect.die("Missing fixture policy snapshot")
    let observations = 0
    // Concurrent title generation appends parent-side session events while an
    // admission is in flight; those appends must not refuse the dispatch.
    const permission = { ...dependencies.permission, policySnapshot: (request: Parameters<typeof policySnapshot>[0]) =>
      Effect.gen(function* () {
        const snapshot = yield* policySnapshot(request)
        if (++observations >= 2)
          yield* dependencies.events.publish(SessionEvent.TitleUpdated, {
            sessionID: parentID, timestamp: yield* DateTime.now, title: "Fixture benign title",
          })
        return snapshot
      }) }
    const child = yield* TaskAdmission.admit({ ...dependencies, permission }, input)
    expect(child.agentPolicy?.source.type).toBe("task")
  })))
  it.live("refuses an inherited native owner after its scope has settled", () => fixture((dependencies, input) => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const inherited = yield* SessionExecutionOwner.withOwner(
      { sessionID: parentID, activityID: "act_fixture", ownerID: "owner_fixture" },
      Deferred.await(gate).pipe(Effect.andThen(TaskAdmission.admit(dependencies, input)), Effect.exit, Effect.forkScoped),
    )
    yield* Deferred.succeed(gate, undefined)
    expect(Exit.isFailure(yield* Fiber.join(inherited))).toBe(true)
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
  })))
  it.live("rolls back interrupted import without publishing a child or its first input", () => fixture((dependencies, input) => Effect.gen(function* () {
    const reached = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* dependencies.events.beforeCommit((event) => event.type !== "session.next.fork.history-boundary-imported"
      ? Effect.void
      : Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release))))
    const admission = yield* TaskAdmission.admit(dependencies, input).pipe(Effect.forkScoped)
    yield* Deferred.await(reached)
    yield* Fiber.interrupt(admission)
    const exit = yield* Fiber.await(admission)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* SessionInput.find(dependencies.db, promptID)).toBeUndefined()
  })))
  for (const change of [{ status: "interrupted" }, { closed_seq: 1 }, { lease_until: 0 }])
    it.live(`refuses an inactive parent (${JSON.stringify(change)})`, () => fixture((dependencies, input) => Effect.gen(function* () {
      yield* dependencies.db.update(SessionActivityTable).set(change).where(eq(SessionActivityTable.id, "act_fixture")).run()
      expect(Exit.isFailure(yield* Effect.exit(TaskAdmission.admit(dependencies, input)))).toBe(true)
      expect(yield* dependencies.store.get(childID)).toBeUndefined()
    })))
  it.live("refuses parent context changing after history import and before prompt admission", () => fixture((dependencies, input) => Effect.gen(function* () {
    yield* dependencies.events.beforeCommit((event) => event.type !== "session.next.fork.history-boundary-imported"
      ? Effect.void
      : dependencies.db.update(SessionContextEpochTable).set({ baseline: "New parent context after import" })
          .where(eq(SessionContextEpochTable.session_id, parentID)).run().pipe(Effect.orDie, Effect.asVoid))
    const reason = yield* TaskAdmission.admit(dependencies, input).pipe(
      Effect.as("unexpected success"),
      Effect.catchTag("SessionForkImport.Conflict", (error) => Effect.succeed(error.reason)),
    )
    expect(reason).toBe("changed")
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* SessionInput.find(dependencies.db, promptID)).toBeUndefined()
  })))
  it.live("refuses newly pending parent input after import, not just a changed event sequence", () => fixture((dependencies, input) => Effect.gen(function* () {
    const original = yield* dependencies.db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, parentID)).get()
    if (!original) return yield* Effect.die("Missing parent input fixture")
    yield* dependencies.events.beforeCommit((event) => event.type !== "session.next.fork.history-boundary-imported"
      ? Effect.void
      : dependencies.db.insert(SessionInputTable).values({ ...original, id: SessionMessage.ID.make("msg_late_parent_input"),
          admitted_seq: original.admitted_seq + 1, promoted_seq: null })
          .run().pipe(Effect.orDie, Effect.asVoid))
    const reason = yield* TaskAdmission.admit(dependencies, input).pipe(
      Effect.as("unexpected success"),
      Effect.catchTag("SessionFork.CaptureConflict", (error) => Effect.succeed(error.reason)),
    )
    expect(reason).toBe("pending")
    expect(yield* dependencies.store.get(childID)).toBeUndefined()
    expect(yield* SessionInput.find(dependencies.db, promptID)).toBeUndefined()
  })))
})
