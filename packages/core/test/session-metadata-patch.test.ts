import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, projector))

describe("session metadata patch projection", () => {
  it.effect("serializes concurrent durable patches and preserves unrelated metadata", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const eventService = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_metadata_patch_test")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "metadata-patch-test",
          directory: "/project",
          title: "metadata-patch-test",
          version: "test",
          metadata: { existing: true },
          time_created: 1,
          time_updated: 1,
        })
        .run()

      yield* Effect.all(
        [
          eventService.publish(SessionEvent.MetadataPatched, {
            sessionID,
            timestamp: DateTime.makeUnsafe(2),
            set: { "opencode.session.goal": "ship it" },
          }),
          eventService.publish(SessionEvent.MetadataPatched, {
            sessionID,
            timestamp: DateTime.makeUnsafe(3),
            set: { access_control: { mode: "always" } },
          }),
        ],
        { concurrency: 2 },
      )

      const row = yield* db
        .select({ metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
      expect(row?.metadata).toEqual({
        existing: true,
        "opencode.session.goal": "ship it",
        access_control: { mode: "always" },
      })

      yield* eventService.publish(SessionEvent.MetadataPatched, {
        sessionID,
        timestamp: DateTime.makeUnsafe(4),
        set: { "opencode.session.goal": "ship it" },
      })
      yield* eventService.publish(SessionEvent.MetadataPatched, {
        sessionID,
        timestamp: DateTime.makeUnsafe(5),
        set: { "opencode.session.goal": "ship it" },
      })
      const afterRepeatedSet = yield* db
        .select({ metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
      expect(afterRepeatedSet?.metadata).toEqual(row?.metadata)

      yield* eventService.publish(SessionEvent.MetadataPatched, {
        sessionID,
        timestamp: DateTime.makeUnsafe(6),
        unset: ["opencode.session.goal"],
      })
      yield* eventService.publish(SessionEvent.MetadataPatched, {
        sessionID,
        timestamp: DateTime.makeUnsafe(7),
        unset: ["opencode.session.goal"],
      })
      const afterUnset = yield* db
        .select({ metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
      expect(afterUnset?.metadata).toEqual({ existing: true, access_control: { mode: "always" } })

      yield* eventService.publish(SessionEvent.MetadataPatched, {
        sessionID,
        timestamp: DateTime.makeUnsafe(5),
        set: { access_control: { mode: "ask" } },
      })
      yield* eventService.publish(SessionEvent.MetadataPatched, {
        sessionID,
        timestamp: DateTime.makeUnsafe(5),
        set: { access_control: { mode: "always" } },
      })
      const afterSameKey = yield* db
        .select({ metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
      expect(afterSameKey?.metadata).toEqual({ existing: true, access_control: { mode: "always" } })
    }),
  )
})
