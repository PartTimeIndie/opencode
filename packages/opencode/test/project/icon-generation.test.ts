import { describe, expect } from "bun:test"
import { Config } from "@/config/config"
import { ProjectIconGeneration } from "@/project/icon-generation"
import { Project } from "@/project/project"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ImageGeneration } from "@opencode-ai/core/image-generation"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { PhotonImage } from "@silvia-odwyer/photon-node"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import path from "path"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const calls: string[] = []
let active = 0
let maxActive = 0
let delay = 30
let globalEnabled = false

const image = Layer.succeed(
  ImageGeneration.Service,
  ImageGeneration.Service.of({
    generate: (input) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          active++
          maxActive = Math.max(maxActive, active)
          calls.push(input.prompt)
        }),
        () =>
          Effect.sleep(`${delay} millis`).pipe(
            Effect.map(() => {
              const source = new PhotonImage(new Uint8Array([20, 80, 160, 255]), 1, 1)
              try {
                return { data: source.get_bytes(), mime: "image/png" as const, filename: "icon.png" }
              } finally {
                source.free()
              }
            }),
          ),
        () => Effect.sync(() => active--),
      ),
  }),
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    get: () => Effect.succeed({ project_icon_generation: { enabled: globalEnabled } }),
    getGlobal: () => Effect.succeed({}),
    getConsoleState: () => Effect.succeed({ consoleManagedProviders: [], switchableOrgCount: 0 }),
    update: () => Effect.void,
    updateGlobal: () => Effect.succeed({ info: {}, changed: false }),
    invalidate: () => Effect.void,
    directories: () => Effect.succeed([]),
    waitForDependencies: () => Effect.void,
  }),
)
const icons = ProjectIconGeneration.layer.pipe(
  Layer.provide(Project.defaultLayer),
  Layer.provide(config),
  Layer.provide(image),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Database.defaultLayer),
)
const it = testEffect(
  Layer.mergeAll(Project.defaultLayer, Database.defaultLayer, CrossSpawnSpawner.defaultLayer, config, image, icons),
)

function waitForStatus(
  id: Project.Info["id"],
  status: NonNullable<Project.Info["iconGeneration"]>["status"],
  attempts = 100,
): Effect.Effect<Project.Info, never, Project.Service> {
  return Effect.gen(function* () {
    const projects = yield* Project.Service
    const project = yield* projects.get(id)
    if (!project) return yield* Effect.die(`Project ${id} was not found`)
    if (project.iconGeneration?.status === status) return project
    if (attempts <= 0) return yield* Effect.die(`Project ${id} did not reach ${status}`)
    yield* Effect.sleep("10 millis")
    return yield* waitForStatus(id, status, attempts - 1)
  })
}

function createProject(name: string) {
  return Effect.gen(function* () {
    const projects = yield* Project.Service
    const { db } = yield* Database.Service
    const root = yield* tmpdirScoped()
    const directory = path.join(root, name)
    yield* Effect.promise(() => Bun.$`mkdir -p ${directory}`.quiet())
    const id = ProjectV2.ID.make(`project-icon-${name}`)
    yield* db
      .insert(ProjectTable)
      .values({
        id,
        worktree: AbsolutePath.make(directory),
        vcs: "git",
        name,
        time_created: Date.now(),
        time_updated: Date.now(),
        sandboxes: [],
      })
      .run()
    const project = yield* projects.get(id)
    if (project) return project
    return yield* Effect.die(`Project ${id} was not created`)
  })
}

describe("ProjectIconGeneration", () => {
  it.live("deduplicates admissions and runs projects in FIFO order with concurrency one", () =>
    Effect.gen(function* () {
      calls.length = 0
      active = 0
      maxActive = 0
      delay = 30
      globalEnabled = false
      const service = yield* ProjectIconGeneration.Service
      const first = yield* createProject("first")
      const second = yield* createProject("second")

      yield* Effect.all([service.enqueue(first.id), service.enqueue(first.id), service.enqueue(second.id)], {
        concurrency: "unbounded",
      })
      const readyFirst = yield* waitForStatus(first.id, "ready")
      const readySecond = yield* waitForStatus(second.id, "ready")

      expect(readyFirst.iconGeneration?.attempt).toBe(1)
      expect(readySecond.iconGeneration?.attempt).toBe(1)
      expect(readyFirst.icon?.generated).toStartWith("data:image/png;base64,")
      expect(calls.map((prompt) => prompt.includes('"first"') ? "first" : "second")).toEqual(["first", "second"])
      expect(maxActive).toBe(1)
    }),
  )

  it.live("invalidates a running attempt when a manual icon is saved", () =>
    Effect.gen(function* () {
      delay = 100
      globalEnabled = false
      const service = yield* ProjectIconGeneration.Service
      const projects = yield* Project.Service
      const project = yield* createProject("manual-wins")

      yield* service.enqueue(project.id)
      yield* waitForStatus(project.id, "generating")
      yield* projects.update({ projectID: project.id, icon: { override: "data:image/png;base64,manual" } })
      yield* Effect.sleep("150 millis")
      const current = yield* projects.get(project.id)

      expect(current?.icon?.override).toBe("data:image/png;base64,manual")
      expect(current?.icon?.generated).toBeUndefined()
      expect(current?.iconGeneration?.status).toBe("idle")
    }),
  )

  it.live("aborts inherited work when the global setting is disabled", () =>
    Effect.gen(function* () {
      delay = 100
      globalEnabled = false
      const service = yield* ProjectIconGeneration.Service
      const project = yield* createProject("disabled")

      yield* service.enqueue(project.id)
      yield* waitForStatus(project.id, "generating")
      yield* service.reconcileGlobal(false)
      const current = yield* waitForStatus(project.id, "idle")

      expect(current.icon?.generated).toBeUndefined()
      expect(current.iconGeneration?.attempt).toBe(2)
    }),
  )

  it.live("force regeneration invalidates the running attempt before publishing the replacement", () =>
    Effect.gen(function* () {
      calls.length = 0
      delay = 100
      globalEnabled = false
      const service = yield* ProjectIconGeneration.Service
      const project = yield* createProject("force-regenerate")

      yield* service.enqueue(project.id)
      yield* waitForStatus(project.id, "generating")
      yield* service.enqueue(project.id, true)
      const ready = yield* waitForStatus(project.id, "ready")

      expect(ready.iconGeneration?.attempt).toBe(2)
      expect(ready.icon?.generated).toStartWith("data:image/png;base64,")
      expect(calls).toHaveLength(2)
    }),
  )

  it.live("marks orphaned queued work failed during restart recovery", () =>
    Effect.gen(function* () {
      const service = yield* ProjectIconGeneration.Service
      const { db } = yield* Database.Service
      const project = yield* createProject("restart")
      globalEnabled = true
      yield* db
        .update(ProjectTable)
        .set({ icon_generation_status: "queued", icon_generation_attempt: 3 })
        .where(eq(ProjectTable.id, project.id))
        .run()
      yield* service.init()

      const recovered = yield* waitForStatus(project.id, "failed")
      yield* Effect.sleep("50 millis")
      expect(recovered.iconGeneration?.error).toContain("interrupted")
      expect(recovered.iconGeneration?.attempt).toBe(3)
      expect((yield* (yield* Project.Service).get(project.id))?.iconGeneration?.status).toBe("failed")
    }),
  )
})
