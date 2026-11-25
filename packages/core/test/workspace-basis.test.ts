import { describe, expect } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { AgentMirror } from "@opencode-ai/core/session/workspace/agent-mirror"
import { WorkspaceBasis } from "@opencode-ai/core/session/workspace/basis"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)
const sessionID = SessionSchema.ID.make("ses_basis_parent")
async function git(directory: string, args: string[]) {
  const process = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
  if (code !== 0) throw new Error(stderr)
  return stdout
}

const fixture = <R>(body: (content: ContentStore.Interface, mirror: AgentMirror.Mirror, source: string) => Effect.Effect<void, unknown, R>) =>
  Effect.acquireUseRelease(Effect.promise(() => Promise.all([tmpdir({ git: true }), tmpdir()])), ([source, storage]) => {
    const database = Database.layerFromPath(":memory:")
    const content = ContentStore.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer), Layer.provide(Global.layerWith({ data: storage.path })))
    return Effect.gen(function* () {
      const { db } = yield* Database.Service
      const content = yield* ContentStore.Service
      yield* db.insert(ProjectTable).values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make(source.path), sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: ProjectV2.ID.global, directory: source.path, slug: "source", title: "source", version: "test" }).run()
      const mirror = yield* Effect.promise(async () => {
        await fs.writeFile(path.join(source.path, "dirty.txt"), "committed")
        await fs.writeFile(path.join(source.path, "removed.txt"), "remove me")
        await fs.writeFile(path.join(source.path, "staged-removed.txt"), "staged removal")
        await git(source.path, ["add", "--all"])
        await git(source.path, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "test: isolated basis"])
        await fs.writeFile(path.join(source.path, "dirty.txt"), "staged")
        await git(source.path, ["add", "dirty.txt"])
        await fs.writeFile(path.join(source.path, "dirty.txt"), "dirty main bytes")
        await fs.unlink(path.join(source.path, "removed.txt"))
        await git(source.path, ["rm", "--", "staged-removed.txt"])
        await fs.writeFile(path.join(source.path, "untracked.txt"), "untracked main bytes")
        await fs.mkdir(path.join(source.path, "nested"))
        await fs.writeFile(path.join(source.path, "nested", "file.txt"), "nested bytes")
        return AgentMirror.create({ directory: source.path, mirrorRoot: storage.path, taskID: "basis-test", sourceSessionID: sessionID, throughSeq: 1, untracked: ["untracked.txt", "nested/file.txt"] })
      })
      yield* body(content, mirror, source.path)
    }).pipe(Effect.provide(Layer.mergeAll(database, content)))
  }, (directories) => Effect.promise(() => Promise.all(directories.map((directory) => directory[Symbol.asyncDispose]()))))

describe("immutable native workspace basis", () => {
  it.live("retains dirty and untracked bytes independently of later Main and child edits", () => fixture((content, mirror, source) => Effect.gen(function* () {
    const before = yield* Effect.promise(() => git(source, ["status", "--porcelain=v1"]))
    const saved = yield* WorkspaceBasis.capture(content, { sessionID, mirror })
    const replayed = Schema.decodeUnknownSync(Schema.fromJsonString(WorkspaceBasis.Manifest))(JSON.stringify(saved.manifest))
    expect(WorkspaceBasis.digest(replayed)).toBe(saved.digest)
    expect(saved.manifest.deletedPaths).toContain("removed.txt")
    expect(saved.manifest.deletedPaths).toContain("staged-removed.txt")
    expect((yield* Effect.promise(() => git(source, ["status", "--porcelain=v1"])))).toBe(before)
    yield* Effect.promise(async () => {
      await fs.writeFile(path.join(mirror.directory, "dirty.txt"), "child result")
      await fs.writeFile(path.join(source, "dirty.txt"), "later main")
      await fs.writeFile(path.join(mirror.directory, "untracked.txt"), "child untracked")
    })
    const load = (file: string) => WorkspaceBasis.read(content, { sessionID, manifest: replayed, digest: saved.digest, path: file })
    expect(new TextDecoder().decode((yield* load("dirty.txt"))?.bytes)).toBe("dirty main bytes")
    expect(new TextDecoder().decode((yield* load("untracked.txt"))?.bytes)).toBe("untracked main bytes")
    expect(yield* load("removed.txt")).toBeUndefined()
    const changed = { ...saved.manifest, deletedPaths: [] }
    expect(Exit.isFailure(yield* Effect.exit(WorkspaceBasis.read(content, { sessionID, manifest: changed, digest: saved.digest, path: "dirty.txt" })))).toBe(true)
  })))
  it.live("rejects changed child bytes before creating a basis and detects blob corruption", () => fixture((content, mirror) => Effect.gen(function* () {
    const saved = yield* WorkspaceBasis.capture(content, { sessionID, mirror })
    yield* Effect.promise(() => fs.writeFile(path.join(mirror.directory, "dirty.txt"), "edited before capture"))
    expect(Exit.isFailure(yield* Effect.exit(WorkspaceBasis.capture(content, { sessionID, mirror })))).toBe(true)
    const first = saved.manifest.files.find((file) => file.path === "dirty.txt")
    if (!first) return yield* Effect.die("Missing retained basis file")
    const located = yield* content.locate({ sessionID, uri: first.uri })
    if (!located) return yield* Effect.die("Missing retained basis blob")
    yield* Effect.promise(() => fs.writeFile(located.path, new Uint8Array(first.bytes).fill(120)))
    expect(Exit.isFailure(yield* Effect.exit(WorkspaceBasis.read(content, { sessionID, ...saved, path: "dirty.txt" })))).toBe(true)
  })))
  it.live("rejects unsafe paths, collisions, invalid modes, sizes, hashes and a foreign owner", () => fixture((content, mirror) => Effect.gen(function* () {
    const first = mirror.basis.files[0]
    if (!first) return yield* Effect.die("Missing fixture file")
    const invalid = [
      { ...mirror.basis, sourceSessionID: "ses_foreign" },
      ...["../escape", ".git/config", "C:/escape", "nested\\file", "NUL.txt", "trailing.", "a//b"].map((path) => ({ ...mirror.basis, files: [{ ...first, path }] })),
      { ...mirror.basis, deletedPaths: [first.path] },
      { ...mirror.basis, files: [first, { ...first, path: first.path.toUpperCase() }] },
      ...[{ mode: -1 }, { mode: 0o1000 }, { bytes: -1 }, { bytes: 1.5 }, { sha256: "not-a-hash" }].map((change) => ({ ...mirror.basis, files: [{ ...first, ...change }] })),
    ]
    for (const basis of invalid)
      expect(Exit.isFailure(yield* Effect.exit(WorkspaceBasis.capture(content, { sessionID, mirror: { ...mirror, basis } })))).toBe(true)
    const saved = yield* WorkspaceBasis.capture(content, { sessionID, mirror })
    expect(Exit.isFailure(yield* Effect.exit(WorkspaceBasis.read(content, { sessionID: SessionSchema.ID.make("ses_foreign"), ...saved, path: first.path })))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(WorkspaceBasis.read(content, { sessionID, ...saved, path: "../escape" })))).toBe(true)
  })))
  it.live("refuses a resurrected deletion and a linked ancestor even when its bytes match", () => fixture((content, mirror) => Effect.gen(function* () {
    yield* Effect.promise(() => fs.writeFile(path.join(mirror.directory, "removed.txt"), "resurrected"))
    expect(Exit.isFailure(yield* Effect.exit(WorkspaceBasis.capture(content, { sessionID, mirror })))).toBe(true)
    yield* Effect.promise(async () => {
      await fs.unlink(path.join(mirror.directory, "removed.txt"))
      await fs.rename(path.join(mirror.directory, "nested"), path.join(mirror.directory, "actual"))
      await fs.symlink(path.join(mirror.directory, "actual"), path.join(mirror.directory, "nested"), process.platform === "win32" ? "junction" : "dir")
    })
    expect(Exit.isFailure(yield* Effect.exit(WorkspaceBasis.capture(content, { sessionID, mirror })))).toBe(true)
  })))
})
