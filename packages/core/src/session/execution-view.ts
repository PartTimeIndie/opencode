export * as SessionExecutionView from "./execution-view"

import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import { QuestionTable } from "../question/sql"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionActivityTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"

/** Read durable execution evidence. This never admits input or wakes provider work. */
export function read(database: Database.Interface, input: {
  sessionID: string
  messageID: string
  activityID?: string
  followContinuations?: boolean
  /** New job bindings must match the original promoted input; legacy recovery may move its saved activity window. */
  requireOriginalActivity?: boolean
}) {
  return Effect.gen(function* () {
    const sessionID = SessionSchema.ID.make(input.sessionID)
    const admitted = yield* database.db.select().from(SessionInputTable).where(and(
      eq(SessionInputTable.id, SessionMessage.ID.make(input.messageID)), eq(SessionInputTable.session_id, sessionID),
    )).get().pipe(Effect.orDie)
    if (!admitted) return { phase: "admission_missing" as const }
    if (admitted.promoted_seq === null) return { phase: "admitted" as const }
    const root = yield* database.db.select().from(SessionActivityTable).where(and(
      eq(SessionActivityTable.session_id, sessionID),
      ...(input.activityID ? [eq(SessionActivityTable.id, input.activityID)] : []),
      ...(!input.activityID || input.requireOriginalActivity ? [
        lt(SessionActivityTable.opened_seq, admitted.promoted_seq),
        or(gte(SessionActivityTable.closed_seq, admitted.promoted_seq), and(isNull(SessionActivityTable.closed_seq),
          inArray(SessionActivityTable.status, ["running", "recovering", "orphaned"]))),
      ] : []),
    )).orderBy(desc(SessionActivityTable.opened_seq), desc(SessionActivityTable.time_created), desc(SessionActivityTable.id)).limit(1).get().pipe(Effect.orDie)
    if (!root) return { phase: "promoted" as const }
    const followContinuations = input.followContinuations && !input.requireOriginalActivity
    const next = followContinuations ? yield* database.db.select({ time: SessionInputTable.time_created }).from(SessionInputTable)
      .where(and(eq(SessionInputTable.session_id, sessionID), gt(SessionInputTable.admitted_seq, admitted.admitted_seq)))
      .orderBy(asc(SessionInputTable.admitted_seq)).limit(1).get().pipe(Effect.orDie) : undefined
    const activity = followContinuations ? (yield* database.db.select().from(SessionActivityTable).where(and(
      eq(SessionActivityTable.session_id, sessionID), gte(SessionActivityTable.time_created, root.time_created),
      ...(next ? [lt(SessionActivityTable.time_created, next.time)] : []),
    )).orderBy(desc(SessionActivityTable.time_created), desc(SessionActivityTable.id)).limit(1).get().pipe(Effect.orDie)) ?? root : root
    const questions = yield* database.db.select({ id: QuestionTable.id, state: QuestionTable.state }).from(QuestionTable).where(and(
      eq(QuestionTable.session_id, sessionID), eq(QuestionTable.activity_id, activity.id), eq(QuestionTable.detached, false),
      inArray(QuestionTable.state, ["queued", "active", "rejected"]),
    )).all().pipe(Effect.orDie)
    const assistants = activity.closed_seq === null ? [] : yield* database.db.select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq, data: SessionMessageTable.data }).from(SessionMessageTable).where(and(
      eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant"),
      gt(SessionMessageTable.seq, admitted.promoted_seq), lte(SessionMessageTable.seq, activity.closed_seq),
    )).orderBy(asc(SessionMessageTable.seq)).all().pipe(Effect.orDie)
    const laterInputs = activity.closed_seq === null ? [] : yield* database.db.select({ seq: SessionInputTable.promoted_seq }).from(SessionInputTable).where(and(
      eq(SessionInputTable.session_id, sessionID), gt(SessionInputTable.promoted_seq, admitted.promoted_seq),
      lte(SessionInputTable.promoted_seq, activity.closed_seq),
    )).orderBy(asc(SessionInputTable.promoted_seq)).all().pipe(Effect.orDie)
    const laterAdmissions = yield* database.db.select({ id: SessionInputTable.id }).from(SessionInputTable).where(and(
      eq(SessionInputTable.session_id, sessionID), gt(SessionInputTable.admitted_seq, admitted.admitted_seq),
    )).limit(1).all().pipe(Effect.orDie)
    return { phase: "activity" as const, activity: {
      id: activity.id, status: activity.status, closed_seq: activity.closed_seq, last_error: activity.last_error,
      reason: activity.reason, turn_completion_state: activity.turn_completion_state, turn_completion_result: activity.turn_completion_result,
    }, questions, assistants, laterInputs: laterInputs.flatMap((item) => item.seq === null ? [] : [item.seq]),
      laterAdmissions: laterAdmissions.map((item) => item.id) }
  })
}

/** Observe a saved native Main attempt. The caller must load the binding from
 * its own host receipt; this view grants neither read access nor write consent. */
export function readMainTask(database: Database.Interface, input: {
  parentSessionID: string
  sessionID: string
  messageID: string
  dispatchDigest: string
  placementIdentity: string
  activityID?: string
}) {
  const binding = { ...input }
  const mismatch = { phase: "task_binding_mismatch" as const }
  return Effect.gen(function* () {
    const lookup = database.db.select({ policy: SessionTable.agent_policy }).from(SessionTable).where(and(
      eq(SessionTable.id, SessionSchema.ID.make(binding.sessionID)),
      eq(SessionTable.parent_id, SessionSchema.ID.make(binding.parentSessionID)),
      eq(SessionTable.fork_dispatch_digest, binding.dispatchDigest),
    )).get().pipe(Effect.orDie)
    const matches = (row: Effect.Success<typeof lookup>) => {
      const policy = row?.policy
      const consent = policy?.mainWriteConsent
      return policy?.source?.type === "task" && policy.source.sessionID === binding.parentSessionID &&
        !policy.readOnly && !policy.mirrorWorkspace && policy.executionPlacement?.version === 1 &&
        policy.executionPlacement.identity === binding.placementIdentity && consent?.version === 1 &&
        /^per/.test(consent.permissionID) && consent.placementIdentity === binding.placementIdentity &&
        consent.dispatchDigest === binding.dispatchDigest && consent.inputID === binding.messageID
    }
    if (!/^[a-f0-9]{64}$/.test(binding.dispatchDigest) || !binding.placementIdentity || !matches(yield* lookup)) return mismatch
    const observation = yield* read(database, { ...binding, requireOriginalActivity: true })
    // A follow-up can rebind the same child while the evidence is being read.
    return matches(yield* lookup) ? observation : mismatch
  })
}
