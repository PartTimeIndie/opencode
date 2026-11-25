import { describe, expect } from "bun:test"
import { Project } from "@/project/project"
import { ProjectIcon } from "@/project/icon"
import { GlobalBus } from "../../src/bus/global"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectDirectoryIconTable, ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { eq } from "drizzle-orm"
import { Cause, Effect, Exit, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { rasterIcon, rasterSize } from "../lib/icon"

const layer = Layer.mergeAll(Project.defaultLayer, Database.defaultLayer, CrossSpawnSpawner.defaultLayer)
const it = testEffect(layer)

// A valid 1x1 GIF; photon decodes it even though no test fixture ships image tooling.
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"

type ProjectEvent = { payload: { type: string; properties: unknown } }

function collectProjectEvents() {
  return Effect.gen(function* () {
    const events: ProjectEvent[] = []
    const listener = (event: ProjectEvent) => {
      if (event.payload.type.startsWith("project.")) events.push(event)
    }
    GlobalBus.on("event", listener)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
    return events
  })
}

describe("ProjectIcon.normalize", () => {
  it.live("shrinks a large raster upload to a 128px thumbnail", () =>
    Effect.gen(function* () {
      const uploaded = rasterIcon(1024)
      const normalized = yield* ProjectIcon.normalize(uploaded)

      expect(normalized).toStartWith("data:image/png;base64,")
      expect(rasterSize(normalized!)).toEqual({ width: 128, height: 128 })
      expect(normalized!.length).toBeLessThan(uploaded.length / 10)
    }),
  )

  it.live("accepts jpeg and gif uploads and stores them as png thumbnails", () =>
    Effect.gen(function* () {
      for (const uploaded of [rasterIcon(300, "jpeg"), GIF]) {
        const normalized = yield* ProjectIcon.normalize(uploaded)
        expect(normalized).toStartWith("data:image/png;base64,")
        expect(rasterSize(normalized!)).toEqual({ width: 128, height: 128 })
      }
    }),
  )

  it.live("keeps urls, svg, relative values and cleared overrides verbatim", () =>
    Effect.gen(function* () {
      for (const value of [
        "https://example.com/icon.png",
        "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
        "/assets/icon.png",
        "",
      ]) {
        expect(yield* ProjectIcon.normalize(value)).toBe(value)
      }
      expect(yield* ProjectIcon.normalize(undefined)).toBeUndefined()
    }),
  )

  it.live("rejects raster data that cannot be decoded", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(ProjectIcon.normalize("data:image/png;base64,abc123"))
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "Project.InvalidIconError",
        message: "The image could not be decoded or resized. Use a PNG, JPEG, WebP or GIF file.",
      })
    }),
  )
})

describe("Project directory icons", () => {
  it.live("stores, aliases and clears a directory icon and announces every change", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const { db } = yield* Database.Service
      const events = yield* collectProjectEvents()

      const stored = yield* project.setDirectoryIcon({ directory: "c:\\GitRepros\\Skills\\.\\", url: rasterIcon(1024) })
      expect(stored.directory).toBe("c:/gitrepros/skills")
      if (!stored.icon) throw new Error("Expected the saved directory icon")
      expect(rasterSize(stored.icon.override)).toEqual({ width: 128, height: 128 })

      const aliased = yield* project.setDirectoryIcon({ directory: "C:/GITREPROS/SKILLS", url: GIF })
      expect(aliased.directory).toBe("c:/gitrepros/skills")
      expect(yield* db.select().from(ProjectDirectoryIconTable).all()).toHaveLength(1)
      expect((yield* project.directoryIcons()).map((item) => item.directory)).toEqual(["c:/gitrepros/skills"])

      const cleared = yield* project.setDirectoryIcon({ directory: "c:/gitrepros/skills/", url: "" })
      expect(cleared).toEqual({ directory: "c:/gitrepros/skills" })
      expect(yield* project.directoryIcons()).toEqual([])
      expect(
        yield* project.setDirectoryIcon({ directory: "E:\\TFS\\Overpowered", url: "   " }),
      ).toEqual({ directory: "e:/tfs/overpowered" })

      expect(events.map((event) => event.payload.type)).toEqual([
        "project.directoryIcon.updated",
        "project.directoryIcon.updated",
        "project.directoryIcon.updated",
        "project.directoryIcon.updated",
      ])
      const properties = events.map((event) => event.payload.properties) as {
        directory: string
        icon?: { override: string }
      }[]
      expect(properties[0]).toEqual({ directory: "c:/gitrepros/skills", icon: { override: stored.icon.override } })
      expect(properties[1]!.icon!.override).toStartWith("data:image/png;base64,")
      expect(properties[2]).toEqual({ directory: "c:/gitrepros/skills" })
      expect(properties[3]).toEqual({ directory: "e:/tfs/overpowered" })
    }),
  )

  it.live("rejects an undecodable directory icon without changing stored icons", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      yield* project.setDirectoryIcon({ directory: "E:/GitRepros/Skills", url: GIF })
      const exit = yield* Effect.exit(
        project.setDirectoryIcon({ directory: "E:/GitRepros/Skills", url: "data:image/png;base64,abc123" }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "Project.InvalidIconError" })
      expect(yield* project.directoryIcons()).toHaveLength(1)
    }),
  )

  it.live("normalizes the project icon override and keeps the previous one when the upload is invalid", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const { project: created } = yield* project.fromDirectory(tmp)

      const updated = yield* project.update({ projectID: created.id, icon: { override: rasterIcon(1024) } })
      expect(rasterSize(updated.icon!.override!)).toEqual({ width: 128, height: 128 })
      const cleared = yield* project.update({ projectID: created.id, icon: { override: "" } })
      expect(cleared.icon?.override).toBeUndefined()

      const kept = yield* project.update({ projectID: created.id, icon: { override: rasterIcon(1024) } })
      const exit = yield* Effect.exit(
        project.update({ projectID: created.id, icon: { override: "data:image/png;base64,abc123" } }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "Project.InvalidIconError" })
      expect((yield* project.get(created.id))?.icon?.override).toBe(kept.icon?.override)
    }),
  )
})

describe("Project.list", () => {
  it.live("hides projects whose worktree is gone while get keeps them addressable", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const { db } = yield* Database.Service
      const tmp = yield* tmpdirScoped()
      const gone = path.join(tmp, "mirror-workspace")
      yield* Effect.promise(() => fs.mkdir(gone))
      const id = ProjectV2.ID.make("project-gone-worktree")
      const liveID = ProjectV2.ID.make("project-live-worktree")
      yield* db
        .insert(ProjectTable)
        .values([
          {
            id,
            worktree: AbsolutePath.make(gone),
            vcs: "git",
            time_created: Date.now(),
            time_updated: Date.now(),
            sandboxes: [],
          },
          {
            id: liveID,
            worktree: AbsolutePath.make(tmp),
            vcs: "git",
            time_created: Date.now(),
            time_updated: Date.now(),
            sandboxes: [],
          },
          {
            id: ProjectV2.ID.global,
            worktree: AbsolutePath.make("/"),
            time_created: Date.now(),
            time_updated: Date.now(),
            sandboxes: [],
          },
        ])
        .run()
        .pipe(Effect.orDie)
      const before = yield* project.list()
      expect(before.map((item) => item.id)).toContain(id)
      expect(before.map((item) => item.id)).toContain(ProjectV2.ID.global)

      yield* Effect.promise(() => fs.rm(gone, { recursive: true, force: true }))
      yield* db.insert(SessionTable).values({
        id: SessionSchema.ID.make("ses_deleted_mirror"),
        parent_id: SessionSchema.ID.make("ses_parent"),
        project_id: liveID,
        directory: gone,
        slug: "child",
        title: "Child in a deleted mirror",
        version: "test",
        time_created: 1,
        time_updated: 1,
      }).run().pipe(Effect.orDie)

      const listed = yield* project.list()
      expect(listed.map((item) => item.id)).not.toContain(id)
      expect(listed.map((item) => item.id)).toContain(ProjectV2.ID.global)
      expect(listed.find((item) => item.id === liveID)?.sessionDirectories).toEqual([gone])
      expect((yield* project.get(id))?.worktree).toBe(gone)
      yield* db.delete(ProjectTable).where(eq(ProjectTable.id, id)).run().pipe(Effect.orDie)
      yield* db.delete(ProjectTable).where(eq(ProjectTable.id, liveID)).run().pipe(Effect.orDie)
    }),
  )
})

describe("Project.resolveDirectories", () => {
  it.live("reports the real directory, missing folders and the global sentinel in request order", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const root = yield* tmpdirScoped()
      const real = path.join(root, "real", "project")
      yield* Effect.promise(() => fs.mkdir(real, { recursive: true }))
      const link = path.join(root, "link")
      const linked = yield* Effect.promise(() =>
        fs.symlink(path.join(root, "real"), link, process.platform === "win32" ? "junction" : "dir"),
      ).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )
      const missing = path.join(root, "missing")

      const resolved = yield* project.resolveDirectories([
        linked ? path.join(link, "project") : path.join(real, "."),
        missing,
        "global",
      ])

      expect(resolved).toHaveLength(3)
      // Junctions and symlinks resolve to the physical folder; a host that cannot
      // create one still proves "." segments and separators are canonicalized.
      expect(resolved[0]!.real).toBe(real)
      expect(resolved[0]!.exists).toBe(true)
      expect(resolved[1]).toEqual({ directory: missing, real: missing, exists: false })
      expect(resolved[2]).toEqual({ directory: "global", real: "global", exists: true })
    }),
  )
})
