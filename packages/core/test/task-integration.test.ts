import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { AgentV2 } from "@opencode-ai/core/agent"
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
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionActivityTable, SessionContextEpochTable, SessionFileMutationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { TaskAdmission } from "@opencode-ai/core/session/task-admission"
import { TaskIntegration } from "@opencode-ai/core/session/task-integration"
import { WorkspaceCheckout } from "@opencode-ai/core/session/workspace/checkout"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution/owner"
import { SessionFileMutation } from "@opencode-ai/core/session/file-mutation"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)
const parentID = SessionSchema.ID.make("ses_integration_parent")
const childID = SessionSchema.ID.make("ses_integration_child")
const assistantMessageID = SessionMessage.ID.make("msg_integration_assistant")
const promptID = SessionMessage.ID.make("msg_integration_prompt")
const build = AgentV2.ID.make("build")
const worker = AgentV2.ID.make("worker")
const model = { id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("fixture") }

const initGit = async (source: string) => {
  await fs.writeFile(path.join(source, "tracked.txt"), "committed\n")
  for (const args of [["init", "--quiet"], ["add", "--", "tracked.txt"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]]) {
    const process = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd: source, stdout: "ignore", stderr: "pipe",
      env: { ...Object.fromEntries(Object.entries(globalThis.process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    })
    const error = await new Response(process.stderr).text()
    if (await process.exited !== 0) throw new Error(error)
  }
  await fs.writeFile(path.join(source, "tracked.txt"), "dirty source\n")
}

const fixture = <R>(
  body: (input: {
    dependencies: TaskIntegration.Dependencies
    admission: TaskAdmission.Dependencies
    source: string
    integrateAssistant: SessionMessage.ID
  }) => Effect.Effect<void, unknown, R>,
) =>
  Effect.acquireUseRelease(Effect.promise(() => tmpdir()), (tmp) => {
    const database = Database.layerFromPath(":memory:")
    const events = EventV2.layer.pipe(Layer.provide(database))
    const projector = SessionProjector.layer.pipe(Layer.provide(database), Layer.provide(events))
    const store = SessionStore.layer.pipe(Layer.provide(database))
    const global = Global.layerWith({ data: tmp.path })
    const content = ContentStore.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer), Layer.provide(global))
    const files = FileMutation.layer.pipe(Layer.provide(FSUtil.defaultLayer))
    const journal = SessionFileMutation.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer), Layer.provide(content), Layer.provide(files))
    return Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      const content = yield* ContentStore.Service
      const agents = yield* AgentV2.Service
      const registry = yield* ToolRegistry.Service
      const checkouts = yield* WorkspaceCheckout.Service
      const journal = yield* SessionFileMutation.Service
      const files = yield* FileMutation.Service
      yield* agents.update((editor) => {
        editor.update(build, (agent) => { agent.mode = "primary" })
        editor.update(worker, (agent) => { agent.mode = "subagent" })
      })
      const source = tmp.path
      yield* Effect.promise(() => initGit(source))
      const location = Location.Ref.make({ directory: AbsolutePath.make(source) })
      yield* db.insert(ProjectTable).values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: parentID, project_id: ProjectV2.ID.global, directory: location.directory, slug: "parent", title: "parent", version: "test", agent: build, model }).run()
      yield* db.insert(SessionContextEpochTable).values({ session_id: parentID, baseline: "parent context", baseline_seq: -1, snapshot: {}, agent: build }).run()
      yield* db.insert(SessionActivityTable).values({ id: "act_fixture", session_id: parentID, status: "running", kind: "prompt", owner_id: "owner_fixture", lease_until: Date.now() + 60_000 }).run()
      const timestamp = DateTime.makeUnsafe(10)
      // A finished earlier assistant, then the promoted assignment user, then
      // the one unfinished dispatch assistant: exactly the capture boundary.
      const integrateAssistant = SessionMessage.ID.make("msg_integration_tool")
      yield* events.publish(SessionEvent.Step.Started, { sessionID: parentID, assistantMessageID: integrateAssistant, timestamp, agent: build, model })
      yield* events.publish(SessionEvent.Step.Ended, { sessionID: parentID, assistantMessageID: integrateAssistant, timestamp, finish: "stop", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
      yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_parent_user"), sessionID: parentID, prompt: new Prompt({ text: "Parent evidence" }), delivery: "steer" })
      yield* SessionInput.promoteSteers(db, events, parentID, Number.MAX_SAFE_INTEGER)
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
      yield* SessionExecutionOwner.withOwner({ sessionID: parentID, activityID: "act_fixture", ownerID: "owner_fixture" }, Effect.gen(function* () {
        const admission = { db, events, store, content, agents, registry, checkouts, permission,
          delegationLayers: () => Effect.succeed([]), mirrorRoot: path.join(tmp.path, "..", `${path.basename(tmp.path)}-mirrors`) }
        const admitted = yield* TaskAdmission.admit(admission, {
          create: { id: childID, parentID, agent: worker, model, location },
          prompt: { id: promptID, sessionID: childID, prompt: new Prompt({ text: "Child assignment" }), agent: worker, model, resume: false },
          workspace: undefined, parentAgent: build, boundary: { assistantMessageID, toolCallID: "dispatch" },
        })
        yield* SessionInput.promoteSteers(db, events, childID, Number.MAX_SAFE_INTEGER)
        yield* body({ source, integrateAssistant, admission,
          dependencies: { db, store, content, permission, checkouts, files, journal } })
      }))
    }).pipe(Effect.provide(Layer.mergeAll(database, events, projector, store, content, files, journal, AgentV2.layer, ToolRegistry.defaultLayer, WorkspaceCheckout.layer)))
  }, (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()))

describe("native task integration", () => {
  it.live("prepares, reviews and applies a child update into Main with one fresh consent and a journal", () =>
    fixture(({ dependencies, source, integrateAssistant }) => Effect.gen(function* () {
      const consents: string[] = []
      const deps = { ...dependencies, permission: { ...dependencies.permission,
        assertSingleUse: (request: Parameters<NonNullable<PermissionV2.Interface["assertSingleUse"]>>[0]) =>
          Effect.sync(() => { consents.push(request.resources[0] ?? ""); return PermissionV2.ID.create() }) } }
      const child = yield* deps.store.get(childID)
      const mirrorDirectory = child?.location.directory
      if (!mirrorDirectory) return yield* Effect.die("Missing mirror directory")
      yield* Effect.promise(() => fs.writeFile(path.join(mirrorDirectory, "tracked.txt"), "integrated child\n"))
      const plan = yield* TaskIntegration.prepare(deps, { parentID, childID })
      if (plan.status !== "ready") return yield* Effect.die(`Unexpected plan status: ${plan.status}`)
      expect(plan.changes).toEqual([{ path: "tracked.txt", operation: "write",
        sha256: plan.changes[0]?.sha256, bytes: "integrated child\n".length, mode: plan.changes[0]?.mode,
        mainSha256: plan.changes[0]?.mainSha256, mainMode: plan.changes[0]?.mainMode }])
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("dirty source\n")
      const applied = yield* TaskIntegration.apply(deps, { parentID, childID, parentAgent: build,
        planDigest: plan.planDigest, assistantMessageID: integrateAssistant, callID: "integrate" })
      expect(applied.applied).toHaveLength(1)
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("integrated child\n")
      expect(consents).toEqual([`task:${childID}:integrate:${plan.planDigest}`])
      const journal = yield* deps.db.select().from(SessionFileMutationTable)
        .where(eq(SessionFileMutationTable.session_id, parentID)).all()
      expect(journal).toHaveLength(1)
      expect(journal[0]?.after_exists).toBe(true)
      expect(journal[0]?.before_sha256).toBe(plan.changes[0]?.mainSha256)
      expect(yield* Effect.promise(() => fs.readFile(path.join(mirrorDirectory, "tracked.txt"), "utf8")))
        .toBe("integrated child\n")
      // The applied plan digest is spent: Main advanced, so an exact re-apply
      // must refuse instead of silently no-oping.
      const again = yield* TaskIntegration.apply(deps, { parentID, childID, parentAgent: build,
        planDigest: plan.planDigest, assistantMessageID: integrateAssistant, callID: "integrate" })
        .pipe(Effect.as("unexpected"), Effect.catchTag("TaskIntegration.Blocked", (error) => Effect.succeed(error.reason)))
      expect(again).toBe("drift")
      expect(consents).toHaveLength(1)
    })))

  it.live("hands the integrated Main state to the next round's fresh mirror basis", () =>
    fixture(({ dependencies, admission, source, integrateAssistant }) => Effect.gen(function* () {
      const child = yield* dependencies.store.get(childID)
      const mirrorDirectory = child?.location.directory
      if (!mirrorDirectory) return yield* Effect.die("Missing mirror directory")
      yield* Effect.promise(() => fs.writeFile(path.join(mirrorDirectory, "tracked.txt"), "round one result\n"))
      const plan = yield* TaskIntegration.prepare(dependencies, { parentID, childID })
      if (plan.status !== "ready") return yield* Effect.die(`Unexpected plan status: ${plan.status}`)
      yield* TaskIntegration.apply(dependencies, { parentID, childID, parentAgent: build,
        planDigest: plan.planDigest, assistantMessageID: integrateAssistant, callID: "integrate" })
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("round one result\n")
      // The checked handover: a second independent round starts from a fresh
      // mirror whose immutable basis already contains the integrated bytes,
      // so it never reverts or re-merges the accepted predecessor result.
      const secondID = SessionSchema.ID.make("ses_integration_child_two")
      const roundTwo = yield* TaskAdmission.admit(admission, {
        create: { id: secondID, parentID, agent: worker, model, location: { directory: AbsolutePath.make(source), workspaceID: undefined } },
        prompt: { id: SessionMessage.ID.make("msg_integration_prompt_two"), sessionID: secondID,
          prompt: new Prompt({ text: "Second assignment" }), agent: worker, model, resume: false },
        workspace: undefined, parentAgent: build, boundary: { assistantMessageID, toolCallID: "dispatch" },
      })
      const secondMirror = roundTwo.location.directory
      expect(secondMirror).not.toBe(mirrorDirectory)
      expect(yield* Effect.promise(() => fs.readFile(path.join(secondMirror, "tracked.txt"), "utf8")))
        .toBe("round one result\n")
      const basisFile = roundTwo.agentPolicy?.mirrorWorkspace?.basis.files.find((file) => file.path === "tracked.txt")
      expect(basisFile?.sha256).toBe(createHash("sha256").update("round one result\n").digest("hex"))
      // The first round's spent plan is void against the advanced Main.
      const spent = yield* TaskIntegration.prepare(dependencies, { parentID, childID })
        .pipe(Effect.map((outcome) => outcome.status === "ready" && outcome.changes.length === 0 ? "empty" : outcome.status))
      expect(spent).toBe("empty")
    })))

  it.live("refuses a stale plan after Main changed and a conflicting plan without any Main write", () =>
    fixture(({ dependencies, source, integrateAssistant }) => Effect.gen(function* () {
      const child = yield* dependencies.store.get(childID)
      const mirrorDirectory = child?.location.directory
      if (!mirrorDirectory) return yield* Effect.die("Missing mirror directory")
      yield* Effect.promise(() => fs.writeFile(path.join(mirrorDirectory, "tracked.txt"), "integrated child\n"))
      const plan = yield* TaskIntegration.prepare(dependencies, { parentID, childID })
      if (plan.status !== "ready") return yield* Effect.die(`Unexpected plan status: ${plan.status}`)
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "externally changed\n"))
      const drifted = yield* TaskIntegration.apply(dependencies, { parentID, childID, parentAgent: build,
        planDigest: plan.planDigest, assistantMessageID: integrateAssistant, callID: "integrate" })
        .pipe(Effect.as("unexpected"), Effect.catchTag("TaskIntegration.Blocked", (error) => Effect.succeed(error.reason)))
      // The external edit conflicts with the child's same-line change; the
      // reviewed plan is void either way and Main keeps the external content.
      expect(drifted === "drift" || drifted === "conflicts").toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("externally changed\n")
      // A Main change that exactly matches the child leaves nothing to apply;
      // the spent digest still refuses rather than no-oping.
      const conflicts = yield* TaskIntegration.prepare(dependencies, { parentID, childID })
      if (conflicts.status !== "conflicts") return yield* Effect.die(`Expected conflicts, got ${conflicts.status}`)
      expect(conflicts.conflicts).toEqual([{ path: "tracked.txt", reason: "content" }])
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "integrated child\n"))
      const spent = yield* TaskIntegration.apply(dependencies, { parentID, childID, parentAgent: build,
        planDigest: plan.planDigest, assistantMessageID: integrateAssistant, callID: "integrate" })
        .pipe(Effect.as("unexpected"), Effect.catchTag("TaskIntegration.Blocked", (error) => Effect.succeed(error.reason)))
      expect(spent).toBe("drift")
      // A Main mode-only change after review must also void the plan digest.
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "dirty source\n"))
      const remode = yield* TaskIntegration.prepare(dependencies, { parentID, childID })
      yield* Effect.promise(() => fs.chmod(path.join(source, "tracked.txt"), 0o444))
      const modeDrift = yield* TaskIntegration.apply(dependencies, { parentID, childID, parentAgent: build,
        planDigest: remode.status === "ready" ? remode.planDigest : "0".repeat(64),
        assistantMessageID: integrateAssistant, callID: "integrate" })
        .pipe(Effect.as("unexpected"), Effect.catchTag("TaskIntegration.Blocked", (error) => Effect.succeed(error.reason)))
      expect(modeDrift === "drift" || modeDrift === "conflicts").toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("dirty source\n")
    })))

  it.live("applies a child deletion and records it in the journal", () =>
    fixture(({ dependencies, source, integrateAssistant }) => Effect.gen(function* () {
      const child = yield* dependencies.store.get(childID)
      const mirrorDirectory = child?.location.directory
      if (!mirrorDirectory) return yield* Effect.die("Missing mirror directory")
      yield* Effect.promise(() => fs.rm(path.join(mirrorDirectory, "tracked.txt")))
      const plan = yield* TaskIntegration.prepare(dependencies, { parentID, childID })
      if (plan.status !== "ready") return yield* Effect.die(`Unexpected plan status: ${plan.status}`)
      expect(plan.changes[0]?.operation).toBe("delete")
      const applied = yield* TaskIntegration.apply(dependencies, { parentID, childID, parentAgent: build,
        planDigest: plan.planDigest, assistantMessageID: integrateAssistant, callID: "integrate" })
      expect(applied.applied).toHaveLength(1)
      expect(yield* Effect.promise(() => fs.stat(path.join(source, "tracked.txt")).then(() => true, () => false))).toBe(false)
      const journal = yield* dependencies.db.select().from(SessionFileMutationTable)
        .where(eq(SessionFileMutationTable.session_id, parentID)).all()
      expect(journal[0]?.after_exists).toBe(false)
      expect(journal[0]?.before_exists).toBe(true)
    })))

  it.live("refuses an unreadable child path instead of proposing a Main deletion", () =>
    fixture(({ dependencies, source }) => Effect.gen(function* () {
      const child = yield* dependencies.store.get(childID)
      const mirrorDirectory = child?.location.directory
      if (!mirrorDirectory) return yield* Effect.die("Missing mirror directory")
      // A non-regular file where the child result should be is an I/O failure,
      // never absence: preparation must refuse without touching Main.
      yield* Effect.promise(async () => {
        await fs.rm(path.join(mirrorDirectory, "tracked.txt"))
        await fs.mkdir(path.join(mirrorDirectory, "tracked.txt"))
      })
      const outcome = yield* TaskIntegration.prepare(dependencies, { parentID, childID })
        .pipe(Effect.as("unexpected"), Effect.catchTag("TaskIntegration.Blocked", (error) => Effect.succeed(error.reason)))
      expect(outcome).toBe("io")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("dirty source\n")
    })))
})
