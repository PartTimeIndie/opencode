import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@opencode-ai/core/git"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectDirectoryTable, ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectCopy } from "@opencode-ai/core/project/copy"
import { makeIsolatedWorkspaceStrategy } from "@opencode-ai/core/project/copy-strategies"
import { Config } from "@opencode-ai/core/config"
import { ConfigCapabilities } from "@opencode-ai/core/config/capabilities"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const databaseLayer = Database.layerFromPath(":memory:")
const eventLayer = EventV2.layer.pipe(Layer.provide(databaseLayer))
const directoriesLayer = ProjectDirectories.layer.pipe(Layer.provide(databaseLayer))
const copyLayer = ProjectCopy.layer.pipe(
  Layer.provide(databaseLayer),
  Layer.provide(directoriesLayer),
  Layer.provide(eventLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
)
const it = testEffect(Layer.mergeAll(copyLayer, databaseLayer, eventLayer, directoriesLayer))
const isolatedConfig = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({ capabilities: new ConfigCapabilities.Info({ isolated_workspaces: true }) }),
        }),
      ]),
  }),
)
const isolatedCopyLayer = ProjectCopy.layer.pipe(
  Layer.provide(databaseLayer),
  Layer.provide(directoriesLayer),
  Layer.provide(eventLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(isolatedConfig),
)
const isolatedIt = testEffect(
  Layer.mergeAll(isolatedCopyLayer, databaseLayer, eventLayer, directoriesLayer, isolatedConfig),
)

function abs(input: string) {
  return AbsolutePath.make(input)
}

const gitWorktree = ProjectCopy.StrategyID.make("git_worktree")

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@opencode.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await $`git commit --allow-empty -m root`.cwd(directory).quiet()
}

function setup() {
  return Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    yield* Effect.promise(() => initRepo(root.path))
    const sourceDirectory = abs(yield* Effect.promise(() => fs.realpath(root.path)))
    const projectID = Project.ID.make("copy-project")
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: sourceDirectory, sandboxes: [], time_created: 1, time_updated: 1 })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(ProjectDirectoryTable)
      .values({ project_id: projectID, directory: sourceDirectory })
      .run()
      .pipe(Effect.orDie)
    return { root, sourceDirectory, projectID, db }
  })
}

function stored(projectID: Project.ID) {
  return Database.Service.use(({ db }) =>
    db
      .select({ directory: ProjectDirectoryTable.directory, strategy: ProjectDirectoryTable.strategy })
      .from(ProjectDirectoryTable)
      .where(eq(ProjectDirectoryTable.project_id, projectID))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.toSorted((a, b) => a.directory.localeCompare(b.directory))),
      ),
  )
}

describe("ProjectCopy", () => {
  testEffect(Layer.empty).live("unchanged discovery stays read-only while another connection owns the writer", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const filename = path.join(directory.path, "refresh.db")
      const database = Database.layerFromPath(filename)
      const events = EventV2.layer.pipe(Layer.provide(database))
      const directories = ProjectDirectories.layer.pipe(Layer.provide(database))
      const copies = ProjectCopy.layer.pipe(
        Layer.provide(database), Layer.provide(events), Layer.provide(directories),
        Layer.provide(FSUtil.defaultLayer), Layer.provide(Git.defaultLayer),
      )
      yield* Effect.gen(function* () {
        const input = yield* setup()
        yield* input.db.run("PRAGMA busy_timeout = 10").pipe(Effect.orDie)
        const sqlite = yield* Effect.promise(() => import("bun:sqlite"))
        const writer = yield* Effect.acquireRelease(
          Effect.sync(() => new sqlite.Database(filename)),
          (connection) => Effect.sync(() => connection.close()),
        )
        writer.run("BEGIN IMMEDIATE")
        const result = yield* (yield* ProjectCopy.Service).refresh({ projectID: input.projectID }).pipe(Effect.exit)
        expect(Exit.isSuccess(result)).toBe(true)
        if (Exit.isSuccess(result)) expect(result.value).toEqual({ updated: [], removed: [] })
        expect(writer.inTransaction).toBe(true)
        writer.run("ROLLBACK")
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(database, events, directories, copies)))
    }),
  )

  isolatedIt.live("registers isolated workspace creation only when the capability is enabled", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const result = yield* copy.create({
        projectID: input.projectID,
        strategy: ProjectCopy.StrategyID.make("isolated_cow"),
        sourceDirectory: input.sourceDirectory,
        directory: abs(path.dirname(input.root.path)),
        name: `${path.basename(input.root.path)}-capability-isolated`,
      })
      yield* Effect.addFinalizer(() =>
        copy.remove({ projectID: input.projectID, directory: result.directory, force: true }).pipe(Effect.ignore),
      )
      expect(result).toMatchObject({ requestedStrategy: "isolated_cow" })
    }),
  )

  it.effect("accepts arbitrary non-empty strategy ids", () =>
    Effect.sync(() => {
      expect(String(ProjectCopy.StrategyID.make("acme/snapshot"))).toBe("acme/snapshot")
      expect(() => ProjectCopy.StrategyID.make("  acme/snapshot  ")).toThrow()
      expect(() => ProjectCopy.StrategyID.make("   ")).toThrow()
    }),
  )

  it.effect("rejects duplicate strategies and reports unavailable ids", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const strategy: ProjectCopy.Strategy = {
        id: ProjectCopy.StrategyID.make("test/duplicate"),
        create: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
        list: () => Effect.succeed([]),
      }

      yield* copy.register(strategy)
      expect(yield* copy.register(strategy).pipe(Effect.flip)).toBeInstanceOf(ProjectCopy.DuplicateStrategyError)

      const unavailable = ProjectCopy.StrategyID.make("acme/missing")
      const error = yield* copy
        .create({
          projectID: input.projectID,
          strategy: unavailable,
          sourceDirectory: input.sourceDirectory,
          directory: abs(`${input.root.path}-missing-strategy`),
          name: "copy",
        })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(ProjectCopy.StrategyUnavailableError)
      if (error instanceof ProjectCopy.StrategyUnavailableError) expect(error.strategy).toBe(unavailable)
    }),
  )

  it.live("creates and removes a git worktree directory", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const events = yield* EventV2.Service
      const temp = yield* Effect.promise(() => fs.realpath(path.dirname(input.root.path)))
      const parent = abs(path.join(temp, path.basename(input.root.path) + "-copy-created"))
      const target = abs(path.join(parent, "copy"))
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(parent, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const fiber = yield* events
        .subscribe(ProjectCopy.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      const created = yield* copy.create({
        projectID: input.projectID,
        strategy: gitWorktree,
        sourceDirectory: input.sourceDirectory,
        directory: parent,
        name: "copy",
      })
      expect(created.directory).toBe(target)
      expect(yield* stored(input.projectID)).toEqual(
        [
          { directory: input.sourceDirectory, strategy: null },
          { directory: created.directory, strategy: "git_worktree" },
        ].toSorted((a, b) => a.directory.localeCompare(b.directory)),
      )
      expect(Array.from(yield* Fiber.join(fiber))[0]?.data).toEqual({ projectID: input.projectID })

      yield* copy.remove({ projectID: input.projectID, directory: created.directory, force: false })

      expect(yield* stored(input.projectID)).toEqual([{ directory: input.sourceDirectory, strategy: null }])
      expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
    }),
  )

  it.live("requires force to remove a dirty git worktree", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const temp = yield* Effect.promise(() => fs.realpath(path.dirname(input.root.path)))
      const parent = abs(path.join(temp, path.basename(input.root.path) + "-copy-dirty"))
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(parent, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const created = yield* copy.create({
        projectID: input.projectID,
        strategy: gitWorktree,
        sourceDirectory: input.sourceDirectory,
        directory: parent,
        name: "copy",
      })
      yield* Effect.promise(() => Bun.write(path.join(created.directory, "dirty.txt"), "dirty"))

      const error = yield* copy
        .remove({ projectID: input.projectID, directory: created.directory, force: false })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(Git.WorktreeError)
      if (error instanceof Git.WorktreeError) {
        expect(error.operation).toBe("remove")
        expect(error.forceRequired).toBe(true)
      }
      expect(yield* stored(input.projectID)).toContainEqual({ directory: created.directory, strategy: "git_worktree" })
      expect(yield* Effect.promise(() => Bun.file(path.join(created.directory, "dirty.txt")).exists())).toBe(true)

      yield* copy.remove({ projectID: input.projectID, directory: created.directory, force: true })
      expect(yield* Effect.promise(() => Bun.file(created.directory).exists())).toBe(false)
    }),
  )

  it.live("preserves copies whose stored strategy is unavailable", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const unavailable = abs(`${input.root.path}-copy-unavailable`)
      yield* Effect.promise(() => fs.mkdir(unavailable))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(unavailable, { recursive: true, force: true })))
      yield* input.db
        .insert(ProjectDirectoryTable)
        .values({ project_id: input.projectID, directory: unavailable, strategy: "acme/missing" })
        .run()
        .pipe(Effect.orDie)

      const error = yield* copy
        .remove({ projectID: input.projectID, directory: unavailable, force: false })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(ProjectCopy.StrategyUnavailableError)
      expect(yield* stored(input.projectID)).toContainEqual({ directory: unavailable, strategy: "acme/missing" })
    }),
  )

  it.live("adds a numeric suffix when a copy directory already exists", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const temp = yield* Effect.promise(() => fs.realpath(path.dirname(input.root.path)))
      const parent = abs(path.join(temp, path.basename(input.root.path) + "-copy-suffix"))
      const target = abs(path.join(parent, "copy-3"))
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(parent, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => fs.mkdir(path.join(parent, "copy"), { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(path.join(parent, "copy-2")))

      const created = yield* copy.create({
        projectID: input.projectID,
        strategy: gitWorktree,
        sourceDirectory: input.sourceDirectory,
        directory: parent,
        name: "copy",
      })

      expect(created.directory).toBe(target)
      expect(yield* Effect.promise(() => fs.stat(path.join(parent, "copy")).then((item) => item.isDirectory()))).toBe(
        true,
      )
      expect(yield* Effect.promise(() => fs.stat(path.join(parent, "copy-2")).then((item) => item.isDirectory()))).toBe(
        true,
      )

      yield* copy.remove({ projectID: input.projectID, directory: created.directory, force: false })
    }),
  )

  it.live("fails after ten copy directory conflicts", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const temp = yield* Effect.promise(() => fs.realpath(path.dirname(input.root.path)))
      const parent = abs(path.join(temp, path.basename(input.root.path) + "-copy-conflicts"))
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(parent, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 10 }, (_, index) =>
            fs.mkdir(path.join(parent, index === 0 ? "copy" : `copy-${index + 1}`), { recursive: true }),
          ),
        ),
      )

      const error = yield* copy
        .create({
          projectID: input.projectID,
          strategy: gitWorktree,
          sourceDirectory: input.sourceDirectory,
          directory: parent,
          name: "copy",
        })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(ProjectCopy.DestinationExistsError)
      if (error instanceof ProjectCopy.DestinationExistsError)
        expect(error.directory).toBe(abs(path.join(parent, "copy-10")))
    }),
  )

  it.live("does not publish an event when refresh finds no directory changes", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const events = yield* EventV2.Service
      const event = yield* events.subscribe(ProjectCopy.Event.Updated).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
        Effect.flatMap((fiber) =>
          Effect.gen(function* () {
            yield* Effect.yieldNow
            yield* copy.refresh({ projectID: input.projectID })
            return yield* Fiber.join(fiber).pipe(Effect.timeoutOption("50 millis"))
          }),
        ),
      )

      expect(event._tag).toBe("None")
    }),
  )

  it.live("refresh discovers and prunes an externally managed git worktree", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const events = yield* EventV2.Service
      const target = abs(`${input.root.path}-copy-external`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(target, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${target} HEAD`.cwd(input.root.path).quiet())
      yield* input.db
        .insert(ProjectDirectoryTable)
        .values({ project_id: input.projectID, directory: target })
        .run()
        .pipe(Effect.orDie)
      const fiber = yield* events
        .subscribe(ProjectCopy.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      const discovered = abs(yield* Effect.promise(() => fs.realpath(target)))
      expect(yield* copy.refresh({ projectID: input.projectID })).toEqual({ updated: [discovered], removed: [] })

      expect(yield* stored(input.projectID)).toEqual(
        [
          { directory: input.sourceDirectory, strategy: null },
          { directory: discovered, strategy: "git_worktree" },
        ].toSorted((a, b) => a.directory.localeCompare(b.directory)),
      )
      expect(Array.from(yield* Fiber.join(fiber))[0]?.data).toEqual({ projectID: input.projectID })

      yield* Effect.promise(() => $`git worktree remove --force ${target}`.cwd(input.root.path).quiet())
      expect(yield* copy.refresh({ projectID: input.projectID })).toEqual({ updated: [], removed: [discovered] })
      expect(yield* stored(input.projectID)).toEqual([{ directory: input.sourceDirectory, strategy: null }])
    }),
  )

  it.live("refresh ignores stale git worktree registrations", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const stale = abs(`${input.root.path}-copy-stale`)
      const target = abs(`${input.root.path}-copy-after-stale`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(target, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${stale} HEAD`.cwd(input.root.path).quiet())
      yield* Effect.promise(() => fs.rm(stale, { recursive: true, force: true }))
      yield* Effect.promise(() => $`git worktree add --detach ${target} HEAD`.cwd(input.root.path).quiet())

      yield* copy.refresh({ projectID: input.projectID })

      const discovered = abs(yield* Effect.promise(() => fs.realpath(target)))
      expect(yield* stored(input.projectID)).toEqual(
        [
          { directory: input.sourceDirectory, strategy: null },
          { directory: discovered, strategy: "git_worktree" },
        ].toSorted((a, b) => a.directory.localeCompare(b.directory)),
      )
    }),
  )

  it.live("refresh ignores existing directories that are no longer git checkouts", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      yield* Effect.promise(() => fs.rm(path.join(input.sourceDirectory, ".git"), { recursive: true }))
      const copy = yield* ProjectCopy.Service

      yield* copy.refresh({ projectID: input.projectID })

      expect(yield* stored(input.projectID)).toEqual([{ directory: input.sourceDirectory, strategy: null }])
    }),
  )

  it.live("refresh with no roots is a no-op", () =>
    Effect.gen(function* () {
      const copy = yield* ProjectCopy.Service

      expect(yield* copy.refresh({ projectID: Project.ID.make("missing-project") })).toEqual({
        updated: [],
        removed: [],
      })
    }),
  )

  it.live("refresh removes missing ordinary checkouts", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const missing = abs(`${input.root.path}-missing-checkout`)
      yield* input.db
        .insert(ProjectDirectoryTable)
        .values({ project_id: input.projectID, directory: missing })
        .run()
        .pipe(Effect.orDie)
      const copy = yield* ProjectCopy.Service

      expect(yield* copy.refresh({ projectID: input.projectID })).toEqual({ updated: [], removed: [missing] })

      expect(yield* stored(input.projectID)).not.toContainEqual({ directory: missing, strategy: null })
    }),
  )

  it.live("hands an owned copy back without deleting its files", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const result = yield* copy.create({
        projectID: input.projectID,
        strategy: gitWorktree,
        sourceDirectory: input.sourceDirectory,
        directory: abs(path.dirname(input.root.path)),
        name: `${path.basename(input.root.path)}-handback`,
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(result.directory, { recursive: true, force: true })).pipe(Effect.ignore),
      )

      yield* copy.handback({ projectID: input.projectID, directory: result.directory })

      expect(yield* Effect.promise(() => fs.stat(result.directory).then((item) => item.isDirectory()))).toBe(true)
      expect(yield* stored(input.projectID)).not.toContainEqual({
        directory: result.directory,
        strategy: "git_worktree",
      })
    }),
  )

  it.live("reports verified reflink isolation and preserves a warm Unity Library without hardlinks", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const source = abs(path.join(root.path, "source"))
          const target = abs(path.join(root.path, "target"))
          yield* Effect.promise(() => fs.mkdir(path.join(source, "Assets"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(source, "ProjectSettings"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(source, "Library"), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(source, "Assets", "Scene.unity"), "scene"))
          yield* Effect.promise(() =>
            fs.writeFile(path.join(source, "ProjectSettings", "ProjectVersion.txt"), "version"),
          )
          yield* Effect.promise(() => fs.writeFile(path.join(source, "Library", "cache"), "cache"))
          const git = yield* Git.Service
          const strategy = makeIsolatedWorkspaceStrategy({
            git,
            canonical: (directory) => Effect.succeed(directory),
            cloneFile: (from, to) => fs.copyFile(from, to),
          })

          const result = yield* strategy.create({ sourceDirectory: source, directory: target })

          expect(result).toMatchObject({
            requestedStrategy: "isolated_cow",
            effectiveStrategy: "isolated_cow",
            isolation: "reflink_copy",
            cow: { attempted: true, achieved: true, verified: true, mechanism: "reflink" },
            safety: { unityLibrary: "reflinked" },
          })
          expect(yield* Effect.promise(() => fs.readFile(path.join(target, "Assets", "Scene.unity"), "utf8"))).toBe(
            "scene",
          )
          expect(yield* Effect.promise(() => fs.readFile(path.join(target, "Library", "cache"), "utf8"))).toBe("cache")
          const sourceCache = yield* Effect.promise(() => fs.stat(path.join(source, "Library", "cache")))
          const targetCache = yield* Effect.promise(() => fs.stat(path.join(target, "Library", "cache")))
          expect(targetCache.ino).not.toBe(sourceCache.ino)
        }).pipe(Effect.provide(Git.defaultLayer)),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("does not report reflink isolation for an empty directory on Windows", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const source = abs(path.join(root.path, "source"))
          const target = abs(path.join(root.path, "target"))
          yield* Effect.promise(() => fs.mkdir(source))
          const git = yield* Git.Service
          const strategy = makeIsolatedWorkspaceStrategy({
            git,
            canonical: (directory) => Effect.succeed(directory),
            platform: "win32",
          })

          const result = yield* strategy.create({ sourceDirectory: source, directory: target })

          expect(result).toMatchObject({
            effectiveStrategy: "isolated_copy",
            isolation: "physical_copy",
            cow: { achieved: false, verified: true, mechanism: "none" },
          })
          expect(result.cow?.reason).toContain("does not guarantee clone semantics on Windows")
        }).pipe(Effect.provide(Git.defaultLayer)),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("falls back to an independent physical copy without registering a worktree", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => initRepo(root.path))
          yield* Effect.promise(() => fs.writeFile(path.join(root.path, "file.txt"), "committed"))
          yield* Effect.promise(() => $`git add file.txt`.cwd(root.path).quiet())
          yield* Effect.promise(() => $`git commit -m file`.cwd(root.path).quiet())
          yield* Effect.promise(() => fs.writeFile(path.join(root.path, "file.txt"), "staged"))
          yield* Effect.promise(() => $`git add file.txt`.cwd(root.path).quiet())
          yield* Effect.promise(() => fs.writeFile(path.join(root.path, "file.txt"), "unstaged"))
          yield* Effect.promise(() => fs.writeFile(path.join(root.path, ".opencode-isolation.json"), "user-owned"))
          const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
          const target = abs(`${root.path}-isolated`)
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => fs.rm(target, { recursive: true, force: true })).pipe(Effect.ignore),
          )
          yield* Effect.addFinalizer(() =>
            Effect.promise(() =>
              fs.rm(path.join(path.dirname(target), `.${path.basename(target)}.opencode-isolation`), {
                recursive: true,
                force: true,
              }),
            ).pipe(Effect.ignore),
          )
          const status = yield* Effect.promise(() => $`git status --short`.cwd(source).text())
          const worktrees = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(source).text())
          const git = yield* Git.Service
          const strategy = makeIsolatedWorkspaceStrategy({
            git,
            canonical: (directory) => Effect.succeed(directory),
            platform: "win32",
          })

          const result = yield* strategy.create({ sourceDirectory: source, directory: target })

          expect(result).toMatchObject({
            requestedStrategy: "isolated_cow",
            effectiveStrategy: "isolated_copy",
            isolation: "physical_copy",
            cow: { attempted: true, achieved: false, verified: true, mechanism: "none" },
            safety: { gitObjects: "independent" },
            fallback: { from: "isolated_cow", to: "isolated_copy" },
          })
          expect(result.cow?.reason).toContain("does not guarantee clone semantics on Windows")
          expect(yield* Effect.promise(() => $`git status --short`.cwd(target).text())).toBe(status)
          expect(yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(source).text())).toBe(worktrees)
          expect(
            yield* Effect.promise(() => fs.stat(path.join(target, ".git")).then((item) => item.isDirectory())),
          ).toBe(true)
          expect(
            yield* Effect.promise(() =>
              fs
                .access(path.join(target, ".git", "objects", "info", "alternates"))
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)
          expect(yield* Effect.promise(() => fs.readFile(path.join(target, ".opencode-isolation.json"), "utf8"))).toBe(
            "user-owned",
          )
          yield* Effect.promise(() => fs.writeFile(path.join(target, "file.txt"), "target-only"))
          expect(yield* Effect.promise(() => fs.readFile(path.join(source, "file.txt"), "utf8"))).toBe("unstaged")
          const removal = yield* strategy.remove({ directory: target, force: false }).pipe(Effect.flip)
          expect(removal).toBeInstanceOf(ProjectCopy.CopyRemovalError)
          if (removal instanceof ProjectCopy.CopyRemovalError) expect(removal.forceRequired).toBe(true)
          expect(yield* Effect.promise(() => fs.stat(target).then((item) => item.isDirectory()))).toBe(true)
          yield* strategy.remove({ directory: target, force: true })
          expect(
            yield* Effect.promise(() =>
              fs
                .stat(target)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)
        }).pipe(Effect.provide(Git.defaultLayer)),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("materializes linked worktree Git metadata into the physical fallback", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => initRepo(root.path))
          yield* Effect.promise(() => fs.writeFile(path.join(root.path, "file.txt"), "committed"))
          yield* Effect.promise(() => $`git add file.txt`.cwd(root.path).quiet())
          yield* Effect.promise(() => $`git commit -m file`.cwd(root.path).quiet())
          const source = abs(`${root.path}-linked-source`)
          const target = abs(`${root.path}-linked-copy`)
          yield* Effect.promise(() => $`git worktree add --detach ${source} HEAD`.cwd(root.path).quiet())
          yield* Effect.gen(function* () {
            yield* Effect.promise(() => fs.writeFile(path.join(source, "file.txt"), "changed"))
            yield* Effect.promise(() => fs.writeFile(path.join(source, "new.txt"), "new"))
            const worktrees = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(root.path).text())
            const git = yield* Git.Service
            const strategy = makeIsolatedWorkspaceStrategy({
              git,
              canonical: (directory) => Effect.succeed(directory),
              cloneFile: () => Promise.reject(new Error("reflink unavailable")),
            })

            const result = yield* strategy.create({ sourceDirectory: source, directory: target })

            expect(result).toMatchObject({ effectiveStrategy: "isolated_copy", isolation: "physical_copy" })
            expect(
              yield* Effect.promise(() => fs.stat(path.join(target, ".git")).then((item) => item.isDirectory())),
            ).toBe(true)
            expect(yield* Effect.promise(() => $`git status --short`.cwd(target).text())).toBe(
              yield* Effect.promise(() => $`git status --short`.cwd(source).text()),
            )
            expect(yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(root.path).text())).toBe(worktrees)
            yield* Effect.acquireUseRelease(
              Effect.promise(() => fs.rename(source, `${source}-offline`)),
              () =>
                Effect.promise(() =>
                  $`git rev-parse --verify HEAD`
                    .cwd(target)
                    .quiet()
                    .then((item) => expect(item.exitCode).toBe(0)),
                ),
              () => Effect.promise(() => fs.rename(`${source}-offline`, source)),
            )
            yield* strategy.remove({ directory: target, force: true })
          }).pipe(
            Effect.ensuring(Effect.promise(() => fs.rm(target, { recursive: true, force: true })).pipe(Effect.ignore)),
            Effect.ensuring(
              Effect.promise(() => $`git worktree remove --force ${source}`.cwd(root.path).quiet()).pipe(Effect.ignore),
            ),
          )
        }).pipe(Effect.provide(Git.defaultLayer)),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("excludes a Unity Library when only the project copy fits", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const source = abs(path.join(root.path, "source"))
          const target = abs(path.join(root.path, "target"))
          yield* Effect.promise(() => fs.mkdir(path.join(source, "Assets"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(source, "ProjectSettings"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(source, "Library"), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(source, "Assets", "Scene.unity"), "x"))
          yield* Effect.promise(() => fs.writeFile(path.join(source, "ProjectSettings", "ProjectVersion.txt"), "x"))
          yield* Effect.promise(() => fs.writeFile(path.join(source, "Library", "cache"), Buffer.alloc(1024 * 1024)))
          const git = yield* Git.Service
          const strategy = makeIsolatedWorkspaceStrategy({
            git,
            canonical: (directory) => Effect.succeed(directory),
            cloneFile: () => Promise.reject(new Error("reflink unavailable")),
            availableBytes: () => Promise.resolve(64 * 1024 * 1024 + 1024),
          })

          const result = yield* strategy.create({ sourceDirectory: source, directory: target })

          expect(result).toMatchObject({
            effectiveStrategy: "isolated_copy",
            isolation: "physical_copy",
            safety: { unityLibrary: "excluded", gitObjects: "not_detected" },
          })
          expect(
            yield* Effect.promise(() =>
              fs
                .access(path.join(target, "Library"))
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)
          yield* strategy.remove({ directory: target, force: true })
        }).pipe(Effect.provide(Git.defaultLayer)),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("materializes alternate Git object stores into the physical fallback", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const provider = path.join(root.path, "provider")
          const source = abs(path.join(root.path, "source"))
          const target = abs(path.join(root.path, "target"))
          yield* Effect.promise(() => fs.mkdir(provider))
          yield* Effect.promise(() => initRepo(provider))
          yield* Effect.promise(() => fs.writeFile(path.join(provider, "file.txt"), "committed"))
          yield* Effect.promise(() => $`git add file.txt`.cwd(provider).quiet())
          yield* Effect.promise(() => $`git commit -m file`.cwd(provider).quiet())
          yield* Effect.promise(() => $`git clone --shared ${provider} ${source}`.cwd(root.path).quiet())
          expect(
            yield* Effect.promise(() =>
              fs
                .access(path.join(source, ".git", "objects", "info", "alternates"))
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(true)
          const git = yield* Git.Service
          const strategy = makeIsolatedWorkspaceStrategy({
            git,
            canonical: (directory) => Effect.succeed(directory),
            cloneFile: () => Promise.reject(new Error("reflink unavailable")),
          })

          const result = yield* strategy.create({ sourceDirectory: source, directory: target })

          expect(result).toMatchObject({ effectiveStrategy: "isolated_copy", safety: { gitObjects: "independent" } })
          expect(
            yield* Effect.promise(() =>
              fs
                .access(path.join(target, ".git", "objects", "info", "alternates"))
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)
          yield* Effect.acquireUseRelease(
            Effect.promise(() => fs.rename(provider, `${provider}-offline`)),
            () =>
              Effect.promise(() =>
                $`git fsck --full`
                  .cwd(target)
                  .quiet()
                  .then((item) => expect(item.exitCode).toBe(0)),
              ),
            () => Effect.promise(() => fs.rename(`${provider}-offline`, provider)),
          )
          yield* strategy.remove({ directory: target, force: true })
        }).pipe(Effect.provide(Git.defaultLayer)),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("cleans an owned copy when final canonicalization fails", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const source = abs(path.join(root.path, "source"))
          const target = abs(path.join(root.path, "target"))
          yield* Effect.promise(() => fs.mkdir(source))
          yield* Effect.promise(() => fs.writeFile(path.join(source, "file.txt"), "content"))
          const git = yield* Git.Service
          const strategy = makeIsolatedWorkspaceStrategy({
            git,
            canonical: (directory) => Effect.fail(new ProjectCopy.DirectoryUnavailableError({ directory })),
            cloneFile: () => Promise.reject(new Error("reflink unavailable")),
          })

          yield* strategy.create({ sourceDirectory: source, directory: target }).pipe(Effect.flip)

          expect(
            yield* Effect.promise(() =>
              fs
                .access(target)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)
          expect(
            yield* Effect.promise(() =>
              fs
                .access(path.join(root.path, ".target.opencode-isolation"))
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)
        }).pipe(Effect.provide(Git.defaultLayer)),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("refuses to delete a replacement directory that does not match its ownership identity", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const source = abs(path.join(root.path, "source"))
          const target = abs(path.join(root.path, "target"))
          const moved = abs(path.join(root.path, "moved"))
          yield* Effect.promise(() => fs.mkdir(source))
          yield* Effect.promise(() => fs.writeFile(path.join(source, "file.txt"), "content"))
          const git = yield* Git.Service
          const strategy = makeIsolatedWorkspaceStrategy({
            git,
            canonical: (directory) => Effect.succeed(directory),
            cloneFile: () => Promise.reject(new Error("reflink unavailable")),
          })
          yield* strategy.create({ sourceDirectory: source, directory: target })
          yield* Effect.promise(() => fs.rename(target, moved))
          yield* Effect.promise(() => fs.mkdir(target))
          yield* Effect.promise(() => fs.writeFile(path.join(target, "sentinel"), "keep"))

          const removal = yield* strategy.remove({ directory: target, force: true }).pipe(Effect.flip)

          expect(removal).toBeInstanceOf(ProjectCopy.DirectoryUnavailableError)
          expect(yield* Effect.promise(() => fs.readFile(path.join(target, "sentinel"), "utf8"))).toBe("keep")
          expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "file.txt"), "utf8"))).toBe("content")
          if (strategy.handback) yield* strategy.handback(target)
        }).pipe(Effect.provide(Git.defaultLayer)),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("allows only one concurrent creator to claim a destination", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const source = abs(path.join(root.path, "source"))
          const target = abs(path.join(root.path, "target"))
          yield* Effect.promise(() => fs.mkdir(source))
          yield* Effect.promise(() => fs.writeFile(path.join(source, "file.txt"), "content"))
          const git = yield* Git.Service
          const strategy = makeIsolatedWorkspaceStrategy({
            git,
            canonical: (directory) => Effect.succeed(directory),
            cloneFile: () => Promise.reject(new Error("reflink unavailable")),
          })

          const results = yield* Effect.all(
            [
              Effect.exit(strategy.create({ sourceDirectory: source, directory: target })),
              Effect.exit(strategy.create({ sourceDirectory: source, directory: target })),
            ],
            { concurrency: "unbounded" },
          )

          expect(results.filter(Exit.isSuccess)).toHaveLength(1)
          expect(results.filter(Exit.isFailure)).toHaveLength(1)
          expect(yield* Effect.promise(() => fs.readFile(path.join(target, "file.txt"), "utf8"))).toBe("content")
          yield* strategy.remove({ directory: target, force: true })
        }).pipe(Effect.provide(Git.defaultLayer)),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )
})
