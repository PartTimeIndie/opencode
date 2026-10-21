export * as QuestionTransaction from "./transaction"

import { Cause, Effect, Schedule } from "effect"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { Database } from "../database/database"

type DatabaseService = Database.Interface["db"]
type Transaction = Parameters<Parameters<DatabaseService["transaction"]>[0]>[0]

const retrySchedule = Schedule.exponential("25 millis").pipe(Schedule.jittered, Schedule.both(Schedule.recurs(5)))

export function run<A, E>(
  db: DatabaseService,
  transaction: (tx: Transaction) => Effect.Effect<A, E>,
): Effect.Effect<A, E | SqlError> {
  return db.transaction(transaction).pipe(Effect.retry({ while: isRetryable, schedule: retrySchedule }))
}

function isRetryable(error: unknown) {
  const message =
    error instanceof EffectDrizzleQueryError && Cause.isCause(error.cause)
      ? Cause.pretty(error.cause)
      : error instanceof Error
        ? error.message
        : String(error)
  return (
    /database is locked|database table is locked|locktimeouterror|sqlite_busy/i.test(message) ||
    /session_question_(?:active|tool_retry|session_seq)_idx/i.test(message) ||
    /unique constraint failed:\s*session_question\.session_id(?:\s*(?:\r?\n|$)|,\s*session_question\.seq|,\s*session_question\.assistant_message_id,\s*session_question\.tool_call_id)/i.test(
      message,
    )
  )
}
