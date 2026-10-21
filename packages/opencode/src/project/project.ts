import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { and, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectDirectoryTable, ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Flag } from "@opencode-ai/core/flag/flag"
import { GlobalBus } from "@/bus/global"
import { which } from "@opencode-ai/core/util/which"
import { Command } from "@/command"
import { InstanceState } from "@/effect/instance-state"
import { Cause, DateTime, Effect, Layer, Scope, Context, Stream, Types, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { ProjectV2 } from "@opencode-ai/core/project"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AbsolutePath, NonNegativeInt, optionalOmitUndefined } from "@opencode-ai/core/schema"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/core/session/event"

const ProjectVcs = Schema.Literal("git")

const isDatabaseLockCause = (cause: Cause.Cause<unknown>) =>
  /database is locked|database table is locked|locktimeouterror|sqlite_busy/i.test(Cause.pretty(cause))

const ProjectIcon = Schema.Struct({
  url: optionalOmitUndefined(Schema.String),
  override: optionalOmitUndefined(Schema.String),
  color: optionalOmitUndefined(Schema.String),
  generated: optionalOmitUndefined(Schema.String),
})

const ProjectIconGeneration = Schema.Struct({
  mode: optionalOmitUndefined(Schema.Literals(["inherit", "enabled", "disabled"])),
  status: optionalOmitUndefined(Schema.Literals(["idle", "queued", "generating", "ready", "failed"])),
  error: optionalOmitUndefined(Schema.String),
  attempt: NonNegativeInt,
  attemptedAt: optionalOmitUndefined(NonNegativeInt),
  completedAt: optionalOmitUndefined(NonNegativeInt),
})

const ProjectCommands = Schema.Struct({
  start: optionalOmitUndefined(
    Schema.String.annotate({ description: "Startup script to run when creating a new workspace (worktree)" }),
  ),
})

const ProjectTime = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  initialized: optionalOmitUndefined(NonNegativeInt),
})

export const Info = Schema.Struct({
  id: ProjectV2.ID,
  worktree: Schema.String,
  vcs: optionalOmitUndefined(ProjectVcs),
  name: optionalOmitUndefined(Schema.String),
  icon: optionalOmitUndefined(ProjectIcon),
  iconGeneration: optionalOmitUndefined(ProjectIconGeneration),
  commands: optionalOmitUndefined(ProjectCommands),
  time: ProjectTime,
  sandboxes: Schema.Array(Schema.String),
}).annotate({ identifier: "Project" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const Event = {
  Updated: EventV2.define({ type: "project.updated", schema: Info.fields }),
}

type Row = typeof ProjectTable.$inferSelect

export function fromRow(row: Row): Info {
  const icon =
    row.icon_url || row.icon_url_override || row.icon_color || row.icon_generated_url
      ? {
          url: row.icon_url ?? undefined,
          override: row.icon_url_override ?? undefined,
          color: row.icon_color ?? undefined,
          generated: row.icon_generated_url ?? undefined,
        }
      : undefined
  return {
    id: row.id,
    worktree: row.worktree,
    vcs: row.vcs ? Schema.decodeUnknownSync(ProjectVcs)(row.vcs) : undefined,
    name: row.name ?? undefined,
    icon,
    iconGeneration: {
      mode: row.icon_generation_mode ?? undefined,
      status: row.icon_generation_status ?? undefined,
      error: row.icon_generation_error ?? undefined,
      attempt: row.icon_generation_attempt,
      attemptedAt: row.icon_generation_attempted_at ?? undefined,
      completedAt: row.icon_generation_completed_at ?? undefined,
    },
    time: {
      created: row.time_created,
      updated: row.time_updated,
      initialized: row.time_initialized ?? undefined,
    },
    sandboxes: row.sandboxes,
    commands: row.commands ?? undefined,
  }
}

export const UpdateInput = Schema.Struct({
  projectID: ProjectV2.ID,
  name: Schema.optional(Schema.String),
  icon: Schema.optional(ProjectIcon),
  iconGeneration: Schema.optional(Schema.Struct({ mode: ProjectIconGeneration.fields.mode })),
  commands: Schema.optional(ProjectCommands),
})
export type UpdateInput = Types.DeepMutable<Schema.Schema.Type<typeof UpdateInput>>

export const UpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  icon: Schema.optional(ProjectIcon),
  iconGeneration: Schema.optional(Schema.Struct({ mode: ProjectIconGeneration.fields.mode })),
  commands: Schema.optional(ProjectCommands),
}).annotate({ identifier: "ProjectUpdateInput" })
export type UpdatePayload = Types.DeepMutable<Schema.Schema.Type<typeof UpdatePayload>>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Project.NotFoundError", {
  projectID: ProjectV2.ID,
}) {}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export interface Interface {
  /**
   * Per-instance setup. Subscribes to the `/init` slash command for the
   * current instance and stamps the project's initialized timestamp when it
   * fires. Subscription lifetime is tied to the per-instance state scope.
   */
  readonly init: () => Effect.Effect<void>
  readonly fromDirectory: (directory: string) => Effect.Effect<{ project: Info; sandbox: string }>
  readonly discover: (input: Info) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: ProjectV2.ID) => Effect.Effect<Info | undefined>
  readonly update: (input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  readonly initGit: (input: { directory: string; project: Info }) => Effect.Effect<Info>
  readonly setInitialized: (id: ProjectV2.ID) => Effect.Effect<void>
  readonly sandboxes: (id: ProjectV2.ID) => Effect.Effect<string[]>
  readonly addSandbox: (id: ProjectV2.ID, directory: string) => Effect.Effect<void>
  readonly removeSandbox: (id: ProjectV2.ID, directory: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Project") {}

type GitResult = { code: number; text: string; stderr: string }

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const proc = yield* AppProcess.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const projectV2 = yield* ProjectV2.Service
    const projectDirectories = yield* ProjectDirectories.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const { db } = yield* Database.Service

    const git = Effect.fnUntraced(
      function* (args: string[], opts?: { cwd?: string }) {
        const handle = yield* spawner.spawn(
          ChildProcess.make("git", args, { cwd: opts?.cwd, extendEnv: true, stdin: "ignore" }),
        )
        const [text, stderr] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
          { concurrency: 2 },
        )
        const code = yield* handle.exitCode
        return { code, text, stderr } satisfies GitResult
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed({ code: 1, text: "", stderr: "" } satisfies GitResult)),
    )

    const emitUpdated = (data: Info) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          project: data.id,
          payload: { type: Event.Updated.type, properties: data },
        }),
      )

    const fakeVcs = Schema.decodeUnknownSync(Schema.optional(ProjectVcs))(Flag.OPENCODE_FAKE_VCS)

    const scope = yield* Scope.Scope

    const migrateProjectId = Effect.fn("Project.migrateProjectId")(function* (
      oldID: ProjectV2.ID | undefined,
      newID: ProjectV2.ID,
    ) {
      if (!oldID) return
      if (oldID === ProjectV2.ID.global) return
      if (oldID === newID) return

      const migrated = yield* db
        .transaction(
          (d) =>
            Effect.gen(function* () {
              const oldProject = yield* d.select().from(ProjectTable).where(eq(ProjectTable.id, oldID)).get()
              const newProject = yield* d.select().from(ProjectTable).where(eq(ProjectTable.id, newID)).get()
              if (oldProject && !newProject) {
                yield* d
                  .insert(ProjectTable)
                  .values({
                    ...oldProject,
                    id: newID,
                    ...(oldProject.icon_generation_status === "queued" || oldProject.icon_generation_status === "generating"
                      ? {
                          icon_generation_attempt: oldProject.icon_generation_attempt + 1,
                          icon_generation_status: "failed" as const,
                          icon_generation_error: "Image generation was interrupted while the project identity changed.",
                          icon_generation_completed_at: Date.now(),
                        }
                      : {}),
                    time_updated: Date.now(),
                  })
                  .run()
              }

              // Project directories may be shared across distinct
              // checkouts which have diverged. Clear the directory
              // list and rely on it being re-populated to ensure
              // accuracy
              yield* d.delete(ProjectDirectoryTable).where(eq(ProjectDirectoryTable.project_id, oldID)).run()

              const sessions = yield* d
                .select({ id: SessionTable.id, timeUpdated: SessionTable.time_updated })
                .from(SessionTable)
                .where(eq(SessionTable.project_id, oldID))
                .all()
              yield* d
                .update(WorkspaceTable)
                .set({ project_id: newID })
                .where(eq(WorkspaceTable.project_id, oldID))
                .run()

              return { sessions, removeOld: oldProject !== undefined }
            }),
          { behavior: "immediate" },
        )
        .pipe(
          Effect.orDie,
          Effect.catchCause((cause) => {
            if (!isDatabaseLockCause(cause)) return Effect.failCause(cause)
            return Effect.logWarning("project identity migration deferred because SQLite is busy", { oldID, newID }).pipe(
              Effect.as({ sessions: [], removeOld: false }),
            )
          }),
        )
      yield* Effect.forEach(
        migrated.sessions,
        (session) =>
          events.publish(
            SessionEvent.ProjectAssigned,
            {
              sessionID: session.id,
              timestamp: DateTime.makeUnsafe(session.timeUpdated),
              projectID: newID,
            },
            {
              commit: () =>
                db
                  .update(SessionTable)
                  .set({ project_id: newID, time_updated: session.timeUpdated })
                  .where(and(eq(SessionTable.id, session.id), eq(SessionTable.project_id, oldID)))
                  .run()
                  .pipe(Effect.orDie),
            },
          ),
        { concurrency: 1, discard: true },
      ).pipe(
        Effect.catchCause((cause) => {
          if (!isDatabaseLockCause(cause)) return Effect.failCause(cause)
          return Effect.logWarning("project session assignment deferred because SQLite is busy", { projectID: newID })
        }),
      )
      if (migrated.removeOld)
        yield* db.delete(ProjectTable).where(eq(ProjectTable.id, oldID)).run().pipe(Effect.orDie)
    })

    const saveProjectDirectory = Effect.fn("Project.saveProjectDirectory")(function* (input: {
      projectID: ProjectV2.ID
      directory: string
    }) {
      if (input.projectID === ProjectV2.ID.global) return
      const opened = AbsolutePath.make(yield* Effect.promise(() => FSUtil.resolveAsync(input.directory)))
      if (yield* projectDirectories.contains({ directory: opened, projectID: input.projectID })) return
      yield* projectDirectories
        .create({
          directory: opened,
          projectID: input.projectID,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("project directory persistence failed", { projectID: input.projectID, cause }),
          ),
        )
    })

    const fromDirectory = Effect.fn("Project.fromDirectory")(function* (directory: string) {
      yield* Effect.logInfo("fromDirectory", { directory })

      const data = yield* projectV2.resolve(AbsolutePath.make(directory))
      const worktree = data.id === ProjectV2.ID.make("global") && !data.vcs ? "/" : data.directory

      // Phase 2: upsert
      const projectID = ProjectV2.ID.make(data.id)
      yield* migrateProjectId(data.previous ? ProjectV2.ID.make(data.previous) : undefined, projectID)
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get().pipe(Effect.orDie)
      const existing = row
        ? fromRow(row)
        : {
            id: projectID,
            worktree,
            vcs: data.vcs?.type ?? fakeVcs,
            sandboxes: [] as string[],
            time: { created: Date.now(), updated: Date.now() },
          }

      if (flags.experimentalIconDiscovery) yield* discover(existing).pipe(Effect.ignore, Effect.forkIn(scope))

      const changed =
        row === undefined ||
        (projectID === ProjectV2.ID.global ? worktree : existing.worktree) !== existing.worktree ||
        (data.vcs?.type ?? fakeVcs) !== existing.vcs
      const result: Info = {
        ...existing,
        sandboxes: [...existing.sandboxes],
        worktree: projectID === ProjectV2.ID.global ? worktree : existing.worktree,
        vcs: data.vcs?.type ?? fakeVcs,
        time: { ...existing.time, updated: changed ? Date.now() : existing.time.updated },
      }
      if (
        projectID !== ProjectV2.ID.global &&
        data.directory !== result.worktree &&
        !result.sandboxes.includes(data.directory)
        )
        result.sandboxes.push(data.directory)
      result.sandboxes = yield* Effect.forEach(
        result.sandboxes,
        (s) =>
          fs.exists(s).pipe(
            Effect.orDie,
            Effect.map((exists) => (exists ? s : undefined)),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((arr) => arr.filter((x): x is string => x !== undefined)))

      if (changed || JSON.stringify(existing.sandboxes) !== JSON.stringify(result.sandboxes))
        yield* db
          .insert(ProjectTable)
          .values({
            id: result.id,
            worktree: AbsolutePath.make(result.worktree),
            vcs: result.vcs ?? null,
            name: result.name,
            icon_url: result.icon?.url,
            icon_url_override: result.icon?.override,
            icon_color: result.icon?.color,
            time_created: result.time.created,
            time_updated: result.time.updated,
            time_initialized: result.time.initialized,
            sandboxes: result.sandboxes.map((sandbox) => AbsolutePath.make(sandbox)),
            commands: result.commands,
          })
          .onConflictDoUpdate({
            target: ProjectTable.id,
            set: {
              worktree: AbsolutePath.make(result.worktree),
              vcs: result.vcs ?? null,
              name: result.name,
              icon_url: result.icon?.url,
              icon_url_override: result.icon?.override,
              icon_color: result.icon?.color,
              time_updated: result.time.updated,
              time_initialized: result.time.initialized,
              sandboxes: result.sandboxes.map((sandbox) => AbsolutePath.make(sandbox)),
              commands: result.commands,
            },
          })
          .run()
          .pipe(
            Effect.orDie,
            Effect.catchCause((cause) => {
              if (!isDatabaseLockCause(cause)) return Effect.failCause(cause)
              return Effect.logWarning("project persistence deferred because SQLite is busy", { projectID })
            }),
          )

      if (projectID !== ProjectV2.ID.global) {
        const sessions = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(and(eq(SessionTable.project_id, ProjectV2.ID.global), eq(SessionTable.directory, data.directory)))
          .all()
          .pipe(Effect.orDie)
        const timestamp = yield* DateTime.now
        yield* Effect.forEach(
          sessions,
          (session) =>
            events.publish(
              SessionEvent.ProjectAssigned,
              {
                sessionID: session.id,
                timestamp,
                projectID,
              },
              {
                commit: () =>
                  db
                    .update(SessionTable)
                    .set({ project_id: projectID, time_updated: DateTime.toEpochMillis(timestamp) })
                    .where(
                      and(
                        eq(SessionTable.id, session.id),
                        eq(SessionTable.project_id, ProjectV2.ID.global),
                      ),
                    )
                    .run()
                    .pipe(Effect.orDie),
              },
            ),
          { concurrency: 1, discard: true },
        ).pipe(
          Effect.catchCause((cause) => {
            if (!isDatabaseLockCause(cause)) return Effect.failCause(cause)
            return Effect.logWarning("project session assignment deferred because SQLite is busy", { projectID })
          }),
        )
      }

      yield* saveProjectDirectory({
        projectID,
        directory: data.directory,
      })

      yield* emitUpdated(result)
      if (projectID !== ProjectV2.ID.global && data.vcs?.type === "git") {
        yield* projectV2.commit({ store: data.vcs.store, id: data.id })
      }
      return { project: result, sandbox: data.vcs ? data.directory : worktree }
    })

    const discover = Effect.fn("Project.discover")(function* (input: Info) {
      if (input.vcs !== "git") return
      if (input.icon?.override) return
      if (input.icon?.url) return

      const matches = yield* fs
        .glob("**/favicon.{ico,png,svg,jpg,jpeg,webp}", {
          cwd: input.worktree,
          absolute: true,
          include: "file",
        })
        .pipe(Effect.orDie)
      const shortest = matches.sort((a, b) => a.length - b.length)[0]
      if (!shortest) return

      const buffer = yield* fs.readFile(shortest).pipe(Effect.orDie)
      const base64 = Buffer.from(buffer).toString("base64")
      const mime = FSUtil.mimeType(shortest)
      const url = `data:${mime};base64,${base64}`
      yield* update({ projectID: input.id, icon: { url } }).pipe(
        Effect.catchTag("Project.NotFoundError", () => Effect.void),
      )
    })

    const list = Effect.fn("Project.list")(function* () {
      return (yield* db.select().from(ProjectTable).all().pipe(Effect.orDie)).map(fromRow)
    })

    const get = Effect.fn("Project.get")(function* (id: ProjectV2.ID) {
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const update = Effect.fn("Project.update")(function* (input: UpdateInput) {
      const before = input.icon
        ? yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, input.projectID)).get().pipe(Effect.orDie)
        : undefined
      const iconChanged =
        !!input.icon &&
        !!before &&
        ((input.icon.url !== undefined && (input.icon.url || undefined) !== (before.icon_url || undefined)) ||
          (input.icon.override !== undefined && (input.icon.override || undefined) !== (before.icon_url_override || undefined)) ||
          (input.icon.color !== undefined && (input.icon.color || undefined) !== (before.icon_color || undefined)) ||
          (input.icon.generated !== undefined &&
            (input.icon.generated || undefined) !== (before.icon_generated_url || undefined)))
      const result = yield* db
        .update(ProjectTable)
        .set({
          name: input.name,
          icon_url: input.icon?.url,
          icon_url_override: input.icon?.override,
          icon_color: input.icon?.color,
          icon_generated_url: input.icon?.generated,
          icon_generation_mode: input.iconGeneration?.mode,
          icon_generation_attempt: iconChanged
            ? sql`${ProjectTable.icon_generation_attempt} + 1`
            : undefined,
          icon_generation_status: iconChanged ? "idle" : undefined,
          icon_generation_error: iconChanged ? null : undefined,
          commands: input.commands,
          time_updated: Date.now(),
        })
        .where(eq(ProjectTable.id, input.projectID))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!result) return yield* new NotFoundError({ projectID: input.projectID })
      const data = fromRow(result)
      yield* emitUpdated(data)
      return data
    })

    const initGit = Effect.fn("Project.initGit")(function* (input: { directory: string; project: Info }) {
      if (input.project.vcs === "git") return input.project
      if (!(yield* Effect.sync(() => which("git")))) throw new Error("Git is not installed")
      const result = yield* git(["init", "--quiet"], { cwd: input.directory })
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.text.trim() || "Failed to initialize git repository")
      }
      const { project } = yield* fromDirectory(input.directory)
      return project
    })

    const setInitialized = Effect.fn("Project.setInitialized")(function* (id: ProjectV2.ID) {
      yield* db
        .update(ProjectTable)
        .set({ time_initialized: Date.now() })
        .where(eq(ProjectTable.id, id))
        .run()
        .pipe(Effect.orDie)
    })

    const initState = yield* InstanceState.make(
      Effect.fn("Project.initState")(function* (ctx) {
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== Command.Event.Executed.type || event.location?.directory !== ctx.directory)
            return Effect.void
          const data = event.data as EventV2.Data<typeof Command.Event.Executed>
          return data.name === Command.Default.INIT ? setInitialized(ctx.project.id) : Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)
      }),
    )

    const init = Effect.fn("Project.init")(function* () {
      yield* InstanceState.get(initState)
    })

    const sandboxes = Effect.fn("Project.sandboxes")(function* (id: ProjectV2.ID) {
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return []
      const data = fromRow(row)
      return yield* Effect.forEach(
        data.sandboxes,
        (dir) =>
          fs.isDir(dir).pipe(
            Effect.orDie,
            Effect.map((ok) => (ok ? dir : undefined)),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((arr) => arr.filter((x): x is string => x !== undefined)))
    })

    const addSandbox = Effect.fn("Project.addSandbox")(function* (id: ProjectV2.ID, directory: string) {
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
      if (!row) throw new Error(`Project not found: ${id}`)
      const sandbox = AbsolutePath.make(directory)
      const sboxes = [...row.sandboxes]
      if (!sboxes.includes(sandbox)) sboxes.push(sandbox)
      const result = yield* db
        .update(ProjectTable)
        .set({ sandboxes: sboxes, time_updated: Date.now() })
        .where(eq(ProjectTable.id, id))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!result) throw new Error(`Project not found: ${id}`)
      yield* emitUpdated(fromRow(result))
    })

    const removeSandbox = Effect.fn("Project.removeSandbox")(function* (id: ProjectV2.ID, directory: string) {
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
      if (!row) throw new Error(`Project not found: ${id}`)
      const sandbox = AbsolutePath.make(directory)
      const sboxes = row.sandboxes.filter((s) => s !== sandbox)
      const result = yield* db
        .update(ProjectTable)
        .set({ sandboxes: sboxes, time_updated: Date.now() })
        .where(eq(ProjectTable.id, id))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!result) throw new Error(`Project not found: ${id}`)
      yield* emitUpdated(fromRow(result))
    })

    return Service.of({
      init,
      fromDirectory,
      discover,
      list,
      get,
      update,
      initGit,
      setInitialized,
      sandboxes,
      addSandbox,
      removeSandbox,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.provide(ProjectDirectories.defaultLayer),
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export const use = serviceUse(Service)

export const node = LayerNode.make(layer, [
  FSUtil.node,
  AppProcess.node,
  CrossSpawnSpawner.node,
  ProjectV2.node,
  ProjectDirectories.node,
  EventV2Bridge.node,
  RuntimeFlags.node,
  Database.node,
])

export * as Project from "./project"
