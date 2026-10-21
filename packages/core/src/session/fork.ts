export * as SessionFork from "./fork"

import { and, asc, eq, isNull } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { EventSequenceTable } from "../event/sql"
import { SystemContext } from "../system-context/index"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"

export class CaptureConflict extends Schema.TaggedErrorClass<CaptureConflict>()("SessionFork.CaptureConflict", {
  reason: Schema.Literals(["missing", "boundary", "pending", "epoch", "history"]),
}) {}

/**
 * Read-only host preparation, not a fork/start operation or an authorization.
 * Capture the current event fence and context together. Historical epochs are
 * not retained, so an arbitrary older fence cannot safely borrow today's epoch.
 * A later workspace snapshot must recheck this fence before provisioning a child.
 * This is a provider-turn boundary, not proof of activity/background-job settlement.
 * Main may still be active between turns; only SessionExecution owns that lifecycle.
 * Entries are source evidence, not clone-ready messages: IDs, attachment ownership,
 * presentation parts and message metadata still require controlled materialization.
 */
export const capture = Effect.fn("SessionFork.capture")(function* (
  db: Database.Interface["db"],
  input: { readonly sessionID: SessionSchema.ID; readonly throughSeq: number },
) {
  return yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const session = yield* tx
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!session || session.time_archived !== null || session.revert !== null)
          return yield* new CaptureConflict({ reason: "missing" })
        const fence = yield* tx
          .select()
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!Number.isSafeInteger(input.throughSeq) || input.throughSeq < 0 || fence?.seq !== input.throughSeq)
          return yield* new CaptureConflict({ reason: "boundary" })
        const pending = yield* tx
          .select({ id: SessionInputTable.id })
          .from(SessionInputTable)
          .where(and(eq(SessionInputTable.session_id, input.sessionID), isNull(SessionInputTable.promoted_seq)))
          .get()
          .pipe(Effect.orDie)
        // Held and queued instructions are not part of the completed dialogue either.
        if (pending) return yield* new CaptureConflict({ reason: "pending" })
        const epoch = yield* tx
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (
          !epoch ||
          epoch.replacement_seq !== null ||
          epoch.baseline_seq > input.throughSeq ||
          epoch.baseline_seq < -1 ||
          !Number.isSafeInteger(epoch.baseline_seq) ||
          !Number.isSafeInteger(epoch.revision) ||
          epoch.revision < 0 ||
          (session.agent !== null && epoch.agent !== session.agent)
        )
          return yield* new CaptureConflict({ reason: "epoch" })
        yield* Schema.decodeUnknownEffect(SystemContext.Snapshot)(epoch.snapshot).pipe(
          Effect.mapError(() => new CaptureConflict({ reason: "epoch" })),
        )
        const rows = yield* tx
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, input.sessionID))
          .orderBy(asc(SessionMessageTable.seq))
          .all()
          .pipe(Effect.orDie)
        if (rows.length === 0 || rows.some((row) => row.seq > input.throughSeq || row.seq < 0))
          return yield* new CaptureConflict({ reason: "boundary" })
        const entries = yield* Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }).pipe(
            Effect.mapError(() => new CaptureConflict({ reason: "history" })),
            Effect.map((message) => ({ seq: row.seq, message })),
          ),
        )
        const last = entries.at(-1)?.message
        if (
          last?.type !== "assistant" ||
          last.time.completed === undefined ||
          (last.finish !== "stop" && last.finish !== "tool-calls") ||
          last.error ||
          last.failure
        )
          return yield* new CaptureConflict({ reason: "boundary" })
        if (epoch.agent !== last.agent) return yield* new CaptureConflict({ reason: "epoch" })
        if (
          entries.some(
            ({ message }) =>
              (message.type === "assistant" &&
                (message.time.completed === undefined ||
                  message.content.some(
                    (part) =>
                      part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
                  ))) ||
              (message.type === "shell" && message.time.completed === undefined),
          )
        )
          return yield* new CaptureConflict({ reason: "history" })
        return {
          sourceSessionID: session.id,
          throughSeq: input.throughSeq,
          directory: session.directory,
          // Never copy Session metadata, questions, inboxes or capability leases.
          epoch,
          entries,
          selectedAgent: session.agent,
          actualAgent: last.agent,
          selectedModel: session.model,
          actualModel: last.model,
          permission: session.permission,
          agentPolicy: session.agent_policy,
        }
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export type Capture = Effect.Success<ReturnType<typeof capture>>
