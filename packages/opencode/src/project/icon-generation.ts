export * as ProjectIconGeneration from "./icon-generation"

import { GlobalBus } from "@/bus/global"
import { Config } from "@/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ImageGeneration } from "@opencode-ai/core/image-generation"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { and, eq, inArray, sql } from "drizzle-orm"
import { Context, Effect, Fiber, Layer, Scope } from "effect"
import path from "path"
import { Project } from "./project"

type Job = { readonly projectID: ProjectV2.ID; readonly attempt: number }

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly enqueue: (projectID: ProjectV2.ID, force?: boolean) => Effect.Effect<Project.Info | undefined, never>
  readonly setMode: (
    projectID: ProjectV2.ID,
    mode: "inherit" | "enabled" | "disabled",
  ) => Effect.Effect<Project.Info | undefined, never>
  readonly reconcileGlobal: (enabled: boolean) => Effect.Effect<void, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectIconGeneration") {}

const manifests = [
  ["package.json", "TypeScript or JavaScript"],
  ["Cargo.toml", "Rust"],
  ["pyproject.toml", "Python"],
  ["go.mod", "Go"],
  ["ProjectSettings/ProjectVersion.txt", "Unity"],
] as const

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const projects = yield* Project.Service
    const config = yield* Config.Service
    const images = yield* ImageGeneration.Service
    const fs = yield* FSUtil.Service
    const scope = yield* Scope.Scope
    const queue: Job[] = []
    const queued = new Set<string>()
    const active = new Map<ProjectV2.ID, () => Effect.Effect<void>>()
    let running = false
    let recovered = false

    const emit = (project: Project.Info) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          project: project.id,
          payload: { type: Project.Event.Updated.type, properties: project },
        }),
      )

    const current = Effect.fnUntraced(function* (projectID: ProjectV2.ID) {
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get().pipe(Effect.orDie)
      return row
    })

    const finish = Effect.fnUntraced(function* (
      job: Job,
      patch: {
        icon_generated_url?: string
        icon_generation_status: "ready" | "failed"
        icon_generation_error?: string | null
      },
    ) {
      const row = yield* db
        .update(ProjectTable)
        .set({ ...patch, icon_generation_completed_at: Date.now(), time_updated: Date.now() })
        .where(
          and(
            eq(ProjectTable.id, job.projectID),
            eq(ProjectTable.icon_generation_attempt, job.attempt),
            eq(ProjectTable.icon_generation_status, "generating"),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (row) yield* emit(Project.fromRow(row))
    })

    const run = Effect.fnUntraced(function* (job: Job) {
      const started = yield* db
        .update(ProjectTable)
        .set({ icon_generation_status: "generating", time_updated: Date.now() })
        .where(
          and(
            eq(ProjectTable.id, job.projectID),
            eq(ProjectTable.icon_generation_attempt, job.attempt),
            eq(ProjectTable.icon_generation_status, "queued"),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!started) return
      yield* emit(Project.fromRow(started))
      const tags = yield* Effect.forEach(manifests, ([file, label]) =>
        fs.exists(path.join(started.worktree, file)).pipe(Effect.map((exists) => (exists ? label : undefined))),
      )
      const name = started.name || path.basename(started.worktree) || "project"
      const folder = path.basename(started.worktree) || "project"
      const technology = tags.filter((tag) => tag !== undefined)
      const prompt = [
        `Create a compact square app icon for a software project named ${JSON.stringify(name)}.`,
        `The project folder is named ${JSON.stringify(folder)}.`,
        `Use a single bold symbolic motif, no text, no letters, no logos, no border, and strong contrast at 16 pixels.`,
        technology.length
          ? `Technology context: ${technology.join(", ")}.`
          : "Use a neutral software-tool motif.",
      ].join(" ")
      const exit = yield* images
        .generate({ prompt, size: "1024x1024", style: "minimal polished software icon", format: "png" })
        .pipe(Effect.exit)
      if (exit._tag === "Failure") {
        yield* finish(job, {
          icon_generation_status: "failed",
          icon_generation_error: "Image generation failed. Verify the Codex CLI login and retry.",
        })
        return
      }
      const normalized = yield* ImageGeneration.thumbnail(exit.value, 128).pipe(Effect.exit)
      if (normalized._tag === "Failure") {
        yield* finish(job, {
          icon_generation_status: "failed",
          icon_generation_error: "The generated image could not be normalized.",
        })
        return
      }
      yield* finish(job, {
        icon_generated_url: `data:${normalized.value.mime};base64,${Buffer.from(normalized.value.data).toString("base64")}`,
        icon_generation_status: "ready",
        icon_generation_error: null,
      })
    })

    const drain = (): Effect.Effect<void> =>
      Effect.suspend(() => {
        const job = queue.shift()
        if (!job) {
          running = false
          return Effect.void
        }
        queued.delete(job.projectID)
        return Effect.gen(function* () {
          const fiber = yield* run(job).pipe(Effect.orDie, Effect.forkIn(scope))
          active.set(job.projectID, () => Fiber.interrupt(fiber).pipe(Effect.asVoid))
          yield* Fiber.await(fiber)
          active.delete(job.projectID)
          yield* drain()
        })
      })

    const enqueue = Effect.fn("ProjectIconGeneration.enqueue")(function* (
      projectID: ProjectV2.ID,
      force = false,
      automatic = false,
    ) {
      if (projectID === "global") return undefined
      const row = yield* current(projectID)
      if (!row) return undefined
      if (automatic && row.icon_generation_status === "failed") return Project.fromRow(row)
      if (!force && (row.icon_url_override || (row.icon_url && !row.icon_color))) return Project.fromRow(row)
      if (!force && row.icon_generated_url) return Project.fromRow(row)
      if (!force && (queued.has(projectID) || active.has(projectID))) return Project.fromRow(row)
      if (force) {
        const queuedIndex = queue.findIndex((job) => job.projectID === projectID)
        if (queuedIndex >= 0) queue.splice(queuedIndex, 1)
        queued.delete(projectID)
        const interrupt = active.get(projectID)
        if (interrupt) yield* interrupt()
      }
      const admitted = yield* db
        .update(ProjectTable)
        .set({
          icon_generation_attempt: sql`${ProjectTable.icon_generation_attempt} + 1`,
          icon_generation_status: "queued",
          icon_generation_error: null,
          icon_generation_attempted_at: Date.now(),
          icon_generation_completed_at: null,
          time_updated: Date.now(),
        })
        .where(and(eq(ProjectTable.id, projectID), eq(ProjectTable.icon_generation_attempt, row.icon_generation_attempt)))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!admitted) return undefined
      queue.push({ projectID, attempt: admitted.icon_generation_attempt })
      queued.add(projectID)
      yield* emit(Project.fromRow(admitted))
      if (!running) {
        running = true
        yield* drain().pipe(Effect.forkIn(scope))
      }
      return Project.fromRow(admitted)
    })

    const cancel = Effect.fnUntraced(function* (projectID: ProjectV2.ID) {
      const before = yield* current(projectID)
      if (!before) return undefined
      if (!queued.has(projectID) && !active.has(projectID) && !["queued", "generating"].includes(before.icon_generation_status ?? ""))
        return Project.fromRow(before)
      const row = yield* db
        .update(ProjectTable)
        .set({
          icon_generation_attempt: sql`${ProjectTable.icon_generation_attempt} + 1`,
          icon_generation_status: "idle",
          icon_generation_error: null,
          icon_generation_completed_at: null,
          time_updated: Date.now(),
        })
        .where(eq(ProjectTable.id, projectID))
        .returning()
        .get()
        .pipe(Effect.orDie)
      for (let index = queue.length - 1; index >= 0; index--) {
        if (queue[index]?.projectID === projectID) queue.splice(index, 1)
      }
      queued.delete(projectID)
      const interrupt = active.get(projectID)
      if (interrupt) yield* interrupt()
      if (row) yield* emit(Project.fromRow(row))
      return row ? Project.fromRow(row) : undefined
    })

    const setMode = Effect.fn("ProjectIconGeneration.setMode")(function* (
      projectID: ProjectV2.ID,
      mode: "inherit" | "enabled" | "disabled",
    ) {
      if (!(yield* current(projectID))) return undefined
      const globallyEnabled = (yield* config.get()).project_icon_generation?.enabled ?? false
      if (mode === "disabled" || (mode === "inherit" && !globallyEnabled)) {
        const cancelled = yield* cancel(projectID)
        if (!cancelled) return undefined
      }
      const row = yield* db
        .update(ProjectTable)
        .set({
          icon_generation_mode: mode,
          time_updated: Date.now(),
        })
        .where(eq(ProjectTable.id, projectID))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      yield* emit(Project.fromRow(row))
      if (mode === "enabled" || (mode === "inherit" && globallyEnabled)) return yield* enqueue(projectID)
      return Project.fromRow(row)
    })

    const reconcileGlobal = Effect.fn("ProjectIconGeneration.reconcileGlobal")(function* (enabled: boolean) {
      const list = yield* projects.list()
      yield* Effect.forEach(
        list.filter((project) => project.id !== "global" && (project.iconGeneration?.mode ?? "inherit") === "inherit"),
        (project) => (enabled ? enqueue(project.id, false, true) : cancel(project.id)),
        { concurrency: 1, discard: true },
      )
    })

    const init = Effect.fn("ProjectIconGeneration.init")(function* () {
      if (!recovered) {
        recovered = true
        yield* db
          .update(ProjectTable)
          .set({
            icon_generation_status: "failed",
            icon_generation_error: "Image generation was interrupted by a restart.",
            icon_generation_completed_at: Date.now(),
          })
          .where(inArray(ProjectTable.icon_generation_status, ["queued", "generating"]))
          .run()
          .pipe(Effect.orDie)
      }
      const enabled = (yield* config.get()).project_icon_generation?.enabled ?? false
      const list = yield* projects.list()
      yield* Effect.forEach(
        list.filter((project) => project.id !== "global" && (project.iconGeneration?.mode === "enabled" || (enabled && project.iconGeneration?.mode !== "disabled"))),
        (project) => enqueue(project.id, false, true),
        { concurrency: 1, discard: true },
      )
    })

    return Service.of({
      init: () => init().pipe(Effect.orDie),
      enqueue: (projectID, force) => enqueue(projectID, force).pipe(Effect.orDie),
      setMode: (projectID, mode) => setMode(projectID, mode).pipe(Effect.orDie),
      reconcileGlobal: (enabled) => reconcileGlobal(enabled).pipe(Effect.orDie),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Project.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(ImageGeneration.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export const node = LayerNode.make(layer, [
  Project.node,
  Config.node,
  ImageGeneration.node,
  FSUtil.node,
  Database.node,
])
