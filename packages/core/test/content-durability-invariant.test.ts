import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import path from "node:path"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment, Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)

describe("content durability invariant", () => {
  it.live("keeps base64 materialization out of every durable session projection and checkpoint", () =>
    withRuntime(({ directory }) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        const sessions = yield* SessionV2.Service
        const outputs = yield* ToolOutputStore.Service
        const sessionID = SessionV2.ID.make("ses_content_durability")
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: directory, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* sessions.create({
          id: sessionID,
          location: Location.Ref.make({ directory }),
          title: "Content durability",
        })
        const prompt = yield* sessions.prompt({
          sessionID,
          resume: false,
          prompt: new Prompt({
            text: "Inspect the attached image",
            files: [
              new FileAttachment({
                uri: "data:image/png;base64,aGVsbG8=",
                mime: "image/png",
                name: "pixel.png",
              }),
            ],
          }),
        })
        yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)

        const assistantMessageID = SessionMessage.ID.make("msg_content_durability_assistant")
        const timestamp = DateTime.makeUnsafe(Date.now())
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID,
          timestamp,
          assistantMessageID,
          agent: "build",
          model: ModelV2.Ref.make({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("model") }),
        })
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID,
          timestamp,
          assistantMessageID,
          callID: "call_content_durability",
          tool: "read",
          input: {},
          provider: { executed: false },
        })
        const bounded = yield* outputs.bound({
          sessionID,
          assistantMessageID,
          toolCallID: "call_content_durability",
          output: {
            structured: { status: "complete" },
            content: [
              {
                type: "text",
                text: "x".repeat(ToolOutputStore.MAX_BYTES + 1),
              },
              {
                type: "file",
                uri: "data:text/plain;base64,dG9vbC1vdXRwdXQ=",
                mime: "text/plain",
                name: "tool.txt",
              },
            ],
          },
        })
        expect(bounded.outputPaths).toHaveLength(1)
        expect(bounded.outputPaths[0]).toStartWith(ContentStore.URI_PREFIX)
        expect(JSON.stringify(bounded.outputPaths)).not.toContain(directory)
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID,
          timestamp,
          assistantMessageID,
          callID: "call_content_durability",
          structured: bounded.output.structured as Record<string, unknown>,
          content: bounded.output.content,
          outputPaths: bounded.outputPaths,
          provider: { executed: false },
        })
        expect(yield* events.createCheckpoint(sessionID)).toBeDefined()

        for (const table of [
          "session",
          "session_input",
          "session_message",
          "message",
          "part",
          "event",
          "event_checkpoint",
        ]) {
          const rows = yield* db
            .all<{ count: number }>(sql.raw(`SELECT COUNT(*) AS count FROM "${table}"`))
            .pipe(Effect.orDie)
          if (table === "message" || table === "part") expect(rows[0]?.count).toBe(0)
          else expect(rows[0]?.count).toBeGreaterThan(0)
          const columns = yield* db
            .all<{ name: string; type: string }>(sql.raw(`PRAGMA table_info("${table}")`))
            .pipe(Effect.orDie)
          for (const column of columns.filter((column) => column.type.toUpperCase().includes("TEXT"))) {
            const matches = yield* db
              .all<{
                count: number
              }>(sql.raw(`SELECT COUNT(*) AS count FROM "${table}" WHERE instr(CAST("${column.name}" AS TEXT), ';base64,') > 0`))
              .pipe(Effect.orDie)
            expect(matches[0]?.count).toBe(0)
          }
        }
        expect(prompt.prompt.files?.[0]?.uri).toStartWith(ContentStore.URI_PREFIX)
      }),
    ),
  )
})

function withRuntime<A, E, R>(body: (input: { readonly directory: AbsolutePath }) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const database = Database.layerFromPath(path.join(tmp.path, "content-durability.db"))
      const global = Global.layerWith({ data: tmp.path })
      const content = ContentStore.layer.pipe(
        Layer.provide(database),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(global),
      )
      const outputs = ToolOutputStore.layer.pipe(
        Layer.provide(content),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(global),
      )
      const events = EventV2.layer.pipe(Layer.provide(database))
      const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
      const store = SessionStore.layer.pipe(Layer.provide(database))
      const projects = Layer.succeed(
        ProjectV2.Service,
        ProjectV2.Service.of({
          resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
          directories: () => Effect.succeed([]),
          commit: () => Effect.void,
        }),
      )
      const snapshot = Layer.succeed(
        Snapshot.Service,
        Snapshot.Service.of({
          track: () => Effect.succeed(undefined),
          changedFiles: () => Effect.succeed([]),
          patch: () => Effect.die("unused"),
          restore: () => Effect.void,
          revert: () => Effect.void,
          diff: () => Effect.succeed(undefined),
          diffFull: () => Effect.succeed([]),
        }),
      )
      const sessions = SessionV2.layer.pipe(
        Layer.provide(content),
        Layer.provide(events),
        Layer.provide(database),
        Layer.provide(store),
        Layer.provide(projects),
        Layer.provide(snapshot),
        Layer.provide(SessionExecution.noopLayer),
      )
      return body({ directory: AbsolutePath.make(tmp.path) }).pipe(
        Effect.provide(
          Layer.mergeAll(
            database,
            global,
            FSUtil.defaultLayer,
            content,
            outputs,
            events,
            projector,
            store,
            projects,
            snapshot,
            SessionExecution.noopLayer,
            sessions,
          ),
        ),
      )
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
}
