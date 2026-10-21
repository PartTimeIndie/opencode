import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { Context, Effect, Layer } from "effect"
import { layer as locationLayer } from "./groups/location"
import { sessionLocationLayer } from "./middleware/session-location"
import { MessageHandler } from "./handlers/message"
import { ModelHandler } from "./handlers/model"
import { ProviderHandler } from "./handlers/provider"
import { SessionHandler } from "./handlers/session"
import { CommandPlugin } from "./command-plugin"
import { PermissionHandler } from "./handlers/permission"
import { FileSystemHandler } from "./handlers/fs"
import { CommandHandler } from "./handlers/command"
import { SkillHandler } from "./handlers/skill"
import { EventHandler } from "./handlers/event"
import { AgentHandler } from "./handlers/agent"
import { HealthHandler } from "./handlers/health"
import { PtyHandler } from "./handlers/pty"
import { SurfaceHandler } from "./handlers/surface"
import { ControlHandler } from "./handlers/control"
import { ControlLive } from "@opencode-ai/core/control-live"
import { ReferenceHandler } from "./handlers/reference"
import * as SessionExecutionLocal from "@opencode-ai/core/session/execution/local"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { LocationHandler } from "./handlers/location"
import { IntegrationHandler } from "./handlers/integration"
import { CredentialHandler } from "./handlers/credential"
import { Credential } from "@opencode-ai/core/credential"
import { ProjectCopyHandler } from "./handlers/project-copy"
import { ContentStore } from "@opencode-ai/core/content-store"
import { SessionFileMutation } from "@opencode-ai/core/session/file-mutation"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { SessionArchive } from "@opencode-ai/core/session-archive"
import { SessionArchiveMaintenance } from "@opencode-ai/core/session-archive-maintenance"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { QuestionTable } from "@opencode-ai/core/question/sql"
import { sql } from "drizzle-orm"
import path from "path"

export type SessionArchiveServerOptions = {
  readonly directory: string
  readonly inactiveMs?: number
  readonly maxShardBytes?: number
  readonly leaseMs?: number
  readonly maintenanceIntervalMs?: number
  readonly maintenanceInitialDelayMs?: number
  readonly maintenanceMaxArchivesPerRun?: number
  readonly maintenanceMaxRunMs?: number
  readonly now?: () => number
}

export interface SessionArchiveQuestionProbeInterface {
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  readonly any: Effect.Effect<boolean>
}

export class SessionArchiveQuestionProbe extends Context.Service<
  SessionArchiveQuestionProbe,
  SessionArchiveQuestionProbeInterface
>()("@opencode/server/SessionArchiveQuestionProbe") {}

export const locationQuestionProbeLayer = Layer.effect(
  SessionArchiveQuestionProbe,
  Effect.gen(function* () {
    const database = yield* Database.Service

    return SessionArchiveQuestionProbe.of({
      forSession: Effect.fn("SessionArchiveQuestionProbe.forSession")(function* (sessionID) {
        const row = yield* database.db
          .get<{ pending: number }>(
            sql`
            SELECT EXISTS(
              SELECT 1 FROM ${QuestionTable}
              WHERE ${QuestionTable.session_id} = ${sessionID}
                AND ${QuestionTable.state} IN ('queued', 'active')
                AND (
                  ${QuestionTable.detached} = 1 OR EXISTS(
                    SELECT 1 FROM session_activity
                    WHERE session_activity.id = ${QuestionTable.activity_id}
                      AND session_activity.status IN ('running', 'recovering')
                  )
                )
            ) AS pending
          `,
          )
          .pipe(Effect.orDie)
        return row?.pending === 1
      }),
      any: database.db
        .get<{ pending: number }>(
          sql`
          SELECT EXISTS(
            SELECT 1 FROM ${QuestionTable}
            WHERE ${QuestionTable.state} IN ('queued', 'active')
              AND (
                ${QuestionTable.detached} = 1 OR EXISTS(
                  SELECT 1 FROM session_activity
                  WHERE session_activity.id = ${QuestionTable.activity_id}
                    AND session_activity.status IN ('running', 'recovering')
                )
              )
          ) AS pending
        `,
        )
        .pipe(
          Effect.orDie,
          Effect.map((row) => row?.pending === 1),
        ),
    })
  }),
)

export function makeSessionArchiveServerLayer<R, E>(
  options: SessionArchiveServerOptions,
  questionProbeLayer: Layer.Layer<SessionArchiveQuestionProbe, E, R>,
) {
  const archiveLayer = Layer.effect(
    SessionArchive.Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const questions = yield* SessionArchiveQuestionProbe
      const archive = yield* SessionArchive.make({
        directory: options.directory,
        ...(options.inactiveMs === undefined ? {} : { inactiveMs: options.inactiveMs }),
        ...(options.maxShardBytes === undefined ? {} : { maxShardBytes: options.maxShardBytes }),
        ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
        isIdle: (sessionID) =>
          Effect.gen(function* () {
            if (!(yield* databaseIsIdle(database.db, sessionID))) return false
            return !(yield* questions.forSession(sessionID))
          }),
      })
      yield* archive.initialize
      return archive
    }),
  ).pipe(Layer.provide(questionProbeLayer))

  const maintenanceLayer = Layer.effect(
    SessionArchiveMaintenance.Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const maintenance = yield* SessionArchiveMaintenance.make({
        ...(options.maintenanceIntervalMs === undefined ? {} : { intervalMs: options.maintenanceIntervalMs }),
        ...(options.maintenanceInitialDelayMs === undefined
          ? {}
          : { initialDelayMs: options.maintenanceInitialDelayMs }),
        ...(options.maintenanceMaxArchivesPerRun === undefined
          ? {}
          : { maxArchivesPerRun: options.maintenanceMaxArchivesPerRun }),
        ...(options.maintenanceMaxRunMs === undefined ? {} : { maxRunMs: options.maintenanceMaxRunMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
        prepare: (sessionID) =>
          Effect.gen(function* () {
            const sequence = yield* database.db
              .get<{ seq: number }>(sql`SELECT seq FROM event_sequence WHERE aggregate_id = ${sessionID}`)
              .pipe(Effect.orDie)
            if (!sequence) return
            const result = yield* events.compactCheckpoint(sessionID)
            if (result) return
            return yield* new SessionArchive.IntegrityError({
              sessionID,
              message: "A verified event checkpoint is required before archiving",
            })
          }),
      })
      yield* maintenance.start
      return maintenance
    }),
  ).pipe(Layer.provide(archiveLayer), Layer.provide(questionProbeLayer))

  return Layer.merge(archiveLayer, maintenanceLayer)
}

export const sessionArchiveServerLayer = makeSessionArchiveServerLayer(
  { directory: path.join(Global.Path.data, "archives") },
  locationQuestionProbeLayer,
)

function databaseIsIdle(db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  return db
    .get<{ busy: number }>(
      sql`
        SELECT EXISTS(
          SELECT 1 FROM session_activity
          WHERE session_id = ${sessionID} AND status IN ('running', 'recovering')
          UNION ALL
          SELECT 1 FROM session_input
          WHERE session_id = ${sessionID} AND promoted_seq IS NULL
          UNION ALL
          SELECT 1 FROM background_job
          WHERE status = 'running'
            AND (parent_session_id = ${sessionID} OR child_session_id = ${sessionID})
        ) AS busy
      `,
    )
    .pipe(
      Effect.map((row) => Number(row?.busy ?? 0) === 0),
      Effect.orDie,
    )
}

const contentStoreLayer = ContentStore.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.defaultLayer),
)
// Rollback restores files only through this journal (V2 Session Core contract).
// Without it, file-restoring rollbacks (the default; messages_only does not need
// the journal) are silently marked blocked/unattributed, so it must share the
// application content store and database the tools write to.
const sessionFileMutationLayer = SessionFileMutation.layer.pipe(
  Layer.provide(contentStoreLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
)
const sessionStoreLayer = SessionStore.layer
const locationServiceMapLayer = LocationServiceMap.layer.pipe(Layer.provide(sessionStoreLayer))
export const sessionExecutionLayer = SessionExecutionLocal.layer
const sessionLayer = Layer.unwrap(SessionExecution.Service.pipe(Effect.map(SessionV2.layerWithExecution))).pipe(
  Layer.provide(contentStoreLayer),
  Layer.provide(sessionArchiveServerLayer),
)

// HTTP handlers and server plugins must share the process Session service,
// including its real execution coordinator. Merging their layers as siblings
// does not expose the handlers' private dependencies to plugin callbacks.
export const sessionRuntimeLayer = sessionLayer.pipe(
  Layer.provide(Snapshot.defaultLayer),
  Layer.provide(sessionFileMutationLayer),
  Layer.provideMerge(sessionExecutionLayer),
  Layer.provide(SessionActivity.layer),
  Layer.provide(SessionProjector.layer),
  Layer.provide(sessionStoreLayer),
  Layer.provide(locationServiceMapLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export const handlerLayer = Layer.mergeAll(
  HealthHandler,
  LocationHandler,
  AgentHandler,
  SessionHandler,
  MessageHandler,
  ModelHandler,
  ProviderHandler,
  IntegrationHandler,
  CredentialHandler,
  PermissionHandler,
  FileSystemHandler,
  CommandHandler,
  SkillHandler,
  EventHandler,
  PtyHandler,
  SurfaceHandler,
  ControlHandler,
  ReferenceHandler,
  ProjectCopyHandler,
).pipe(
  Layer.provide(sessionLocationLayer),
  Layer.provide(locationLayer),
  Layer.provide(sessionRuntimeLayer),
  Layer.provide(Snapshot.defaultLayer),
  Layer.provide(sessionExecutionLayer),
  Layer.provide(SessionActivity.layer),
  Layer.provide(SessionProjector.layer),
  Layer.provide(sessionStoreLayer),
  Layer.provide(PermissionSaved.defaultLayer),
  Layer.provide(PtyTicket.defaultLayer),
  Layer.provide(locationServiceMapLayer),
  Layer.provide(ControlLive.layer),
  Layer.provide(Credential.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
)

const defaultDatabaseLayer = Database.defaultLayer
export const handlers = handlerLayer.pipe(
  Layer.provide(CommandPlugin.noopLayer),
  Layer.provide(EventV2.layer.pipe(Layer.provide(defaultDatabaseLayer))),
  Layer.provide(defaultDatabaseLayer),
)
