import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@opencode-ai/core/git"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ContentStore } from "@opencode-ai/core/content-store"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionActivityTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const directories = ProjectDirectories.layer.pipe(Layer.provide(database), Layer.provide(events))
const projector = SessionProjector.layer.pipe(Layer.provide(database), Layer.provide(events))
const project = Project.layer.pipe(
  Layer.provide(database),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(directories),
)
const store = SessionStore.layer.pipe(Layer.provide(database))
const activities = SessionActivity.layer.pipe(Layer.provide(database), Layer.provide(events))
const sessions = SessionV2.layer.pipe(
  Layer.provide(ContentStore.defaultLayer),
  Layer.provide(database),
  Layer.provide(events),
  Layer.provide(project),
  Layer.provide(store),
  Layer.provide(SessionExecution.noopLayer),
)
const layer = MoveSession.layer.pipe(
  Layer.provide(database),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(events),
  Layer.provide(project),
  Layer.provide(activities),
  Layer.provide(sessions),
)
const it = testEffect(
  Layer.mergeAll(
    layer,
    database,
    events,
    directories,
    project,
    projector,
    store,
    activities,
    SessionExecution.noopLayer,
    sessions,
  ),
)

function abs(input: string) {
  return AbsolutePath.make(input)
}

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.autocrlf false`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@opencode.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await fs.writeFile(path.join(directory, "tracked.txt"), "initial\n")
  await $`git add tracked.txt`.cwd(directory).quiet()
  await $`git commit -m root`.cwd(directory).quiet()
}

describe("MoveSession", () => {
  it.live("moves session changes to another project directory", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const destination = abs(`${root.path}-move-destination`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(destination, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${destination} HEAD`.cwd(root.path).quiet())
      const moved = abs(yield* Effect.promise(() => fs.realpath(destination)))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "changed\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "untracked.txt"), "new\n"))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "move",
          directory: source,
          title: "move",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: moved }, moveChanges: true }),
      )

      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "tracked.txt"), "utf8"))).toBe("changed\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "untracked.txt"), "utf8"))).toBe("new\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("initial\n")
      expect(yield* Effect.promise(() => Bun.file(path.join(source, "untracked.txt")).exists())).toBe(false)
      expect(
        yield* db
          .select({ directory: SessionTable.directory, path: SessionTable.path })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ directory: moved, path: "" })
    }),
    10_000,
  )

  it.live("moves within a checkout without transferring existing changes", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const destination = abs(path.join(source, "packages"))
      yield* Effect.promise(() => fs.mkdir(destination))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "changed\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "untracked.txt"), "new\n"))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_nested")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "move-nested",
          directory: source,
          title: "move nested",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: destination }, moveChanges: true }),
      )

      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("changed\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "untracked.txt"), "utf8"))).toBe("new\n")
      expect(
        yield* db
          .select({ directory: SessionTable.directory, path: SessionTable.path })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ directory: destination, path: "packages" })
    }),
    10_000,
  )

  it.live("moves nested session changes without cleaning unrelated files", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const sourceDirectory = abs(path.join(source, "packages"))
      yield* Effect.promise(() => fs.mkdir(sourceDirectory))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "tracked.txt"), "initial\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "staged.txt"), "initial\n"))
      yield* Effect.promise(() => $`git add packages/tracked.txt packages/staged.txt`.cwd(source).quiet())
      yield* Effect.promise(() => $`git commit -m packages`.cwd(source).quiet())
      const destination = abs(`${root.path}-move-nested-destination`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(destination, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${destination} HEAD`.cwd(source).quiet())
      const moved = abs(path.join(yield* Effect.promise(() => fs.realpath(destination)), "packages"))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "tracked.txt"), "changed\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "staged.txt"), "staged\n"))
      yield* Effect.promise(() => $`git add packages/staged.txt`.cwd(source).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "untracked.txt"), "new\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "unrelated\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "untracked.txt"), "unrelated\n"))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_nested_checkout")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "move-nested-checkout",
          directory: sourceDirectory,
          title: "move nested checkout",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: moved }, moveChanges: true }),
      )

      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "tracked.txt"), "utf8"))).toBe("changed\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "staged.txt"), "utf8"))).toBe("staged\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "untracked.txt"), "utf8"))).toBe("new\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(sourceDirectory, "tracked.txt"), "utf8"))).toBe(
        "initial\n",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(sourceDirectory, "untracked.txt")).exists())).toBe(false)
      expect(yield* Effect.promise(() => fs.readFile(path.join(sourceDirectory, "staged.txt"), "utf8"))).toBe(
        "staged\n",
      )
      expect(yield* Effect.promise(() => $`git status --porcelain -- packages/staged.txt`.cwd(source).text())).toBe(
        "M  packages/staged.txt\n",
      )
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("unrelated\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "untracked.txt"), "utf8"))).toBe("unrelated\n")
    }),
    10_000,
  )

  it.live("moves a session family across projects without transferring changes", () =>
    Effect.gen(function* () {
      const sourceRoot = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const destinationRoot = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(sourceRoot.path))
      yield* Effect.promise(() => initRepo(destinationRoot.path))
      yield* Effect.promise(() =>
        $`git remote add origin https://example.com/source-cross-project.git`.cwd(sourceRoot.path).quiet(),
      )
      yield* Effect.promise(() =>
        $`git remote add origin https://example.com/destination-cross-project.git`.cwd(destinationRoot.path).quiet(),
      )
      const source = abs(yield* Effect.promise(() => fs.realpath(sourceRoot.path)))
      const destination = abs(yield* Effect.promise(() => fs.realpath(destinationRoot.path)))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "changed\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "untracked.txt"), "new\n"))

      const sourceProjectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const destinationProjectID = (yield* Project.Service.use((service) => service.resolve(destination))).id
      const sessionID = SessionV2.ID.make("ses_cross_project")
      const childID = SessionV2.ID.make("ses_cross_project_child")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values([
          { id: sourceProjectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 },
          { id: destinationProjectID, worktree: destination, sandboxes: [], time_created: 1, time_updated: 1 },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values([
          {
            id: sessionID,
            project_id: sourceProjectID,
            slug: "cross-project",
            directory: source,
            title: "cross project",
            version: "test",
            time_created: 1,
            time_updated: 1,
          },
          {
            id: childID,
            project_id: sourceProjectID,
            parent_id: sessionID,
            slug: "cross-project-child",
            directory: source,
            title: "cross project child",
            version: "test",
            time_created: 1,
            time_updated: 1,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const result = yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: destination }, moveChanges: false }),
      )

      expect(result).toEqual({
        sessionIDs: [sessionID, childID],
        directory: destination,
        projectID: destinationProjectID,
        subdirectory: RelativePath.make(""),
      })
      expect(yield* Effect.promise(() => fs.readFile(path.join(destination, "tracked.txt"), "utf8"))).toBe("initial\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("changed\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "untracked.txt"), "utf8"))).toBe("new\n")
      expect(
        yield* db
          .select({
            id: SessionTable.id,
            projectID: SessionTable.project_id,
            directory: SessionTable.directory,
            path: SessionTable.path,
          })
          .from(SessionTable)
          .where(eq(SessionTable.project_id, destinationProjectID))
          .orderBy(SessionTable.id)
          .all(),
      ).toEqual([
        { id: sessionID, projectID: destinationProjectID, directory: destination, path: "" },
        { id: childID, projectID: destinationProjectID, directory: destination, path: "" },
      ])
    }),
    10_000,
  )

  it.live("blocks moving a session family when a child activity is active", () =>
    Effect.gen(function* () {
      const sourceRoot = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const destinationRoot = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(sourceRoot.path))
      yield* Effect.promise(() => initRepo(destinationRoot.path))
      yield* Effect.promise(() =>
        $`git remote add origin https://example.com/source-active-family.git`.cwd(sourceRoot.path).quiet(),
      )
      yield* Effect.promise(() =>
        $`git remote add origin https://example.com/destination-active-family.git`.cwd(destinationRoot.path).quiet(),
      )
      const source = abs(yield* Effect.promise(() => fs.realpath(sourceRoot.path)))
      const destination = abs(yield* Effect.promise(() => fs.realpath(destinationRoot.path)))
      const sourceProjectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const destinationProjectID = (yield* Project.Service.use((service) => service.resolve(destination))).id
      const sessionID = SessionV2.ID.make("ses_active_family")
      const childID = SessionV2.ID.make("ses_active_family_child")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values([
          { id: sourceProjectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 },
          { id: destinationProjectID, worktree: destination, sandboxes: [], time_created: 1, time_updated: 1 },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values([
          {
            id: sessionID,
            project_id: sourceProjectID,
            slug: "active-family",
            directory: source,
            title: "active family",
            version: "test",
            time_created: 1,
            time_updated: 1,
          },
          {
            id: childID,
            project_id: sourceProjectID,
            parent_id: sessionID,
            slug: "active-family-child",
            directory: source,
            title: "active family child",
            version: "test",
            time_created: 1,
            time_updated: 1,
          },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* SessionActivity.Service.use((service) =>
        service.open({ sessionID: childID, kind: "prompt", ownerID: "test-owner", openedSeq: 1 }),
      )

      const error = yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: destination } }).pipe(Effect.flip),
      )

      expect(error).toBeInstanceOf(MoveSession.ActiveSessionError)
      expect(
        yield* db
          .select({ projectID: SessionTable.project_id, directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ projectID: sourceProjectID, directory: source })
    }),
    10_000,
  )

  it.live("moves a session whose activity lease expired", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const destination = abs(`${root.path}-stale-lease-destination`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(destination, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${destination} HEAD`.cwd(root.path).quiet())
      const moved = abs(yield* Effect.promise(() => fs.realpath(destination)))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_stale_lease")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "move-stale-lease",
          directory: source,
          title: "move stale lease",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      const opened = yield* SessionActivity.Service.use((service) =>
        service.open({ sessionID, kind: "prompt", ownerID: "test-owner", openedSeq: 1 }),
      )
      yield* db
        .update(SessionActivityTable)
        .set({ lease_until: Date.now() - 1_000, time_updated: Date.now() })
        .where(eq(SessionActivityTable.id, opened.id))
        .run()
        .pipe(Effect.orDie)

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: moved } }),
      )

      expect(
        yield* db
          .select({ projectID: SessionTable.project_id, directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ projectID: projectID, directory: moved })
    }),
    10_000,
  )

  it.live("moves a session whose activity has no lease", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const destination = abs(`${root.path}-null-lease-destination`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(destination, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${destination} HEAD`.cwd(root.path).quiet())
      const moved = abs(yield* Effect.promise(() => fs.realpath(destination)))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_null_lease")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "move-null-lease",
          directory: source,
          title: "move null lease",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      const opened = yield* SessionActivity.Service.use((service) =>
        service.open({ sessionID, kind: "prompt", ownerID: "test-owner", openedSeq: 1 }),
      )
      yield* db
        .update(SessionActivityTable)
        .set({ lease_until: null, time_updated: Date.now() })
        .where(eq(SessionActivityTable.id, opened.id))
        .run()
        .pipe(Effect.orDie)

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: moved } }),
      )

      expect(
        yield* db
          .select({ projectID: SessionTable.project_id, directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ projectID: projectID, directory: moved })
    }),
    10_000,
  )

  it.live("canonicalizes a non-canonical destination directory", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const destination = abs(`${root.path}-canonical-destination`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(destination, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${destination} HEAD`.cwd(root.path).quiet())
      const moved = abs(yield* Effect.promise(() => fs.realpath(destination)))
      // Windows is case-insensitive: a lowercased destination must still land on the real
      // on-disk casing. POSIX has no casing drift, so only the redundant segments are exercised.
      const requested =
        process.platform === "win32"
          ? abs(`${moved}\\sub\\..`.toLowerCase())
          : abs(path.join(moved, "sub", ".."))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_canonical_destination")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "move-canonical-destination",
          directory: source,
          title: "move canonical destination",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      const result = yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: requested } }),
      )

      expect(result.directory).toBe(moved)
      expect(
        yield* db
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ directory: moved })
    }),
    10_000,
  )
})
