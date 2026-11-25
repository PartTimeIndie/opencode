export * as CrashGuard from "./crash-guard"

import { and, asc, desc, eq, gt, gte, inArray, isNull, or } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { Database } from "../database/database"
import { EventCheckpointTable, EventTable } from "../event/sql"
import { EventV2 } from "../event"
import { FileMutationPendingTable } from "../file-knowledge.sql"
import { BackgroundJobTable } from "../background-job.sql"
import { QuestionTable } from "../question/sql"
import { SessionActivityTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import { SessionMessage } from "./message"
import { SessionEvent } from "./event"

type Transaction = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]

// Runs under the same immediate transaction as the activity ownership claim.
// Ambiguous evidence pauses only this session; it never repairs or replays tools.
export const inspect = Effect.fn("CrashGuard.inspect")(function* (
  tx: Transaction,
  activity: typeof SessionActivityTable.$inferSelect,
) {
  const sessionID = activity.session_id
  const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
  if (!session?.agent || !session.model) return "Gespeicherte Agent-/Modellauswahl fehlt"
  if (session.parent_id) return "Untergeordnete Session benötigt ihren ursprünglichen Auftraggeber"
  if (session.time_archived || session.revert) return "Session ist archiviert oder hat eine offene Wiederherstellung"
  if (activity.opened_seq === null || activity.recovery_attempts >= 3) return "Wiederaufnahme-Budget oder Aktivitätsgrenze fehlt"
  const questions = yield* tx.select({ id: QuestionTable.id }).from(QuestionTable).where(and(
    eq(QuestionTable.session_id, sessionID),
    eq(QuestionTable.mode, "blocking"),
    eq(QuestionTable.detached, false),
    inArray(QuestionTable.state, ["queued", "active", "orphaned"]),
  )).get()
  if (questions) return "Offene Frage oder Freigabe"
  const mutation = yield* tx.select({ target: FileMutationPendingTable.target }).from(FileMutationPendingTable)
    .where(eq(FileMutationPendingTable.session_id, sessionID)).get()
  if (mutation) return "Unbestätigte Dateiänderung; zuerst den tatsächlichen Zustand prüfen"
  const job = yield* tx.select({ id: BackgroundJobTable.id }).from(BackgroundJobTable).where(or(
    eq(BackgroundJobTable.parent_session_id, sessionID), eq(BackgroundJobTable.child_session_id, sessionID),
  )).get()
  if (job) return "Separat verwalteter Hintergrundauftrag"
  const input = yield* tx.select({ id: SessionInputTable.id }).from(SessionInputTable).where(and(
    eq(SessionInputTable.session_id, sessionID),
    or(isNull(SessionInputTable.promoted_seq), gt(SessionInputTable.admitted_seq, activity.opened_seq)),
  )).get()
  if (input) return "Neuere oder noch nicht verarbeitete Eingabe"
  const checkpoint = yield* tx.select({ seq: EventCheckpointTable.seq }).from(EventCheckpointTable)
    .where(and(eq(EventCheckpointTable.aggregate_id, sessionID), gt(EventCheckpointTable.seq, activity.opened_seq))).get()
  if (checkpoint) return "Aktivitätsnachweise wurden bereits verdichtet"
  const boundary = yield* tx
    .select({ seq: EventTable.seq, type: EventTable.type })
    .from(EventTable)
    .where(and(
      eq(EventTable.aggregate_id, sessionID), gt(EventTable.seq, activity.opened_seq),
      inArray(EventTable.type, [
        SessionEvent.InterruptRequested, SessionEvent.Retried, SessionEvent.Step.Failed,
        SessionEvent.ModelSwitched, SessionEvent.AgentSwitched,
      ].flatMap((event) => [event.type, EventV2.versionedType(event.type, event.sync?.version ?? 1)])),
    )).all()
  // The activity's oldest assistant message marks the start of executed model work.
  // Selection persistence before that point belongs to the interrupted turn's own
  // setup (first-input promotion or runner adoption), so it must not read as a
  // user selection change; the message check below still verifies the executed
  // selection. A change after executed model work — and every stop, retry or
  // failure boundary — keeps pausing recovery.
  const firstAssistant = yield* tx.select({ seq: SessionMessageTable.seq }).from(SessionMessageTable).where(and(
    eq(SessionMessageTable.session_id, sessionID),
    gte(SessionMessageTable.time_created, activity.time_created),
    eq(SessionMessageTable.type, "assistant"),
  )).orderBy(asc(SessionMessageTable.seq)).limit(1).get()
  const selectionTypes = new Set([SessionEvent.ModelSwitched, SessionEvent.AgentSwitched]
    .flatMap((event) => [event.type, EventV2.versionedType(event.type, event.sync?.version ?? 1)]))
  const blocked = boundary.some((event) =>
    selectionTypes.has(event.type) ? firstAssistant !== undefined && event.seq >= firstAssistant.seq : true)
  // Preserve retry budgets and explicit selection boundaries, even after switching back.
  if (blocked) return "Stop, Auswahlwechsel oder bereits begonnene Fehlerbehandlung in dieser Aktivität"
  const rows = yield* tx.select().from(SessionMessageTable).where(and(
    eq(SessionMessageTable.session_id, sessionID),
    gte(SessionMessageTable.time_created, activity.time_created),
  )).orderBy(desc(SessionMessageTable.seq)).limit(1001).all()
  if (rows.length > 1000) return "Aktivität ist für eine sichere automatische Prüfung zu groß"
  let assistant = false
  for (const row of rows) {
    const decoded = Schema.decodeUnknownOption(SessionMessage.Message)({ ...row.data, type: row.type, id: row.id })
    if (Option.isNone(decoded)) return "Gespeicherte Nachricht kann nicht sicher gelesen werden"
    const message = decoded.value
    if (message.type === "shell" && message.time.completed === undefined) return "Shell-Befehl ohne bestätigtes Ergebnis"
    if (message.type !== "assistant") continue
    if (message.error || message.failure) return "Gespeicherter Modellfehler benötigt Prüfung"
    if (message.content.some((part) => part.type === "tool" && part.state.status !== "completed"))
      return "Tool-Aufruf ohne bestätigten Abschluss; keine automatische Wiederholung"
    if (!assistant) {
      assistant = true
      if (message.agent !== session.agent || message.model.id !== session.model.id ||
        message.model.providerID !== session.model.providerID || message.model.variant !== session.model.variant)
        return "Modell oder Agent wurde seit dem unterbrochenen Aufruf geändert"
    }
  }
  if (!assistant) return "Kein gespeicherter Modellaufruf für diese Aktivität"
})
