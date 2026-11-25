export * as SessionFork from "./fork"

import { and, asc, desc, eq, isNull, lt } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { EventSequenceTable } from "../event/sql"
import { SystemContext } from "../system-context/index"
import { SessionHistory } from "./history"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { TaskContext } from "./task-context"
import { SessionContextEpochTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"

export class CaptureConflict extends Schema.TaggedErrorClass<CaptureConflict>()("SessionFork.CaptureConflict", {
  reason: Schema.Literals(["missing", "boundary", "pending", "epoch", "history"]),
}) {
  override get message() {
    return `Session fork capture refused (${this.reason})`
  }
}

/** Shared creation/follow-up fence. Future unheld queues never authorize a
 * current dispatch, but need not prevent it either. Callers bind this snapshot. */
export const pendingInputs = Effect.fn("SessionFork.pendingInputs")(function* (
  db: Pick<Database.Interface["db"], "select">,
  sessionID: SessionSchema.ID,
  dispatch: boolean,
) {
  const pending = yield* db.select({ id: SessionInputTable.id, delivery: SessionInputTable.delivery, heldAt: SessionInputTable.held_at })
    .from(SessionInputTable).where(and(eq(SessionInputTable.session_id, sessionID), isNull(SessionInputTable.promoted_seq)))
    .orderBy(asc(SessionInputTable.admitted_seq)).all().pipe(Effect.orDie)
  if (pending.some((row) => !dispatch || row.delivery !== "queue" || row.heldAt !== null))
    return yield* new CaptureConflict({ reason: "pending" })
  return pending
})

/** Host-bound native tool boundary; this is capture evidence, not admission authority. */
export type Dispatch = {
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
}

/**
 * Read-only host preparation, not a fork/start operation or an authorization.
 * Capture the current event fence and context together. Historical epochs are
 * not retained, so an arbitrary older fence cannot safely borrow today's epoch.
 * A later workspace snapshot must recheck this fence before provisioning a child.
 * This is a provider-turn boundary, not proof of activity/background-job settlement.
 * Main may still be active between turns; only SessionExecution owns that lifecycle.
 * Native dispatch excludes its exact unfinished assistant, including sibling
 * calls. No prompt-shaped row alone grants admission authority.
 * Entries are source evidence, not clone-ready messages: IDs,
 * attachment ownership, presentation parts and message metadata still require
 * controlled materialization.
 */
export const capture = Effect.fn("SessionFork.capture")(function* (
  db: Database.Interface["db"],
  input: { readonly sessionID: SessionSchema.ID; readonly throughSeq: number; readonly dispatch?: Dispatch; readonly context?: TaskContext.Mode },
) {
  const context = input.context ?? "fork"
  if (input.dispatch === null || (context === "fresh" && !input.dispatch))
    return yield* new CaptureConflict({ reason: "boundary" })
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
        const pending = yield* pendingInputs(tx, input.sessionID, input.dispatch !== undefined)
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
        // Native dispatch inherits the same compacted working set that the
        // source runner sees, including chronological post-baseline updates.
        const decoded = context === "fresh"
          ? yield* Effect.gen(function* () {
              const row = yield* tx.select().from(SessionMessageTable)
                .where(eq(SessionMessageTable.session_id, input.sessionID))
                .orderBy(desc(SessionMessageTable.seq)).limit(1).get().pipe(Effect.orDie)
              if (!row) return []
              const message = yield* Schema.decodeUnknownEffect(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type })
                .pipe(Effect.mapError(() => new CaptureConflict({ reason: "history" })))
              return [{ seq: row.seq, message }]
            })
          : input.dispatch
          ? yield* SessionHistory.entriesForRunner(tx, input.sessionID, epoch.baseline_seq).pipe(
              Effect.mapError(() => new CaptureConflict({ reason: "history" })),
            )
          : yield* Effect.gen(function* () {
              const rows = yield* tx.select().from(SessionMessageTable)
                .where(eq(SessionMessageTable.session_id, input.sessionID))
                .orderBy(asc(SessionMessageTable.seq)).all().pipe(Effect.orDie)
              return yield* Effect.forEach(rows, (row) =>
                Schema.decodeUnknownEffect(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }).pipe(
                  Effect.mapError(() => new CaptureConflict({ reason: "history" })),
                  Effect.map((message) => ({ seq: row.seq, message })),
                ),
              )
            })
        if (decoded.length === 0 || decoded.some((entry) => entry.seq > input.throughSeq || entry.seq < 0))
          return yield* new CaptureConflict({ reason: "boundary" })
        // Exclude only the host-bound native dispatch assistant.
        const lastDecoded = decoded.at(-1)
        const toolParts =
          lastDecoded?.message.type === "assistant"
            ? lastDecoded.message.content.filter((part) => part.type === "tool")
            : []
        const nativeDispatch =
          input.dispatch !== undefined &&
          lastDecoded?.message.type === "assistant" &&
          lastDecoded.message.id === input.dispatch.assistantMessageID &&
          lastDecoded.message.time.completed === undefined &&
          lastDecoded.message.finish === undefined &&
          !lastDecoded.message.error &&
          !lastDecoded.message.failure &&
          !lastDecoded.message.content.some((part) => part.type === "custom") &&
          toolParts.filter((part) => part.id === input.dispatch?.toolCallID).length === 1 &&
          toolParts.some((part) => part.id === input.dispatch?.toolCallID &&
            (part.name === "task" || part.name === "multi_agent_fanout") && part.state.status === "running")
        if (input.dispatch && !nativeDispatch) return yield* new CaptureConflict({ reason: "boundary" })
        const candidate = nativeDispatch ? decoded.slice(0, -1) : decoded
        // Compaction removes dialogue from the provider working set, not from
        // durable history. Bind native dispatch to the latest real User before
        // this assistant, never to summary text or an older convenient input.
        const dispatchUser = input.dispatch && lastDecoded
          ? yield* tx.select().from(SessionMessageTable).where(and(
              eq(SessionMessageTable.session_id, input.sessionID),
              eq(SessionMessageTable.type, "user"),
              lt(SessionMessageTable.seq, lastDecoded.seq),
            )).orderBy(desc(SessionMessageTable.seq)).limit(1).get().pipe(Effect.orDie)
          : undefined
        const assignment = input.dispatch
          ? dispatchUser && {
              seq: dispatchUser.seq,
              message: yield* Schema.decodeUnknownEffect(SessionMessage.Message)({
                ...dispatchUser.data, id: dispatchUser.id, type: dispatchUser.type,
              }).pipe(Effect.mapError(() => new CaptureConflict({ reason: "history" }))),
            }
          : candidate.findLast((entry) => entry.message.type === "user")
        const originID = input.dispatch ? assignment?.message.id : undefined
        const origin = originID
          ? yield* tx
              .select()
              .from(SessionInputTable)
              .where(
                and(
                  eq(SessionInputTable.id, originID),
                  eq(SessionInputTable.session_id, input.sessionID),
                ),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.dispatch && (assignment?.message.type !== "user" || !origin ||
          origin.promoted_seq !== assignment.seq || origin.prompt.text !== assignment.message.text))
          return yield* new CaptureConflict({ reason: "boundary" })
        const entries = candidate
        // Model switches are display markers, not dispatch predecessors. Keep
        // them in the captured history and validate the actual predecessor.
        const last = (nativeDispatch
          ? entries.findLast(({ message }) => message.type !== "model-switched")
          : entries.at(-1))?.message
        if (
          (entries.length > 0 &&
            !(nativeDispatch && (last?.type === "user" || last?.type === "system" ||
              (last?.type === "compaction" && last.summary.trim().length > 0))) &&
            (last?.type !== "assistant" ||
              last.time.completed === undefined ||
              (last.finish !== "stop" && last.finish !== "tool-calls") ||
              last.error ||
              last.failure)) ||
          (entries.length === 0 && !(nativeDispatch && context === "fresh"))
        )
          return yield* new CaptureConflict({ reason: "boundary" })
        const basis = nativeDispatch
          ? lastDecoded?.message.type === "assistant"
            ? lastDecoded.message
            : undefined
          : last?.type === "assistant"
            ? last
            : undefined
        if (!basis || epoch.agent !== basis.agent) return yield* new CaptureConflict({ reason: "epoch" })
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
          context,
          // Revalidate the deferred ledger without exposing its prompts or
          // treating future work as authority for this assignment.
          deferredInputs: pending,
          directory: session.directory,
          // Never copy Session metadata, questions, inboxes or capability leases.
          epoch,
          entries,
          // Capture/retry evidence only: do not re-import compacted dialogue or
          // copy its inbox/provenance into the child. Revalidation binds it too.
          dispatchInput: input.dispatch ? assignment : undefined,
          selectedAgent: session.agent,
          actualAgent: basis.agent,
          selectedModel: session.model,
          actualModel: basis.model,
          permission: session.permission,
          agentPolicy: session.agent_policy,
        }
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export type Capture = Effect.Success<ReturnType<typeof capture>>
