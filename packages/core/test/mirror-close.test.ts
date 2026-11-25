import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
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
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionActivityTable, SessionFileMutationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { MirrorClose } from "@opencode-ai/core/session/workspace/mirror-close"
import { MirrorSession } from "@opencode-ai/core/session/workspace/mirror-session"
import { WorkspaceCheckout } from "@opencode-ai/core/session/workspace/checkout"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution/owner"
import { SessionFileMutation } from "@opencode-ai/core/session/file-mutation"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)
const sessionID = SessionSchema.ID.make("ses_standalone_close")
const assistantMessageID = SessionMessage.ID.make("msg_close_assistant")
const build = AgentV2.ID.make("build")
const model = { id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("fixture") }
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

async function git(directory: string, args: string[]) {
  const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    cwd: directory, stdout: "ignore", stderr: "pipe",
    env: { ...Object.fromEntries(Object.entries(globalThis.process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  })
  const error = await new Response(child.stderr).text()
  if (await child.exited !== 0) throw new Error(error)
}

const initGit = async (source: string, files: Record<string, string> = {}) => {
  await fs.writeFile(path.join(source, "tracked.txt"), "committed\n")
  await fs.writeFile(path.join(source, ".gitignore"), "*.log\n")
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true })
    await fs.writeFile(path.join(source, name), content)
  }
  await git(source, ["init", "--quiet"])
  await git(source, ["add", "-A"])
  await git(source, ["commit", "--quiet", "-m", "fixture"])
  await fs.writeFile(path.join(source, "tracked.txt"), "dirty source\n")
}

const fixture = <R>(
  init: Record<string, string>,
  body: (input: {
    dependencies: MirrorClose.Dependencies
    consents: string[]
    source: string
    root: string
    start: () => Promise<{ directory: string; slot: string }>
  }) => Effect.Effect<void, unknown, R>,
) =>
  Effect.acquireUseRelease(Effect.promise(() => tmpdir()), (tmp) => {
    const database = Database.layerFromPath(":memory:")
    const events = EventV2.layer.pipe(Layer.provide(database))
    const store = SessionStore.layer.pipe(Layer.provide(database))
    const global = Global.layerWith({ data: tmp.path })
    const content = ContentStore.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer), Layer.provide(global))
    const files = FileMutation.layer.pipe(Layer.provide(FSUtil.defaultLayer))
    const journal = SessionFileMutation.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer), Layer.provide(content), Layer.provide(files))
    return Effect.gen(function* () {
      const { db } = yield* Database.Service
      const eventService = yield* EventV2.Service
      const store = yield* SessionStore.Service
      const checkouts = yield* WorkspaceCheckout.Service
      const journal = yield* SessionFileMutation.Service
      const files = yield* FileMutation.Service
      const source = yield* Effect.promise(async () => {
        await initGit(tmp.path, init)
        return fs.realpath(tmp.path)
      })
      const consents: string[] = []
      const permission: PermissionV2.Interface = {
        assert: () => Effect.void,
        assertSingleUse: (request) => Effect.sync(() => {
          consents.push(request.resources[0] ?? "")
          return PermissionV2.ID.create()
        }),
        ask: () => Effect.die("unused"), reply: () => Effect.die("unused"),
        get: () => Effect.succeed(undefined), forSession: () => Effect.succeed([]), list: () => Effect.succeed([]),
        materializationRules: () => Effect.succeed([]),
        policySnapshot: () => Effect.succeed({ configured: [], inherited: [], remembered: [], accessControl: { mode: "ask" }, safetyReviewAvailable: false, reviewed: [], rejected: [] }),
      }
      const root = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-close-mirrors`)
      const location = Location.Ref.make({ directory: AbsolutePath.make(source) })
      yield* db.insert(ProjectTable).values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: ProjectV2.ID.global, directory: location.directory, slug: "close", title: "close", version: "test", agent: build, model }).run()
      yield* db.insert(SessionActivityTable).values({ id: "act_close", session_id: sessionID, status: "running", kind: "prompt", owner_id: "owner_close", lease_until: Date.now() + 60_000 }).run()
      const timestamp = DateTime.makeUnsafe(10)
      yield* eventService.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, timestamp, agent: build, model })
      yield* eventService.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID, timestamp, finish: "stop", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
      const start = async () => {
        const mirror = await MirrorSession.start({ directory: source, sessionID, root })
        if (mirror.status !== "active") throw new Error("Mirror did not start")
        const slots = await fs.readdir(root)
        return { directory: mirror.directory, slot: path.join(root, slots[0]!) }
      }
      yield* SessionExecutionOwner.withOwner({ sessionID, activityID: "act_close", ownerID: "owner_close" }, Effect.gen(function* () {
        yield* body({ dependencies: { db, store, permission, checkouts, files, journal }, consents, source, root, start })
      }))
    }).pipe(Effect.provide(Layer.mergeAll(database, events, store, content, files, journal, WorkspaceCheckout.layer)))
  }, (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()))

const apply = (dependencies: MirrorClose.Dependencies, root: string, planDigest: string) =>
  MirrorClose.integrate(dependencies, { sessionID, agent: build, planDigest, root, assistantMessageID, callID: "close" })

describe("standalone mirror close and integrate", () => {
  it.live("prepares read-only, applies with one fresh consent, journals and marks integrated", () =>
    fixture({}, ({ dependencies, consents, source, root, start }) => Effect.gen(function* () {
      const mirror = yield* Effect.promise(start)
      yield* Effect.promise(() => fs.writeFile(path.join(mirror.directory, "tracked.txt"), "integrated mirror\n"))
      const plan = yield* Effect.promise(() => MirrorClose.close({ directory: source, sessionID, root }))
      if (plan.status !== "ready") return yield* Effect.die(`Unexpected plan status: ${plan.status}`)
      expect(plan.changes).toHaveLength(1)
      expect(plan.changes[0]?.operation).toBe("write")
      expect(plan.changes[0]?.mainSha256).toBe(sha256("dirty source\n"))
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("dirty source\n")
      const applied = yield* apply(dependencies, root, plan.planDigest)
      expect(applied.applied).toHaveLength(1)
      expect(applied.integrated).toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("integrated mirror\n")
      expect(consents).toEqual([`mirror:${sessionID}:integrate:${plan.planDigest}`])
      const journal = yield* dependencies.db.select().from(SessionFileMutationTable)
        .where(eq(SessionFileMutationTable.session_id, sessionID)).all()
      expect(journal).toHaveLength(1)
      expect(journal[0]?.before_sha256).toBe(plan.changes[0]?.mainSha256)
      const marker = JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(mirror.slot, "integrated.json"), "utf8")))
      expect(marker).toMatchObject({ version: 1, planDigest: plan.planDigest, changes: 1 })
      const status = yield* Effect.promise(() => MirrorSession.inspect({ directory: source, sessionID, root }))
      expect(status).toMatchObject({ status: "integrated", planDigest: plan.planDigest })
      yield* Effect.promise(() => MirrorSession.start({ directory: source, sessionID, root })
        .then(() => { throw new Error("start unexpectedly succeeded") },
          (error: Error) => { expect(error.message).toContain("already integrated") }))
      // The spent plan cannot apply again: the source advanced past it.
      const again = yield* apply(dependencies, root, plan.planDigest)
        .pipe(Effect.as("unexpected"), Effect.catchTag("MirrorClose.Blocked", (error) => Effect.succeed(error.reason)))
      expect(again === "drift" || again === "conflicts").toBe(true)
      expect(consents).toHaveLength(1)
    })))

  it.live("refuses a stale plan after the source changed without any write or consent", () =>
    fixture({}, ({ dependencies, consents, source, root, start }) => Effect.gen(function* () {
      const mirror = yield* Effect.promise(start)
      yield* Effect.promise(() => fs.writeFile(path.join(mirror.directory, "tracked.txt"), "integrated mirror\n"))
      const plan = yield* Effect.promise(() => MirrorClose.close({ directory: source, sessionID, root }))
      if (plan.status !== "ready") return yield* Effect.die(`Unexpected plan status: ${plan.status}`)
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "externally changed\n"))
      const refused = yield* apply(dependencies, root, plan.planDigest)
        .pipe(Effect.as("unexpected"), Effect.catchTag("MirrorClose.Blocked", (error) => Effect.succeed(error.reason)))
      expect(refused === "drift" || refused === "conflicts").toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("externally changed\n")
      expect(consents).toEqual([])
      expect(yield* Effect.promise(() => fs.access(path.join(mirror.slot, "integrated.json")).then(() => true, () => false))).toBe(false)
    })))

  it.live("reports same-line conflicts without touching the source", () =>
    fixture({}, ({ dependencies, source, root, start }) => Effect.gen(function* () {
      const mirror = yield* Effect.promise(start)
      yield* Effect.promise(() => fs.writeFile(path.join(mirror.directory, "tracked.txt"), "mirror task\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "main task\n"))
      const plan = yield* Effect.promise(() => MirrorClose.close({ directory: source, sessionID, root }))
      expect(plan).toEqual({ status: "conflicts", conflicts: [{ path: "tracked.txt", reason: "content" }] })
      const refused = yield* apply(dependencies, root, "0".repeat(64))
        .pipe(Effect.as("unexpected"), Effect.catchTag("MirrorClose.Blocked", (error) => Effect.succeed(error.reason)))
      expect(refused).toBe("conflicts")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("main task\n")
    })))

  it.live("applies mirror additions and deletions while never reading unrelated untracked source paths", () =>
    fixture({}, ({ dependencies, source, root, start }) => Effect.gen(function* () {
      const mirror = yield* Effect.promise(start)
      yield* Effect.promise(() => fs.writeFile(path.join(mirror.directory, "created.txt"), "new content\n"))
      yield* Effect.promise(() => fs.rm(path.join(mirror.directory, "tracked.txt")))
      // An untracked source directory with a file-like name proves close never
      // enumerates or reads source-side untracked paths: enumerating it would
      // refuse as a non-regular candidate.
      yield* Effect.promise(() => fs.mkdir(path.join(source, "spoof.txt")))
      const plan = yield* Effect.promise(() => MirrorClose.close({ directory: source, sessionID, root }))
      if (plan.status !== "ready") return yield* Effect.die(`Unexpected plan status: ${plan.status}`)
      expect([...plan.changes].sort((a, b) => a.path < b.path ? -1 : 1)).toHaveLength(2)
      const applied = yield* apply(dependencies, root, plan.planDigest)
      expect(applied.applied).toHaveLength(2)
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "created.txt"), "utf8"))).toBe("new content\n")
      expect(yield* Effect.promise(() => fs.stat(path.join(source, "tracked.txt")).then(() => true, () => false))).toBe(false)
      const journal = yield* dependencies.db.select().from(SessionFileMutationTable)
        .where(eq(SessionFileMutationTable.session_id, sessionID)).all()
      expect(journal).toHaveLength(2)
    })))

  it.live("refuses ignored mirror targets and private basis paths instead of reading or writing them", () =>
    fixture({}, ({ source, root, start }) => Effect.gen(function* () {
      const mirror = yield* Effect.promise(start)
      yield* Effect.promise(() => fs.writeFile(path.join(mirror.directory, "debug.log"), "log output\n"))
      const ignored = yield* Effect.promise(() => MirrorClose.close({ directory: source, sessionID, root }))
      expect(ignored).toEqual({ status: "conflicts", conflicts: [{ path: "debug.log", reason: "ignored" }] })
      expect(yield* Effect.promise(() => fs.access(path.join(source, "debug.log")).then(() => true, () => false))).toBe(false)
      // A basis path that became untracked and ignored in the source is private.
      yield* Effect.promise(() => fs.rm(path.join(mirror.directory, "debug.log")))
      yield* Effect.promise(() => git(source, ["rm", "--cached", "--quiet", "--", "tracked.txt"]))
      yield* Effect.promise(() => fs.appendFile(path.join(source, ".gitignore"), "tracked.txt\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(mirror.directory, "tracked.txt"), "mirror task\n"))
      const privates = yield* Effect.promise(() => MirrorClose.close({ directory: source, sessionID, root }))
      expect(privates).toEqual({ status: "conflicts", conflicts: [{ path: "tracked.txt", reason: "private" }] })
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("dirty source\n")
    })))

  it.live("refuses a source-side junction ancestor escape without touching external files", () =>
    fixture({ "sub/inner.txt": "committed\n" }, ({ source, root, start }) => Effect.gen(function* () {
      const mirror = yield* Effect.promise(start)
      yield* Effect.promise(() => fs.writeFile(path.join(mirror.directory, "sub", "inner.txt"), "mirror task\n"))
      const outside = yield* Effect.promise(() => tmpdir())
      yield* Effect.promise(() => fs.writeFile(path.join(outside.path, "inner.txt"), "sentinel\n"))
      yield* Effect.promise(async () => {
        await fs.rename(path.join(source, "sub"), path.join(outside.path, "moved-sub"))
        await fs.symlink(path.join(outside.path, "moved-sub"), path.join(source, "sub"), process.platform === "win32" ? "junction" : "dir")
      })
      const refused = yield* Effect.promise(() => MirrorClose.close({ directory: source, sessionID, root })
        .then(() => "unexpected", (error: Error) => error.message))
      expect(refused).toMatch(/escapes its root|not a directory/)
      expect(yield* Effect.promise(() => fs.readFile(path.join(outside.path, "moved-sub", "inner.txt"), "utf8"))).toBe("committed\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(outside.path, "inner.txt"), "utf8"))).toBe("sentinel\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("dirty source\n")
    })))

  it.live("refuses a mirror-side junction ancestor escape for a new mirror file", () =>
    fixture({}, ({ source, root, start }) => Effect.gen(function* () {
      const mirror = yield* Effect.promise(start)
      const outside = yield* Effect.promise(() => tmpdir())
      yield* Effect.promise(() => fs.mkdir(path.join(mirror.directory, "linked"), { recursive: true }))
      yield* Effect.promise(() => fs.rename(path.join(mirror.directory, "linked"), path.join(outside.path, "linked")))
      yield* Effect.promise(() => fs.writeFile(path.join(outside.path, "linked", "added.txt"), "outside\n"))
      yield* Effect.promise(() => fs.symlink(path.join(outside.path, "linked"), path.join(mirror.directory, "linked"), process.platform === "win32" ? "junction" : "dir"))
      const refused = yield* Effect.promise(() => MirrorClose.close({ directory: source, sessionID, root })
        .then(() => "unexpected", (error: Error) => error.message))
      expect(refused).toMatch(/escapes its root|not a directory/)
      expect(yield* Effect.promise(() => fs.readFile(path.join(outside.path, "linked", "added.txt"), "utf8"))).toBe("outside\n")
    })))

  it.live("keeps basis bytes exact for binary and CRLF dirty files and merges them byte-exact", () =>
    fixture({ "binary.bin": "raw\n" }, ({ dependencies, source, root, start }) => Effect.gen(function* () {
      const dirty = Buffer.from([0x00, 0x0d, 0x0a, 0xc3, 0xa4, 0xff, 0x00, 0x0d])
      yield* Effect.promise(() => fs.writeFile(path.join(source, "binary.bin"), dirty))
      const mirror = yield* Effect.promise(start)
      const blob = yield* Effect.promise(() => fs.readFile(path.join(mirror.slot, "basis-blobs", createHash("sha256").update(dirty).digest("hex"))))
      expect(Buffer.compare(blob, dirty)).toBe(0)
      const edited = Buffer.from([0x00, 0x0d, 0x0a, 0xc3, 0xa4, 0xff, 0x00, 0x0a, 0x41])
      yield* Effect.promise(() => fs.writeFile(path.join(mirror.directory, "binary.bin"), edited))
      const plan = yield* Effect.promise(() => MirrorClose.close({ directory: source, sessionID, root }))
      if (plan.status !== "ready") return yield* Effect.die(`Unexpected plan status: ${plan.status}`)
      yield* apply(dependencies, root, plan.planDigest)
      const merged = yield* Effect.promise(() => fs.readFile(path.join(source, "binary.bin")))
      expect(Buffer.compare(merged, edited)).toBe(0)
    })))

  it.live("fails closed on a corrupt or missing basis snapshot while status stays readable", () =>
    fixture({}, ({ source, root, start }) => Effect.gen(function* () {
      const mirror = yield* Effect.promise(start)
      const blobs = path.join(mirror.slot, "basis-blobs")
      const stored = (yield* Effect.promise(() => fs.readdir(blobs)))[0]!
      const bytes = yield* Effect.promise(() => fs.readFile(path.join(blobs, stored)))
      bytes[0] = bytes[0]! ^ 0x20
      yield* Effect.promise(() => fs.writeFile(path.join(blobs, stored), bytes))
      const corrupt = yield* Effect.promise(() => MirrorClose.close({ directory: source, sessionID, root })
        .then(() => "unexpected", (error: Error) => error.message))
      expect(corrupt).toContain("corrupt")
      yield* Effect.promise(() => fs.rm(blobs, { recursive: true }))
      const leasePath = path.join(mirror.slot, "lease.json")
      const lease = JSON.parse(yield* Effect.promise(() => fs.readFile(leasePath, "utf8")))
      delete lease.basisSnapshotDigest
      yield* Effect.promise(() => fs.writeFile(leasePath, JSON.stringify(lease)))
      const status = yield* Effect.promise(() => MirrorSession.inspect({ directory: source, sessionID, root }))
      expect(status).toMatchObject({ status: "active" })
      const missing = yield* Effect.promise(() => MirrorClose.close({ directory: source, sessionID, root })
        .then(() => "unexpected", (error: Error) => error.message))
      expect(missing).toContain("Basis snapshot is missing")
    })))

  it.live("discard requires the integrated marker and a mirror unchanged since integration", () =>
    fixture({}, ({ dependencies, source, root, start }) => Effect.gen(function* () {
      const mirror = yield* Effect.promise(start)
      const pending = yield* Effect.promise(() => MirrorClose.discard({ directory: source, sessionID, root })
        .then(() => "unexpected", (error: Error) => error.message))
      expect(pending).toContain("not integrated")
      yield* Effect.promise(() => fs.writeFile(path.join(mirror.directory, "tracked.txt"), "integrated mirror\n"))
      const plan = yield* Effect.promise(() => MirrorClose.close({ directory: source, sessionID, root }))
      if (plan.status !== "ready") return yield* Effect.die(`Unexpected plan status: ${plan.status}`)
      yield* apply(dependencies, root, plan.planDigest)
      yield* Effect.promise(() => fs.writeFile(path.join(mirror.directory, "tracked.txt"), "late edit\n"))
      const changed = yield* Effect.promise(() => MirrorClose.discard({ directory: source, sessionID, root })
        .then(() => "unexpected", (error: Error) => error.message))
      expect(changed).toContain("changed after integration")
      expect(yield* Effect.promise(() => fs.stat(mirror.slot).then(() => true, () => false))).toBe(true)
      yield* Effect.promise(() => fs.writeFile(path.join(mirror.directory, "tracked.txt"), "integrated mirror\n"))
      const discarded = yield* Effect.promise(() => MirrorClose.discard({ directory: source, sessionID, root }))
      expect(discarded).toEqual({ status: "discarded", directory: mirror.slot })
      expect(yield* Effect.promise(() => fs.stat(mirror.slot).then(() => true, () => false))).toBe(false)
      expect(yield* Effect.promise(() => MirrorSession.inspect({ directory: source, sessionID, root }))).toEqual({ status: "available" })
    })))

  it.live("integrates an empty plan, reports it through the actual CLI and discards it", () =>
    fixture({}, ({ dependencies, source, root, start }) => Effect.gen(function* () {
      const mirror = yield* Effect.promise(start)
      yield* Effect.promise(() => fs.writeFile(path.join(source, "fresh-untracked.txt"), "unrelated\n"))
      const plan = yield* Effect.promise(() => MirrorClose.close({ directory: source, sessionID, root }))
      if (plan.status !== "ready") return yield* Effect.die(`Unexpected plan status: ${plan.status}`)
      expect(plan.changes).toHaveLength(0)
      const applied = yield* apply(dependencies, root, plan.planDigest)
      expect(applied.applied).toHaveLength(0)
      expect(applied.integrated).toBe(true)
      expect(applied.markerError).toBeUndefined()
      const run = (action: string) => {
        const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../../script/mirror.ts"),
          "--action", action, "--directory", source, "--session", sessionID, "--root", root],
        { cwd: path.dirname(root), stdout: "pipe", stderr: "pipe" })
        return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
          .then(([code, stdout, stderr]) => ({ code, stdout, stderr }))
      }
      const status = yield* Effect.promise(() => run("status"))
      expect(status.code).toBe(0)
      expect(JSON.parse(status.stdout)).toMatchObject({ status: "integrated", planDigest: plan.planDigest })
      const stale = yield* Effect.promise(() => run("close"))
      expect(stale.code).toBe(0)
      expect(JSON.parse(stale.stdout)).toMatchObject({ status: "ready", changes: [] })
      const invalid = yield* Effect.promise(() => run("merge"))
      expect(invalid.code).not.toBe(0)
      expect(invalid.stderr).toContain("status|start|close|discard")
      const discarded = yield* Effect.promise(() => run("discard"))
      expect(discarded.code).toBe(0)
      expect(JSON.parse(discarded.stdout)).toEqual({ status: "discarded", directory: mirror.slot })
    })))

  it.live("the actual CLI prepares a read-only close and refuses an unintegrated discard", () =>
    Effect.acquireUseRelease(Effect.promise(() => tmpdir()), (tmp) => Effect.promise(async () => {
      const source = path.join(tmp.path, "repo")
      const root = path.join(tmp.path, "mirror-root")
      await fs.mkdir(source, { recursive: true })
      await initGit(source)
      const mirror = await MirrorSession.start({ directory: source, sessionID, root })
      if (mirror.status !== "active") throw new Error("Mirror did not start")
      await fs.writeFile(path.join(mirror.directory, "tracked.txt"), "cli prepared\n")
      const run = (action: string) => {
        const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../../script/mirror.ts"),
          "--action", action, "--directory", source, "--session", sessionID, "--root", root],
        { cwd: tmp.path, stdout: "pipe", stderr: "pipe" })
        return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
          .then(([code, stdout, stderr]) => ({ code, stdout, stderr }))
      }
      const plan = await run("close")
      if (plan.code !== 0) throw new Error(plan.stderr)
      const parsed = JSON.parse(plan.stdout)
      expect(parsed.status).toBe("ready")
      expect(parsed.changes).toHaveLength(1)
      expect(parsed.changes[0]?.mainSha256).toBe(sha256("dirty source\n"))
      expect(await fs.readFile(path.join(source, "tracked.txt"), "utf8")).toBe("dirty source\n")
      const repeat = await run("close")
      expect(JSON.parse(repeat.stdout).planDigest).toBe(parsed.planDigest)
      const blocked = await run("discard")
      expect(blocked.code).not.toBe(0)
      expect(blocked.stderr).toContain("not integrated")
    }), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())))
})
