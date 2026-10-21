import { DateTime, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { ModelV2 } from "../../src/model"
import { ProjectV2 } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { ProviderV2 } from "../../src/provider"
import { AbsolutePath } from "../../src/schema"
import { SessionProjector } from "../../src/session/projector"
import { SessionEvent } from "../../src/session/event"
import { SessionMessage } from "../../src/session/message"
import { Prompt } from "../../src/session/prompt"
import { SessionSchema } from "../../src/session/schema"
import { SessionTable } from "../../src/session/sql"
import { SessionV1 } from "../../src/v1/session"

const filename = process.argv[2]
const directory = process.argv[3]
const quarantined = process.env.OPENCODE_TEST_STORAGE_QUARANTINED === "1"
const legacyActivityFailure = process.env.OPENCODE_TEST_STORAGE_LEGACY_ACTIVITY_FAILURE === "1"
const legacyProjectAssignment = process.env.OPENCODE_TEST_STORAGE_LEGACY_PROJECT_ASSIGNMENT === "1"
if (!filename || !directory) throw new Error("storage migration seed requires a database and project directory")

const database = Database.layerFromPath(filename, { deferStartupRepairs: false })
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const old = Date.now() - 10 * 24 * 60 * 60 * 1_000
const recent = Date.now() - 60_000

await Effect.runPromise(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const service = yield* EventV2.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* service.publish(SessionV1.Event.Created, sessionCreated("ses_storage_old", directory, old))
    yield* service.publish(SessionV1.Event.Created, sessionCreated("ses_storage_recent", directory, recent))
    if (legacyProjectAssignment) {
      const projectID = ProjectV2.ID.make("storage-reassigned-project")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make(directory), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({ project_id: projectID, time_updated: recent + 500 })
        .where(eq(SessionTable.id, SessionSchema.ID.make("ses_storage_recent")))
        .run()
        .pipe(Effect.orDie)
    }
    if (legacyActivityFailure) {
      const sessionID = SessionSchema.ID.make("ses_storage_recent")
      const messageID = SessionMessage.ID.make("msg_storage_legacy_activity_failure")
      const prompt = new Prompt({ text: "legacy pre-step failure" })
      yield* service.publish(SessionEvent.PromptLifecycle.Admitted, {
        sessionID,
        messageID,
        timestamp: DateTime.makeUnsafe(recent + 1),
        prompt,
        delivery: "steer",
      })
      yield* service.publish(SessionEvent.Activity.Started, {
        sessionID,
        activityID: "activity-storage-legacy-failure",
        timestamp: DateTime.makeUnsafe(recent + 2),
        kind: "prompt",
      })
      yield* service.publish(SessionEvent.PromptLifecycle.Promoted, {
        sessionID,
        messageID,
        timestamp: DateTime.makeUnsafe(recent + 3),
        timeCreated: DateTime.makeUnsafe(recent + 1),
        prompt,
      })
      yield* service.publish(SessionEvent.Activity.Failed, {
        sessionID,
        activityID: "activity-storage-legacy-failure",
        timestamp: DateTime.makeUnsafe(recent + 4),
        error: { type: "unknown", message: "legacy provider failure" },
      })
      yield* db.run(`
        UPDATE event SET type = 'session.next.activity.failed.1'
        WHERE aggregate_id = 'ses_storage_recent' AND type = 'session.next.activity.failed.2'
      `)
    }
    yield* service.publish(SessionV1.Event.MessageUpdated, {
      sessionID: SessionSchema.ID.make("ses_storage_old"),
      info: {
        id: SessionV1.MessageID.make("msg_storage_legacy"),
        sessionID: SessionSchema.ID.make("ses_storage_old"),
        role: "user",
        time: { created: old },
        agent: "build",
        model: { providerID: ProviderV2.ID.anthropic, modelID: ModelV2.ID.make("sonnet") },
      },
    })
    yield* service.publish(SessionV1.Event.PartUpdated, {
      sessionID: SessionSchema.ID.make("ses_storage_old"),
      part: {
        id: SessionV1.PartID.make("prt_storage_legacy"),
        messageID: SessionV1.MessageID.make("msg_storage_legacy"),
        sessionID: SessionSchema.ID.make("ses_storage_old"),
        type: "text",
        text: "legacy storage migration payload",
      },
      time: old,
    })
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionSchema.ID.make("ses_storage_legacy"),
        project_id: ProjectV2.ID.global,
        slug: "ses_storage_legacy",
        directory,
        title: "eventless legacy session",
        version: "legacy",
        time_created: old,
        time_updated: old,
      })
      .run()
      .pipe(Effect.orDie)
    if (!quarantined) return
    yield* db.run("INSERT INTO event_sequence (aggregate_id, seq) VALUES ('quarantine_fixture', 0)")
    yield* db.run(`
      INSERT INTO event_checkpoint (aggregate_id, seq, version, data, time_created)
      VALUES ('quarantine_fixture', 0, 1, '{"image":"data:image/png;base64,%%%%"}', ${recent})
    `)
  }).pipe(Effect.provide(Layer.mergeAll(database, events, projector)), Effect.scoped),
)

function sessionCreated(id: string, directory: string, timestamp: number) {
  const sessionID = SessionSchema.ID.make(id)
  return {
    sessionID,
    info: {
      id: sessionID,
      slug: id,
      projectID: ProjectV2.ID.global,
      directory,
      title: id,
      version: "test",
      time: { created: timestamp, updated: timestamp },
    },
  }
}
