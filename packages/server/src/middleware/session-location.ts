import { Database } from "@opencode-ai/core/database/database"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionArchiveCatalogTable } from "@opencode-ai/core/archive.sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Layer, Schedule, Schema } from "effect"
import { existsSync } from "node:fs"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionLocationUnavailableError, SessionNotFoundError } from "../errors"
import type { LocationServices } from "../groups/location"

export class SessionLocationMiddleware extends HttpApiMiddleware.Service<
  SessionLocationMiddleware,
  {
    provides: LocationServices
  }
>()("@opencode/HttpApiSessionLocation", {
  error: [InvalidRequestError, SessionLocationUnavailableError, SessionNotFoundError],
}) {}

const decodeSessionID = Schema.decodeUnknownEffect(SessionV2.ID)
// Session routing is read-only; a short retry prevents temporary writer contention from turning a question reply into a client timeout.
const lockRetrySchedule = Schedule.exponential("25 millis").pipe(Schedule.jittered, Schedule.both(Schedule.recurs(3)))

const isRetryableLock = (error: unknown) => /database is locked|locktimeouterror/i.test(error instanceof Error ? error.message : String(error))

export const sessionLocationLayer = Layer.effect(
  SessionLocationMiddleware,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const locations = yield* LocationServiceMap

    return SessionLocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const sessionID = yield* decodeSessionID(route.params.sessionID).pipe(
          Effect.mapError(
            () =>
              new InvalidRequestError({
                message: "Invalid session ID",
                field: "sessionID",
              }),
          ),
        )
        const active = yield* db
          .select({ directory: SessionTable.directory, workspaceID: SessionTable.workspace_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.retry({ while: isRetryableLock, schedule: lockRetrySchedule }), Effect.orDie)
        const row = active ?? (yield* db
          .select({
            directory: SessionArchiveCatalogTable.directory,
            workspaceID: sql<string | null>`json_extract(${SessionArchiveCatalogTable.session_data}, '$.workspace_id')`,
          })
          .from(SessionArchiveCatalogTable)
          .where(
            and(
              eq(SessionArchiveCatalogTable.session_id, sessionID),
              eq(SessionArchiveCatalogTable.location, "archived"),
            ),
          )
          .get()
          .pipe(Effect.retry({ while: isRetryableLock, schedule: lockRetrySchedule }), Effect.orDie))
        if (!row)
          return yield* new SessionNotFoundError({
            sessionID,
            message: `Session not found: ${sessionID}`,
          })

        const unavailable = () =>
          new SessionLocationUnavailableError({
            sessionID,
            directory: row.directory,
            message: `Session location is no longer available: ${row.directory}. Reopen the session from an existing project or delete this stale session.`,
          })
        if (!existsSync(row.directory)) return yield* unavailable()

        return yield* effect.pipe(
          Effect.provide(
            locations.get(
              Location.Ref.make({
                directory: AbsolutePath.make(row.directory),
                workspaceID: row.workspaceID ? WorkspaceV2.ID.make(row.workspaceID) : undefined,
              }),
            ),
          ),
        )
      }),
    )
  }),
)
