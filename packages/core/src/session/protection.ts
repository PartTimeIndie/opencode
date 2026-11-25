export * as SessionProtection from "./protection"

import { and, eq, inArray, or } from "drizzle-orm"
import { Effect, Schema, Semaphore } from "effect"
import { Database } from "../database/database"
import { SessionProtectionTable } from "./protection.sql"
import { SessionSchema } from "./schema"
import { SessionArchiveCatalogTable } from "../archive.sql"
import { SessionTable } from "./sql"
import { SessionOrchestratorTable, SessionOrchestratorTaskTable } from "./legacy-delegation/sql"

type DatabaseShape = Database.Interface["db"]
type QueryDatabase = Pick<DatabaseShape, "all" | "get" | "run" | "select" | "insert" | "delete">

const mutationLock = Semaphore.makeUnsafe(1)

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionProtection.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class ProtectedError extends Schema.TaggedErrorClass<ProtectedError>()("SessionProtection.ProtectedError", {
  sessionID: SessionSchema.ID,
}) {}

export function isProtected(db: QueryDatabase, sessionID: SessionSchema.ID) {
  return db
    .select({ sessionID: SessionProtectionTable.session_id })
    .from(SessionProtectionTable)
    .where(eq(SessionProtectionTable.session_id, sessionID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row !== undefined),
    )
}

export function protectedIDs(db: QueryDatabase, sessionIDs: ReadonlyArray<SessionSchema.ID>) {
  if (sessionIDs.length === 0) return Effect.succeed(new Set<SessionSchema.ID>())
  return db
    .select({ sessionID: SessionProtectionTable.session_id })
    .from(SessionProtectionTable)
    .where(inArray(SessionProtectionTable.session_id, [...sessionIDs]))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => new Set(rows.map((row) => row.sessionID))),
    )
}

function exists(db: QueryDatabase, sessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    const active = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (active) return true
    const archived = yield* db
      .select({ id: SessionArchiveCatalogTable.session_id })
      .from(SessionArchiveCatalogTable)
      .where(
        and(eq(SessionArchiveCatalogTable.session_id, sessionID), eq(SessionArchiveCatalogTable.location, "archived")),
      )
      .get()
      .pipe(Effect.orDie)
    return archived !== undefined
  })
}

export function setProtected(
  db: QueryDatabase,
  sessionID: SessionSchema.ID,
  protectedState: boolean,
  timestamp = Date.now(),
) {
  return mutationLock.withPermit(
    Effect.gen(function* () {
      if (!(yield* exists(db, sessionID))) return yield* new NotFoundError({ sessionID })
      if (!protectedState) {
        yield* db
          .delete(SessionProtectionTable)
          .where(eq(SessionProtectionTable.session_id, sessionID))
          .run()
          .pipe(Effect.orDie)
        return false
      }
      yield* db
        .insert(SessionProtectionTable)
        .values({ session_id: sessionID, protected_at: timestamp, updated_at: timestamp })
        .onConflictDoUpdate({
          target: SessionProtectionTable.session_id,
          set: { updated_at: timestamp },
        })
        .run()
        .pipe(Effect.orDie)
      return true
    }),
  )
}

export function clear(db: QueryDatabase, sessionID: SessionSchema.ID) {
  return db
    .delete(SessionProtectionTable)
    .where(eq(SessionProtectionTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

export function withMutationLock<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return mutationLock.withPermit(effect)
}

/** Ownership is not a user pin. Even released/terminal children retain their
 * admission tombstone until a dedicated retirement protocol can preserve it.
 * Call again in the deleting transaction: a UI preflight cannot fence new claims.
 */
export function requireUnmanaged(db: Pick<DatabaseShape, "select">, sessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    const main = yield* db
      .select({ id: SessionOrchestratorTable.main_session_id })
      .from(SessionOrchestratorTable)
      .where(eq(SessionOrchestratorTable.main_session_id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (main) return yield* new ProtectedError({ sessionID })
    const task = yield* db
      .select({ id: SessionOrchestratorTaskTable.id })
      .from(SessionOrchestratorTaskTable)
      .where(
        or(
          eq(SessionOrchestratorTaskTable.main_session_id, sessionID),
          eq(SessionOrchestratorTaskTable.child_session_id, sessionID),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (task) return yield* new ProtectedError({ sessionID })
  })
}

export function requireDeletable(db: QueryDatabase, sessionID: SessionSchema.ID, overrideProtection: boolean) {
  return Effect.gen(function* () {
    yield* requireUnmanaged(db, sessionID)
    if (overrideProtection) return
    if (yield* isProtected(db, sessionID)) return yield* new ProtectedError({ sessionID })
  })
}
