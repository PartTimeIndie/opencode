export * as TurnCompletionV2 from "./turn-completion-v2"

import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { QuestionTable } from "@opencode-ai/core/question/sql"
import { SessionActivityTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionTerminal } from "@opencode-ai/core/session/terminal"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTodo } from "@opencode-ai/core/session/todo"
import { SessionTurnContinuation } from "@opencode-ai/core/session/turn-continuation"
import { Identifier } from "@opencode-ai/core/util/identifier"
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Exit, Layer, Option, Schedule, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { TurnCompletion } from "./turn-completion"

export interface Interface {
  readonly ready: true
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TurnCompletionV2") {}

export const DESKTOP_BACKGROUND_STARTUP_DELAY_MS = 65_000

// SQLite reports this before a contended insert acquires its write lock, so retrying is safe.
const lockRetrySchedule = Schedule.exponential("25 millis").pipe(Schedule.jittered, Schedule.both(Schedule.recurs(3)))
const isRetryableLock = (error: unknown) =>
  /database is locked|locktimeouterror/i.test(error instanceof Error ? error.message : String(error))

export function backgroundStartupDelayMs(env: Readonly<Record<string, string | undefined>> = process.env) {
  return env.OPENCODE_DEFER_BACKGROUND_STARTUP === "1" ? DESKTOP_BACKGROUND_STARTUP_DELAY_MS : 0
}

// The whole claimed operation is guarded at 55 seconds; keep ample time for interrupt cleanup and lease release.
const CLAIM_DURATION_MS = 2 * 60_000
const RETRY_BASE_DELAY_MS = 5_000
const RETRY_MAX_DELAY_MS = 5 * 60_000
const RETRY_INTERVAL = "5 seconds"
const TERMINAL_ACTIVITY_STATUSES = ["completed", "failed", "interrupted"] as const
type CompletionResult = TurnCompletion.Status | "skipped"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const completion = yield* TurnCompletion.Service
    const instances = yield* InstanceStore.Service
    // Optional so embedded/test graphs without an execution layer still terminalize markers.
    const execution = Option.getOrUndefined(yield* Effect.serviceOption(SessionExecution.Service))
    const { db } = yield* Database.Service

    const release = Effect.fn("TurnCompletionV2.release")(function* (
      activityID: string,
      ownerID: string,
      attempts: number,
      error: string,
    ) {
      const now = yield* Clock.currentTimeMillis
      yield* db
        .update(SessionActivityTable)
        .set({
          turn_completion_state: sql`CASE WHEN ${SessionActivityTable.turn_completion_result} IS NULL THEN NULL ELSE 'ready' END`,
          turn_completion_owner_id: null,
          // An unclaimed lease is the persistent not-before timestamp for the next retry.
          turn_completion_lease_until: now + retryDelay(attempts),
          turn_completion_error: error,
        })
        .where(
          and(
            eq(SessionActivityTable.id, activityID),
            eq(SessionActivityTable.turn_completion_state, "running"),
            eq(SessionActivityTable.turn_completion_owner_id, ownerID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    /**
     * Continues one unfinished turn after a completed activity was judged incomplete.
     * Guarded by an atomic claim so concurrent processes resume a Session at most once,
     * bounded by the durable continuation lineage, and skipped while a blocking question is still open
     * for that Session (the user is being asked something). The TurnCompleted event is
     * deferred to the successor activity when a continuation is queued.
     */
    const autoResume = Effect.fn("TurnCompletionV2.autoResume")(function* (
      sessionID: SessionID,
      activityID: string,
      ownerID: string,
      attempts: number,
      progress?: string,
    ) {
      if (!execution) return false
      const previous = yield* SessionTurnContinuation.read(db, sessionID)
      // Older builds may have consumed the instruction without retiring its parent.
      // Reconcile that handoff even when the successor has opened a question.
      if (!(previous?.activityID === activityID && previous.consumedAt !== undefined)) {
        const pendingQuestion = yield* db
          .select({ id: QuestionTable.id })
          .from(QuestionTable)
          .where(
            and(
              eq(QuestionTable.session_id, sessionID),
              inArray(QuestionTable.state, ["queued", "active"]),
              eq(QuestionTable.detached, false),
            ),
          )
          .limit(1)
          .get()
          .pipe(Effect.orDie)

        if (pendingQuestion) {
          yield* db
            .update(SessionActivityTable)
            .set({
              turn_completion_attempts: sql`${SessionActivityTable.turn_completion_attempts} - 1`,
            })
            .where(
              and(
                eq(SessionActivityTable.id, activityID),
                eq(SessionActivityTable.turn_completion_state, "running"),
                eq(SessionActivityTable.turn_completion_owner_id, ownerID),
                eq(SessionActivityTable.turn_completion_attempts, attempts),
              ),
            )
            .run()
            .pipe(Effect.orDie)
          return false
        }

        // Keep the terminalization claim throughout scheduling. Releasing it to `ready`
        // before enqueue lets the periodic scan schedule the same slow successor again.
        // Claim attempts count delivery/evaluation retries, not executed continuations.
        const continuation = yield* SessionTurnContinuation.arm(db, sessionID, activityID, progress)
        if (!continuation) return false
        if (continuation.consumedAt === undefined) yield* execution.queueContinuation(sessionID)
      }
      yield* db
        .update(SessionActivityTable)
        .set({
          turn_completion_state: "done",
          turn_completion_owner_id: null,
          turn_completion_lease_until: null,
          turn_completion_completed_at: yield* Clock.currentTimeMillis,
        })
        .where(
          and(
            eq(SessionActivityTable.id, activityID),
            eq(SessionActivityTable.turn_completion_state, "running"),
            eq(SessionActivityTable.turn_completion_owner_id, ownerID),
            eq(SessionActivityTable.turn_completion_attempts, attempts),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      return true
    })

    const terminalize = Effect.fn("TurnCompletionV2.terminalize")(function* (
      activityID: string,
      expected?: { sessionID: string; status: (typeof TERMINAL_ACTIVITY_STATUSES)[number] },
    ) {
      const now = yield* Clock.currentTimeMillis
      const ownerID = Identifier.ascending()
      const claimed = yield* db
        .update(SessionActivityTable)
        .set({
          turn_completion_state: "running",
          turn_completion_owner_id: ownerID,
          turn_completion_lease_until: now + CLAIM_DURATION_MS,
          turn_completion_attempts: sql`${SessionActivityTable.turn_completion_attempts} + 1`,
          turn_completion_error: null,
        })
        .where(
          and(
            eq(SessionActivityTable.id, activityID),
            ...(expected ? [eq(SessionActivityTable.session_id, SessionID.make(expected.sessionID))] : []),
            ...(expected ? [eq(SessionActivityTable.status, expected.status)] : []),
            inArray(SessionActivityTable.status, TERMINAL_ACTIVITY_STATUSES),
            claimable(now),
          ),
        )
        .returning({
          sessionID: SessionActivityTable.session_id,
          status: SessionActivityTable.status,
          result: SessionActivityTable.turn_completion_result,
          attempts: SessionActivityTable.turn_completion_attempts,
          closedSeq: SessionActivityTable.closed_seq,
        })
        .get()
        .pipe(Effect.retry({ while: isRetryableLock, schedule: lockRetrySchedule }), Effect.orDie)
      if (!claimed) return

      const exit = yield* Effect.gen(function* () {
        const stored = yield* db
          .select({
            agent: SessionTable.agent,
            directory: SessionTable.directory,
            workspaceID: SessionTable.workspace_id,
          })
          .from(SessionTable)
          .where(eq(SessionTable.id, claimed.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new Error(`Turn completion session not found: ${claimed.sessionID}`))

        const saved = completionResult(claimed.result)
        const skipProjectStartup = claimed.status !== "completed" || saved === "done"
        const settle = Effect.gen(function* () {
          const actionableTodos =
            claimed.status === "completed"
              ? (yield* SessionTodo.load(db, SessionID.make(claimed.sessionID))).filter(
                  (todo) => todo.status === "pending" || todo.status === "in_progress",
                )
              : []
          const progress =
            actionableTodos.length === 0
              ? undefined
              : JSON.stringify(
                  actionableTodos.map((todo, order) => ({ order, content: todo.content, status: todo.status })),
                )
          // Todo progress bounds retries; it must not bypass the configured evaluator,
          // which also handles disabled completion and final reports with stale todos.
          const messages =
            claimed.status === "completed"
              ? yield* durableCompletionMessages(db, SessionID.make(claimed.sessionID), claimed.closedSeq)
              : []
          const resolved =
            saved ??
            (claimed.status === "completed"
              ? ((yield* completion.resolve(SessionID.make(claimed.sessionID), {
                  agent: stored.agent ?? undefined,
                  messages,
                })) ?? "skipped")
              : "incomplete")
          // An unavailable evaluator may return `unknown` even though the
          // durable V2 history already contains a terminal provider result.
          // Keep that fallback separate from explicit failure or policy vetoes.
          const durableResult =
            claimed.status === "completed"
              ? (TurnCompletion.historyStatus(messages) ??
                SessionTerminal.assistantResult(
                  messages.toReversed().find((message) => message.info.role === "assistant"),
                ))
              : undefined
          const durableReport = claimed.status === "completed" && TurnCompletion.hasSubstantialFinalReport(messages)
          const result =
            resolved === "unknown" &&
            claimed.status === "completed" &&
            (durableResult === "incomplete" ||
              (durableResult === "done" && (actionableTodos.length === 0 || durableReport)) ||
              durableReport)
              ? durableResult === "incomplete"
                ? "incomplete"
                : "done"
              : resolved

          if (!saved) {
            const updated = yield* db
              .update(SessionActivityTable)
              .set({ turn_completion_result: result })
              .where(
                and(
                  eq(SessionActivityTable.id, activityID),
                  eq(SessionActivityTable.turn_completion_state, "running"),
                  eq(SessionActivityTable.turn_completion_owner_id, ownerID),
                ),
              )
              .returning({ id: SessionActivityTable.id })
              .get()
              .pipe(Effect.orDie)
            if (!updated) return
          }

          if (result === "done") yield* SessionTurnContinuation.reset(db, SessionID.make(claimed.sessionID))

          if (result === "skipped") {
            yield* db
              .update(SessionActivityTable)
              .set({
                turn_completion_state: "done",
                turn_completion_owner_id: null,
                turn_completion_lease_until: null,
                turn_completion_completed_at: yield* Clock.currentTimeMillis,
              })
              .where(
                and(
                  eq(SessionActivityTable.id, activityID),
                  eq(SessionActivityTable.turn_completion_state, "running"),
                  eq(SessionActivityTable.turn_completion_owner_id, ownerID),
                ),
              )
              .run()
              .pipe(Effect.orDie)
            return
          }

          if (result === "incomplete" && claimed.status === "completed" && execution !== undefined) {
            const resumed = yield* autoResume(
              SessionID.make(claimed.sessionID),
              activityID,
              ownerID,
              claimed.attempts,
              progress,
            )
            // While a resume is armed the verdict stays deferred: the Session continues
            // instead of flashing incomplete to the UI. Once the budget is exhausted
            // (autoResume returns false), the normal publish below reports incomplete.
            if (resumed) return
          }

          yield* events.publish(
            SessionStatus.Event.TurnCompleted,
            { sessionID: SessionID.make(claimed.sessionID), status: result },
            {
              id: EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: activityID }),
              ...(skipProjectStartup
                ? {
                    location: Location.Ref.make({
                      directory: AbsolutePath.make(stored.directory),
                      workspaceID: stored.workspaceID ?? undefined,
                    }),
                  }
                : {}),
              commit: () =>
                Effect.gen(function* () {
                  const updated = yield* db
                    .update(SessionActivityTable)
                    .set({
                      turn_completion_state: "done",
                      turn_completion_owner_id: null,
                      turn_completion_lease_until: null,
                      turn_completion_completed_at: yield* Clock.currentTimeMillis,
                    })
                    .where(
                      and(
                        eq(SessionActivityTable.id, activityID),
                        eq(SessionActivityTable.turn_completion_state, "running"),
                        eq(SessionActivityTable.turn_completion_owner_id, ownerID),
                        eq(SessionActivityTable.turn_completion_result, result),
                      ),
                    )
                    .returning({ id: SessionActivityTable.id })
                    .get()
                    .pipe(Effect.orDie)
                  if (!updated) return yield* Effect.die(new Error(`Turn completion claim lost: ${activityID}`))
                }),
            },
          )
        })
        // Historical failures/stops and an already decided DONE need no config
        // or plugin evaluation. Starting their projects can stall foreground reads.
        yield* (
          skipProjectStartup
            ? settle.pipe(Effect.provideService(InstanceRef, undefined))
            : instances.provide({ directory: stored.directory }, settle)
        ).pipe(Effect.provideService(WorkspaceRef, stored.workspaceID ?? undefined))
      }).pipe(
        Effect.exit,
        Effect.timeoutOrElse({
          duration: TurnCompletion.IDLE_GUARD_TIMEOUT,
          orElse: () => Effect.succeed(undefined),
        }),
      )
      if (exit === undefined) {
        yield* release(activityID, ownerID, claimed.attempts, "terminal evaluation timed out")
        yield* Effect.logWarning("TurnCompletionV2: terminal evaluation timed out", {
          activityID,
          sessionID: claimed.sessionID,
        })
        return
      }
      if (Exit.isSuccess(exit)) return
      yield* release(activityID, ownerID, claimed.attempts, Cause.pretty(exit.cause))
      yield* Effect.logWarning("TurnCompletionV2: terminal evaluation failed", {
        activityID,
        sessionID: claimed.sessionID,
        cause: Cause.pretty(exit.cause),
      })
    })

    const handle = (activityID: string, expected?: Parameters<typeof terminalize>[1]) =>
      terminalize(activityID, expected).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("TurnCompletionV2: terminalization failed before claim", {
            activityID,
            cause: Cause.pretty(cause),
          }),
        ),
      )

    const scan = Effect.fn("TurnCompletionV2.scan")(function* () {
      const now = yield* Clock.currentTimeMillis
      const rows = yield* db
        .select({ id: SessionActivityTable.id })
        .from(SessionActivityTable)
        .where(and(inArray(SessionActivityTable.status, TERMINAL_ACTIVITY_STATUSES), claimable(now)))
        .orderBy(
          asc(SessionActivityTable.turn_completion_attempts),
          asc(SessionActivityTable.time_updated),
          asc(SessionActivityTable.id),
        )
        .limit(100)
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(rows, (row) => handle(row.id), { discard: true })
    })

    const background = Effect.gen(function* () {
      const delay = backgroundStartupDelayMs()
      if (delay > 0) yield* Effect.sleep(delay)

      const unsubscribe = yield* events.listen((event) => {
        const status = terminalStatus(event.type)
        if (!status) return Effect.void
        const data = event.data
        if (typeof data !== "object" || data === null) return Effect.void
        if (!("activityID" in data) || typeof data.activityID !== "string") return Effect.void
        if (!("sessionID" in data) || typeof data.sessionID !== "string") return Effect.void
        return handle(data.activityID, { sessionID: data.sessionID, status })
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* Effect.forever(
        scan().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("TurnCompletionV2: retry scan failed", { cause: Cause.pretty(cause) }),
          ),
          Effect.andThen(Effect.sleep(RETRY_INTERVAL)),
        ),
      )
    })
    if (backgroundStartupDelayMs() > 0) {
      yield* background.pipe(Effect.forkScoped)
    } else {
      yield* background.pipe(Effect.forkScoped)
      yield* Effect.yieldNow
    }

    return Service.of({ ready: true })
  }),
)

function claimable(now: number) {
  return and(
    or(
      isNull(SessionActivityTable.turn_completion_state),
      eq(SessionActivityTable.turn_completion_state, "ready"),
      eq(SessionActivityTable.turn_completion_state, "running"),
    ),
    or(
      isNull(SessionActivityTable.turn_completion_lease_until),
      lte(SessionActivityTable.turn_completion_lease_until, now),
    ),
  )
}

function retryDelay(attempts: number) {
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 16))
}

function completionResult(value: string | null): CompletionResult | undefined {
  if (value === "plan_ready") return "incomplete"
  if (value === "done" || value === "incomplete" || value === "unknown" || value === "skipped") return value
}

function durableCompletionMessages(db: Database.Interface["db"], sessionID: SessionID, closedSeq: number | null) {
  return Effect.gen(function* () {
    // V2 runners do not populate the legacy message/part tables. Pass their
    // durable history through the same evaluator, including plugin vetoes.
    const rows = yield* db
      .select({
        id: SessionMessageTable.id,
        type: SessionMessageTable.type,
        data: SessionMessageTable.data,
        seq: SessionMessageTable.seq,
      })
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, sessionID),
          inArray(SessionMessageTable.type, ["user", "assistant"]),
          ...(closedSeq === null ? [] : [lte(SessionMessageTable.seq, closedSeq)]),
        ),
      )
      .orderBy(sql`${SessionMessageTable.seq} DESC`)
      .limit(200)
      .all()
      .pipe(Effect.orDie)
    const assistant = rows.find((row) => row.type === "assistant")
    if (assistant && !rows.some((row) => row.type === "user" && row.seq < assistant.seq)) {
      // Fetch one genuine task anchor, not an unbounded history. Its sequence
      // precedes this activity's answer; synthetic continuation text cannot win.
      const task = yield* db
        .select({
          id: SessionMessageTable.id,
          type: SessionMessageTable.type,
          data: SessionMessageTable.data,
          seq: SessionMessageTable.seq,
        })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "user"),
            lte(SessionMessageTable.seq, assistant.seq),
          ),
        )
        .orderBy(sql`${SessionMessageTable.seq} DESC`)
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (task) rows.push(task)
    }
    return rows.reverse().map((row): TurnCompletion.CompletionMessage => {
      const message = Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type })
      if (message.type === "assistant")
        return {
          info: { role: message.type, finish: message.finish, error: message.error },
          parts: message.content.map((part) =>
            part.type === "tool"
              ? {
                  type: part.type,
                  tool: part.name,
                  state: {
                    status: part.state.status,
                    metadata: "structured" in part.state ? part.state.structured : undefined,
                  },
                }
              : part,
          ),
        }
      return { info: { role: "user" }, parts: message.type === "user" ? [{ type: "text", text: message.text }] : [] }
    })
  })
}

function terminalStatus(type: string) {
  if (type === SessionEvent.Activity.Completed.type) return "completed" as const
  if (type === SessionEvent.Activity.Failed.type) return "failed" as const
  if (type === SessionEvent.Activity.Interrupted.type) return "interrupted" as const
}

export const node = LayerNode.make(layer, [EventV2Bridge.node, TurnCompletion.node, InstanceStore.node, Database.node])
