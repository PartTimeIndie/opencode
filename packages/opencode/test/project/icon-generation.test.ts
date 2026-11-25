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
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import path from "path"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { multicolorIcon, rasterIcon } from "../lib/icon"

const calls: string[] = []
const styles: string[] = []
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
          styles.push(input.style ?? "")
        }),
        () =>
          Effect.sleep(`${delay} millis`).pipe(
            Effect.map(() => ({ data: multicolorIcon(), mime: "image/png" as const, filename: "icon.png" })),
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

function waitForRow(
  id: Project.Info["id"],
  check: (row: typeof ProjectTable.$inferSelect) => boolean,
  attempts = 100,
): Effect.Effect<typeof ProjectTable.$inferSelect, never, Database.Service> {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    for (let attempt = 0; attempt < attempts; attempt++) {
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
      if (row && check(row)) return row
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die(`Project ${id} did not reach the expected row`)
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
      yield* projects.update({ projectID: project.id, icon: { override: rasterIcon(256) } })
      yield* Effect.sleep("150 millis")
      const current = yield* projects.get(project.id)

      expect(current?.icon?.override).toStartWith("data:image/png;base64,")
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

  it.live("stores the two-tone result of the thumbnail and asks for exactly two colors", () =>
    Effect.gen(function* () {
      calls.length = 0
      styles.length = 0
      delay = 30
      globalEnabled = false
      const service = yield* ProjectIconGeneration.Service
      const project = yield* createProject("two-tone")

      yield* service.enqueue(project.id)
      const ready = yield* waitForStatus(project.id, "ready")
      const thumbnail = yield* Effect.promise(() =>
        Effect.runPromise(
          ImageGeneration.thumbnail({ data: multicolorIcon(), mime: "image/png", filename: "icon.png" }, 128),
        ),
      )
      const expected = yield* Effect.promise(() => Effect.runPromise(ImageGeneration.twoTone(thumbnail)))

      expect(calls[0]).toMatch(/exactly two colors/i)
      expect(calls[0]).toMatch(/pure white \(#FFFFFF\)/i)
      expect(calls[0]).toMatch(/no gradients/i)
      expect(styles).toEqual(["flat two-tone vector app icon"])
      expect(ready.icon?.generated).toBe(`data:${expected.mime};base64,${Buffer.from(expected.data).toString("base64")}`)
      expect(ready.icon?.generated).not.toBe(
        `data:${thumbnail.mime};base64,${Buffer.from(thumbnail.data).toString("base64")}`,
      )
    }),
  )

  it.live("asks for one symbol that fits what the project says about itself", () =>
    Effect.gen(function* () {
      calls.length = 0
      delay = 30
      globalEnabled = false
      const service = yield* ProjectIconGeneration.Service
      const project = yield* createProject("with-readme")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(project.worktree, "README.md"),
          [
            "# Patty Ungodliness",
            "",
            "A *cozy* arcade game about a `patty` that **becomes a god**.",
            "",
            "[Website](https://example.com/pu) ![logo](docs/logo.png)",
            "<p>Build <b>burgers</b>, smite hunger.</p>",
            "",
            "```ts",
            'console.log("ignored code")',
            "```",
            "",
            "- Build burgers",
            "- Smite hunger",
          ].join("\n"),
        ),
      )

      yield* service.enqueue(project.id)
      yield* waitForStatus(project.id, "ready")

      expect(calls[0]).toContain(
        'The project says about itself: "Patty Ungodliness A cozy arcade game about a patty that becomes a god. Website Build burgers , smite hunger. Build burgers Smite hunger".',
      )
      expect(calls[0]).toContain(
        "Choose exactly one simple bold symbol that stands for what this project really is or does.",
      )
      expect(calls[0]).toMatch(/exactly two colors/i)
      expect(calls[0]).toMatch(/pure white \(#FFFFFF\)/i)
      expect(calls[0]).not.toMatch(/console\.log|logo\.png|example\.com|<p>|\*\*|```/)
    }),
  )

  it.live("keeps the two-color rules and the neutral fallback when there is no README", () =>
    Effect.gen(function* () {
      calls.length = 0
      delay = 30
      globalEnabled = false
      const service = yield* ProjectIconGeneration.Service
      const project = yield* createProject("without-readme")

      yield* service.enqueue(project.id)
      yield* waitForStatus(project.id, "ready")

      expect(calls[0]).not.toContain("says about itself")
      expect(calls[0]).toContain("Use a neutral software-tool motif.")
      expect(calls[0]).toMatch(/exactly two colors/i)
      expect(calls[0]).toMatch(/pure white \(#FFFFFF\)/i)
      expect(calls[0]).toMatch(/no gradients/i)
    }),
  )

  it.live("reads the lowercase readme fallback and ends a long description at a word boundary", () =>
    Effect.gen(function* () {
      calls.length = 0
      delay = 30
      globalEnabled = false
      const service = yield* ProjectIconGeneration.Service
      const project = yield* createProject("long-readme")
      const words = Array.from({ length: 80 }, (_, index) => `word${index}`).join(" ")
      yield* Effect.promise(() => Bun.write(path.join(project.worktree, "readme.md"), `# Tool\n\n${words}\n`))

      yield* service.enqueue(project.id)
      yield* waitForStatus(project.id, "ready")
      const excerpt = /says about itself: "([^"]*)"/.exec(calls[0])?.[1]

      expect(excerpt).toStartWith("Tool word0 word1 word2")
      expect(excerpt!.length).toBeLessThanOrEqual(240)
      expect(excerpt).toMatch(/\w$/)
    }),
  )

  it.live("init regenerates only generated icons that came from an outdated style", () =>
    Effect.gen(function* () {
      calls.length = 0
      delay = 30
      globalEnabled = true
      const service = yield* ProjectIconGeneration.Service
      const { db } = yield* Database.Service
      const outdated = yield* createProject("outdated")
      const current = yield* createProject("current")
      const manual = yield* createProject("manual")
      const stored = rasterIcon(16)
      const override = rasterIcon(16)
      const seeded = [
        [outdated, "legacy-color", null],
        [current, ProjectIconGeneration.STYLE, null],
        [manual, "legacy-color", override],
      ] as const
      for (const [project, style, manualIcon] of seeded)
        yield* db
          .update(ProjectTable)
          .set({
            icon_generated_url: stored,
            icon_generation_style: style,
            icon_url_override: manualIcon,
            icon_generation_status: "ready",
            icon_generation_attempt: 1,
          })
          .where(eq(ProjectTable.id, project.id))
          .run()

      yield* service.init()
      const regenerated = yield* waitForRow(
        outdated.id,
        (row) => row.icon_generation_attempt === 2 && row.icon_generation_status === "ready",
      )
      yield* Effect.sleep("50 millis")
      const kept = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, current.id)).get()
      const overridden = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, manual.id)).get()

      expect(regenerated.icon_generation_style).toBe(ProjectIconGeneration.STYLE)
      expect(regenerated.icon_generated_url).toStartWith("data:image/png;base64,")
      expect(regenerated.icon_generated_url).not.toBe(stored)
      expect(kept?.icon_generation_attempt).toBe(1)
      expect(kept?.icon_generated_url).toBe(stored)
      expect(overridden?.icon_generation_attempt).toBe(1)
      expect(overridden?.icon_generated_url).toBe(stored)
      expect(overridden?.icon_url_override).toBe(override)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain('"outdated"')
    }),
  )
})
