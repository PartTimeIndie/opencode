export * as SessionInput from "./input"

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { EventSequenceTable } from "../event/sql"
import { NonNegativeInt } from "../schema"
import { V2Schema } from "../v2-schema"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionAgentPolicy } from "./agent-policy"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionActivityTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export const Delivery = Schema.Literals(["steer", "queue"])
export type Delivery = typeof Delivery.Type

/** Transport-attested admission provenance. Absent means unattested (legacy rows). */
export const Origin = Schema.Literals(["interactive", "plugin"])
export type Origin = typeof Origin.Type

export class Admitted extends Schema.Class<Admitted>("SessionInput.Admitted")({
  admittedSeq: NonNegativeInt,
  id: SessionMessage.ID,
  sessionID: SessionSchema.ID,
  prompt: Prompt,
  delivery: Delivery,
  timeCreated: V2Schema.DateTimeUtcFromMillis,
  promotedSeq: NonNegativeInt.pipe(Schema.optional),
  origin: Origin.pipe(Schema.optional),
}) {}

const decodePrompt = Schema.decodeUnknownSync(Prompt)
const encodePrompt = Schema.encodeSync(Prompt)

const fromRow = (row: typeof SessionInputTable.$inferSelect): Admitted =>
  new Admitted({
    admittedSeq: row.admitted_seq,
    id: SessionMessage.ID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    prompt: decodePrompt(row.prompt),
    delivery: row.delivery,
    timeCreated: DateTime.makeUnsafe(row.time_created),
    ...(row.promoted_seq === null ? {} : { promotedSeq: row.promoted_seq }),
    ...(row.origin === null ? {} : { origin: row.origin }),
  })

export const held = Effect.fn("SessionInput.held")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNotNull(SessionInputTable.held_at),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)).map(fromRow)
})

export const holdPending = Effect.fn("SessionInput.holdPending")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(and(eq(SessionInputTable.session_id, sessionID), isNull(SessionInputTable.promoted_seq)))
    .all()
    .pipe(Effect.orDie)
  if (rows.length === 0) return rows
  yield* events.publish(SessionEvent.PromptLifecycle.Held, {
    sessionID,
    inputIDs: rows.map((row) => row.id),
    timestamp: yield* DateTime.now,
  })
  return rows
})

export const release = Effect.fn("SessionInput.release")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: { id: SessionMessage.ID; sessionID: SessionSchema.ID; prompt: Prompt },
) {
  const session = yield* db.select({ policy: SessionTable.agent_policy, dispatch: SessionTable.fork_dispatch_digest })
    .from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get().pipe(Effect.orDie)
  const original = session?.dispatch ? yield* find(db, input.id) : undefined
  // A steer admitted for a running dispatched child releases with the current
  // agent/model stamp that releaseInput legitimately adds. The bound task
  // assignment itself (also admitted as a steer) stays prompt-drift fenced.
  const patchableSteer = original !== undefined &&
    original.delivery === "steer" && original.id !== taskBoundInputID(session)
  if (session?.dispatch && (!original || (!patchableSteer && !matchesPrompt(original, input))))
    return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const row = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNotNull(SessionInputTable.held_at),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!row) return
  yield* events.publish(SessionEvent.PromptLifecycle.Released, {
    sessionID: input.sessionID,
    messageID: input.id,
    prompt: input.prompt,
    timestamp: yield* DateTime.now,
  })
  return yield* find(db, input.id)
})

export const projectHeld = Effect.fn("SessionInput.projectHeld")(function* (
  db: DatabaseService,
  input: { sessionID: SessionSchema.ID; inputIDs: ReadonlyArray<SessionMessage.ID>; heldAt: DateTime.Utc },
) {
  if (input.inputIDs.length === 0) return
  yield* db
    .update(SessionInputTable)
    .set({ held_at: DateTime.toEpochMillis(input.heldAt), execution_prompt: null })
    .where(
      and(
        eq(SessionInputTable.session_id, input.sessionID),
        inArray(SessionInputTable.id, input.inputIDs),
        isNull(SessionInputTable.promoted_seq),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

export const projectReleased = Effect.fn("SessionInput.projectReleased")(function* (
  db: DatabaseService,
  input: { sessionID: SessionSchema.ID; id: SessionMessage.ID; prompt: Prompt },
) {
  yield* db
    .update(SessionInputTable)
    .set({ held_at: null, execution_prompt: encodePrompt(input.prompt) })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNotNull(SessionInputTable.held_at),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

export const find = Effect.fn("SessionInput.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie)
  return row === undefined ? undefined : fromRow(row)
})

export class LifecycleConflict extends Schema.TaggedErrorClass<LifecycleConflict>()("SessionInput.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

/** The single task input a dispatched session's policy authorizes; every other send is fenced. */
const taskBoundInputID = (session?: { policy: (typeof SessionTable.$inferSelect)["agent_policy"] } | undefined) =>
  SessionAgentPolicy.isReadOnly(session?.policy ?? undefined)
    ? session?.policy?.readOnlyInputID
    : session?.policy?.mirrorWorkspace?.inputID ?? session?.policy?.mainWriteConsent?.inputID

export const admit = Effect.fn("SessionInput.admit")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly origin?: Origin
  },
) {
  const existing = yield* find(db, input.id)
  const session = yield* db.select({ policy: SessionTable.agent_policy, dispatch: SessionTable.fork_dispatch_digest })
    .from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get().pipe(Effect.orDie)
  // A task-scoped Main exception cannot authorize a later assignment. Keep this
  // guard below all transports, including direct task follow-ups and plugin sends.
  const boundInputID = taskBoundInputID(session)
  // Steering a running task child is a course correction inside its already
  // authorized activity, not a later assignment: the runtime holds and releases
  // it at the next safe turn like every other session's steer. The dispatch
  // fence keeps protecting assignment authority — a queue delivery or a send
  // to an idle dispatched session still requires the bound task input.
  const steerActiveTask =
    session?.dispatch !== undefined && session.dispatch !== null &&
    input.delivery === "steer" && boundInputID !== input.id
      ? (yield* db
          .select({ id: SessionActivityTable.id })
          .from(SessionActivityTable)
          .where(
            and(
              eq(SessionActivityTable.session_id, input.sessionID),
              inArray(SessionActivityTable.status, ["running", "recovering"]),
              gt(SessionActivityTable.lease_until, Date.now()),
            ),
          )
          .limit(1)
          .get()
          .pipe(Effect.orDie)) !== undefined
      : false
  if (session?.dispatch && !steerActiveTask && (boundInputID !== input.id ||
    (existing !== undefined && !equivalent(existing, input))))
    return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  if (existing !== undefined) return existing
  const timestamp = yield* DateTime.now
  return yield* events
    .publish(SessionEvent.PromptLifecycle.Admitted, {
      messageID: input.id,
      sessionID: input.sessionID,
      timestamp,
      prompt: input.prompt,
      delivery: input.delivery,
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    })
    .pipe(
      Effect.flatMap((event) =>
        event.seq === undefined
          ? Effect.die("Prompt admission event is missing aggregate sequence")
          : Effect.succeed(
              new Admitted({
                admittedSeq: event.seq,
                id: input.id,
                sessionID: input.sessionID,
                prompt: input.prompt,
                delivery: input.delivery,
                timeCreated: timestamp,
                ...(input.origin === undefined ? {} : { origin: input.origin }),
              }),
            ),
      ),
      Effect.catchDefect((defect) =>
        find(db, input.id).pipe(Effect.flatMap((stored) => (stored ? Effect.succeed(stored) : Effect.die(defect)))),
      ),
    )
})

export const latestSeq = Effect.fn("SessionInput.latestSeq")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return row?.seq ?? -1
})

export const projectAdmitted = Effect.fn("SessionInput.projectAdmitted")(function* (
  db: DatabaseService,
  input: {
    readonly admittedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
    readonly origin?: Origin
  },
) {
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (message) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const values = {
    id: input.id,
    session_id: input.sessionID,
    admitted_seq: input.admittedSeq,
    prompt: encodePrompt(input.prompt),
    delivery: input.delivery,
    time_created: DateTime.toEpochMillis(input.timeCreated),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
  }
  const stored = yield* db
    .insert(SessionInputTable)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectPromoted = Effect.fn("SessionInput.projectPromoted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  const updated = yield* db
    .update(SessionInputTable)
    .set({ promoted_seq: input.promotedSeq })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        isNull(SessionInputTable.promoted_seq),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const stored = fromRow({ ...updated, prompt: updated.execution_prompt ?? updated.prompt })
  if (
    !matchesPrompt(stored, input) ||
    DateTime.toEpochMillis(stored.timeCreated) !== DateTime.toEpochMillis(input.timeCreated)
  )
    return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  return toMessage(stored)
})

export const hasPending = Effect.fn("SessionInput.hasPending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.held_at),
        eq(SessionInputTable.delivery, delivery),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

export const projectDiscardPending = Effect.fn("SessionInput.projectDiscardPending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  return yield* db
    .delete(SessionInputTable)
    .where(and(eq(SessionInputTable.session_id, sessionID), isNull(SessionInputTable.promoted_seq)))
    .returning({ id: SessionInputTable.id })
    .all()
    .pipe(Effect.orDie, Effect.asVoid)
})

export const equivalent = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
  },
) => input.delivery === expected.delivery && matchesPrompt(input, expected)

const matchesPrompt = (input: Admitted, expected: { readonly sessionID: SessionSchema.ID; readonly prompt: Prompt }) =>
  input.sessionID === expected.sessionID &&
  JSON.stringify(encodePrompt(input.prompt)) === JSON.stringify(encodePrompt(expected.prompt))

export const guardReservedID = Effect.fn("SessionInput.guardReservedID")(function* (
  db: DatabaseService,
  event: EventV2.Payload,
) {
  if (
    Schema.is(SessionEvent.PromptLifecycle.Admitted)(event) ||
    Schema.is(SessionEvent.PromptLifecycle.Promoted)(event)
  )
    return
  const id = reservedID(event)
  if (id === undefined) return
  const admitted = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.id, id))
    .get()
    .pipe(Effect.orDie)
  if (admitted === undefined) return
  return yield* Effect.die(new LifecycleConflict({ id }))
})

const reservedID = (event: EventV2.Payload) => {
  if (Schema.is(SessionEvent.Step.Started)(event)) return event.data.assistantMessageID
  if (Schema.is(SessionEvent.AgentSwitched)(event)) return event.data.messageID
  if (Schema.is(SessionEvent.ModelSwitched)(event)) return event.data.messageID
  if (Schema.is(SessionEvent.Prompted)(event)) return event.data.messageID
  if (Schema.is(SessionEvent.Synthetic)(event)) return event.data.messageID
  if (Schema.is(SessionEvent.Shell.Started)(event)) return event.data.messageID
  if (Schema.is(SessionEvent.Compaction.Started)(event)) return event.data.messageID
}

export const projectLegacyPrompted = Effect.fn("SessionInput.projectLegacyPrompted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  const values = {
    id: input.id,
    session_id: input.sessionID,
    admitted_seq: input.promotedSeq,
    prompt: encodePrompt(input.prompt),
    delivery: input.delivery,
    promoted_seq: input.promotedSeq,
    time_created: DateTime.toEpochMillis(input.timeCreated),
  }
  const inserted = yield* db
    .insert(SessionInputTable)
    .values(values)
    .onConflictDoNothing()
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!inserted) return yield* Effect.die("Prompt projection conflicts with admitted input")
  return fromRow(inserted)
})

const publish = Effect.fn("SessionInput.publish")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInputTable.$inferSelect>,
) {
  for (const row of rows) {
    const prompt = decodePrompt(row.execution_prompt ?? row.prompt)
    yield* publishExecutionContext(db, events, sessionID, row.id, prompt, DateTime.makeUnsafe(row.time_created))
    yield* events
      .publish(SessionEvent.PromptLifecycle.Promoted, {
        sessionID,
        timestamp: yield* DateTime.now,
        messageID: SessionMessage.ID.make(row.id),
        prompt,
        timeCreated: DateTime.makeUnsafe(row.time_created),
      })
      .pipe(
        Effect.catchDefect((defect) =>
          defect instanceof LifecycleConflict
            ? find(db, SessionMessage.ID.make(row.id)).pipe(
                Effect.flatMap((stored) => (stored?.promotedSeq === undefined ? Effect.die(defect) : Effect.void)),
              )
            : Effect.die(defect),
        ),
      )
  }
  return rows.length
})

const publishExecutionContext = Effect.fn("SessionInput.publishExecutionContext")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  id: string,
  prompt: Prompt,
  timestamp: DateTime.Utc,
) {
  const session = yield* db
    .select({ agent: SessionTable.agent, model: SessionTable.model })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (prompt.agent && session?.agent !== prompt.agent) {
    yield* events.publish(SessionEvent.AgentSwitched, {
      sessionID,
      messageID: SessionMessage.ID.make(`${id}_agent`),
      timestamp,
      agent: prompt.agent,
    })
  }
  if (prompt.model && !sameModel(session?.model, prompt.model)) {
    yield* events.publish(SessionEvent.ModelSwitched, {
      sessionID,
      messageID: SessionMessage.ID.make(`${id}_model`),
      timestamp,
      model: prompt.model,
    })
  }
  const previousSystem = prompt.system
    ? yield* db
        .select({ data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "system")))
        .orderBy(desc(SessionMessageTable.seq))
        .get()
        .pipe(Effect.orDie)
    : undefined
  if (
    prompt.system &&
    (!previousSystem || !("text" in previousSystem.data) || previousSystem.data.text !== prompt.system)
  ) {
    yield* events.publish(SessionEvent.ContextUpdated, {
      sessionID,
      messageID: SessionMessage.ID.make(`${id}_system`),
      timestamp,
      text: prompt.system,
    })
  }
})

function sameModel(stored: (typeof SessionTable.$inferSelect)["model"] | undefined, next: Prompt["model"]) {
  return (
    stored !== undefined &&
    stored !== null &&
    next !== undefined &&
    stored.providerID === next.providerID &&
    stored.id === next.id &&
    (stored.variant ?? "default") === (next.variant ?? "default") &&
    JSON.stringify(stored.chain) === JSON.stringify(next.chain)
  )
}

export const promoteSteers = Effect.fn("SessionInput.promoteSteers")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  cutoff: number,
) {
  const latest = yield* db.select().from(SessionInputTable)
    .where(and(eq(SessionInputTable.session_id, sessionID), isNotNull(SessionInputTable.promoted_seq)))
    .orderBy(desc(SessionInputTable.promoted_seq)).limit(1).get().pipe(Effect.orDie)
  if (latest !== undefined && latest.promoted_seq !== null &&
    decodePrompt(latest.execution_prompt ?? latest.prompt).subtask !== undefined) {
    const assistant = yield* db.select({ seq: SessionMessageTable.seq }).from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant")))
      .orderBy(desc(SessionMessageTable.seq)).limit(1).get().pipe(Effect.orDie)
    if (!assistant || assistant.seq < latest.promoted_seq) return 0
  }
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.held_at),
        eq(SessionInputTable.delivery, "steer"),
        lte(SessionInputTable.admitted_seq, cutoff),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  // A command owns its own dispatch boundary. Do not coalesce a later steer
  // over it or turn several commands into only the last command's task.
  const command = rows.findIndex((row) => decodePrompt(row.execution_prompt ?? row.prompt).subtask !== undefined)
  const selected = command < 0 ? rows : rows.slice(0, command === 0 ? 1 : command)
  return yield* publish(db, events, sessionID, selected)
})

export const promoteNextQueued = Effect.fn("SessionInput.promoteNextQueued")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.held_at),
        eq(SessionInputTable.delivery, "queue"),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? false : yield* publish(db, events, sessionID, [row]).pipe(Effect.as(true))
})

const toMessage = (input: Admitted) =>
  new SessionMessage.User({
    id: input.id,
    type: "user",
    text: input.prompt.text,
    files: input.prompt.files,
    agents: input.prompt.agents,
    format: input.prompt.format,
    time: { created: input.timeCreated },
  })
