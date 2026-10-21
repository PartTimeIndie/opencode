export * as MoveSession from "./move-session"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { Location } from "../location"
import { ProjectV2 } from "../project"
import { ProjectTable } from "../project/sql"
import { SessionV2 } from "../session"
import { SessionActivity } from "../session/activity"
import { SessionExecution } from "../session/execution"
import { SessionEvent } from "../session/event"
import { fromRow } from "../session/info"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { SessionSupervision } from "../session/supervision"
import { AbsolutePath, RelativePath } from "../schema"
import path from "path"

export const Destination = Schema.Struct({
  directory: AbsolutePath,
}).annotate({ identifier: "MoveSession.Destination" })
export type Destination = typeof Destination.Type

export const Input = Schema.Struct({
  sessionID: SessionSchema.ID,
  destination: Destination,
  moveChanges: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MoveSession.Input" })
export type Input = typeof Input.Type

export const Result = Schema.Struct({
  sessionIDs: Schema.Array(SessionSchema.ID),
  directory: AbsolutePath,
  projectID: ProjectV2.ID,
  subdirectory: RelativePath.pipe(Schema.optional),
}).annotate({ identifier: "MoveSession.Result" })
export type Result = typeof Result.Type

export class DestinationProjectMismatchError extends Schema.TaggedErrorClass<DestinationProjectMismatchError>()(
  "MoveSession.DestinationProjectMismatchError",
  {
    expected: ProjectV2.ID,
    actual: ProjectV2.ID,
  },
) {}

export class ApplyChangesError extends Schema.TaggedErrorClass<ApplyChangesError>()("MoveSession.ApplyChangesError", {
  message: Schema.String,
}) {}

export class CaptureChangesError extends Schema.TaggedErrorClass<CaptureChangesError>()(
  "MoveSession.CaptureChangesError",
  {
    message: Schema.String,
  },
) {}

export class ResetSourceChangesError extends Schema.TaggedErrorClass<ResetSourceChangesError>()(
  "MoveSession.ResetSourceChangesError",
  {
    directory: AbsolutePath,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class ActiveSessionError extends Schema.TaggedErrorClass<ActiveSessionError>()("MoveSession.ActiveSessionError", {
  sessionID: SessionSchema.ID,
}) {}

export type Error =
  | SessionV2.NotFoundError
  | DestinationProjectMismatchError
  | CaptureChangesError
  | ApplyChangesError
  | ResetSourceChangesError
  | ActiveSessionError

export interface Interface {
  readonly moveSession: (input: Input) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ControlPlaneMoveSession") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const git = yield* Git.Service
    const events = yield* EventV2.Service
    const project = yield* ProjectV2.Service
    const activity = yield* SessionActivity.Service
    const session = yield* SessionV2.Service

    const collectFamily = (info: SessionSchema.Info): Effect.Effect<SessionSchema.Info[]> =>
      Effect.gen(function* () {
        const children = (yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.parent_id, info.id))
          .all()
          .pipe(Effect.orDie)).map((row) => fromRow(row))
        const nested = yield* Effect.forEach(children, collectFamily)
        return [info, ...nested.flat()]
      }).pipe(Effect.withSpan("MoveSession.collectFamily"))

    const activeSession = (family: SessionSchema.Info[]): Effect.Effect<SessionSchema.ID | undefined> =>
      Effect.gen(function* () {
        const now = DateTime.toEpochMillis(yield* DateTime.now)
        const active = yield* Effect.forEach(family, (info) =>
          activity.listForSession(info.id).pipe(
            Effect.map((list) =>
              list.some(
                (item) =>
                  (item.status === "running" || item.status === "recovering") &&
                  // Stale leases mean the owning runner is gone; only a live lease blocks a move,
                  // matching the V2Session.assertNotBusy admission guard. A pending blocking
                  // question keeps the status endpoint busy but does not block admission either.
                  SessionSupervision.ownsLease({ leaseUntil: item.leaseUntil, now }),
              )
                ? info.id
                : undefined,
            ),
          ),
        )
        return active.find((sessionID) => sessionID !== undefined)
      }).pipe(Effect.withSpan("MoveSession.activeSession"))

    const targetDirectory = (root: SessionSchema.Info, destination: AbsolutePath, info: SessionSchema.Info) => {
      const relative = path.relative(root.location.directory, info.location.directory)
      if (!relative) return destination
      if (relative.startsWith("..") || path.isAbsolute(relative)) return destination
      return AbsolutePath.make(path.join(destination, relative))
    }

    const subdirectory = (projectDirectory: AbsolutePath, directory: AbsolutePath) =>
      RelativePath.make(path.relative(projectDirectory, directory).replaceAll("\\", "/"))

    const moveSession = Effect.fn("MoveSession.moveSession")(function* (input: Input) {
      const current = yield* session.get(input.sessionID)
      // Clients may send non-canonical casing or separators (Windows). Canonicalize once so the
      // result, events, and rows cannot drift away from the destination's real on-disk path.
      const directory = AbsolutePath.make(FSUtil.resolve(input.destination.directory))

      const source = yield* project.resolve(current.location.directory)
      const destination = yield* project.resolve(directory)
      const family = yield* collectFamily(current)
      const active = yield* activeSession(family)
      if (active) return yield* new ActiveSessionError({ sessionID: active })

      const result = {
        sessionIDs: family.map((info) => info.id),
        directory,
        projectID: destination.id,
        subdirectory: subdirectory(destination.directory, directory),
      } satisfies Result
      if (current.location.directory === directory && current.projectID === destination.id) return result

      yield* db
        .insert(ProjectTable)
        .values({
          id: destination.id,
          worktree: destination.directory,
          vcs: destination.vcs?.type,
          sandboxes: [],
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const patch =
        input.moveChanges && source.directory !== destination.directory
          ? yield* git
              .patch(current.location.directory)
              .pipe(Effect.mapError((error) => new CaptureChangesError({ message: error.message })))
          : ""
      if (patch) {
        yield* git
          .applyPatch({ directory, patch })
          .pipe(Effect.mapError((error) => new ApplyChangesError({ message: error.message })))
      }

      yield* Effect.forEach(family, (info) =>
        Effect.gen(function* () {
          const moved = targetDirectory(current, directory, info)
          yield* events.publish(SessionEvent.Moved, {
            sessionID: info.id,
            location: Location.Ref.make({ directory: moved }),
            projectID: destination.id,
            subdirectory: subdirectory(destination.directory, moved),
            timestamp: yield* DateTime.now,
          })
        }),
      )

      if (patch) {
        yield* git.softResetChanges(current.location.directory).pipe(
          Effect.mapError(
            (error) =>
              new ResetSourceChangesError({
                directory: current.location.directory,
                message: error.message,
                cause: error.cause,
              }),
          ),
        )
      }
      return result
    })

    return Service.of({ moveSession })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.provide(SessionActivity.defaultLayer),
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(SessionV2.defaultLayer),
)
