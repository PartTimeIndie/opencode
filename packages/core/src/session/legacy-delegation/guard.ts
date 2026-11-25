export * as LegacyDelegationGuard from "./guard"

import { and, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../../database/database"
import type { SessionSchema } from "../schema"
import { SessionTable } from "../sql"
import { WorkspaceCheckout } from "../workspace/checkout"
import { SessionOrchestratorReservationTable, SessionOrchestratorTable, SessionOrchestratorTaskTable } from "./sql"

type Reader = Pick<Database.Interface["db"], "select">
export type Environment = { readonly db?: Reader; readonly checkouts?: WorkspaceCheckout.Interface }

export class Blocked extends Schema.TaggedErrorClass<Blocked>()("LegacyDelegationGuard.Blocked", {
  sessionID: Schema.String,
  reason: Schema.Literals(["retired", "unattestable", "drifted", "unreserved"]),
}) {
  override get message() {
    if (this.reason === "retired")
      return "Legacy Main-Orchestrator execution has been removed. Use a new native task; historical ownership is retained."
    if (this.reason === "unreserved") return "Historical delegation still holds a resource claim for this target"
    if (this.reason === "drifted") return "Physical checkout identity no longer matches historical ownership"
    return "Historical delegation protection could not verify the required evidence"
  }
}

/** Refuse every historical child, even after replay without its task row. */
export const assertAdmissible = Effect.fn("LegacyDelegationGuard.assertAdmissible")(function* (
  db: Reader,
  sessionID: SessionSchema.ID,
) {
  const task = yield* db
    .select({ id: SessionOrchestratorTaskTable.id })
    .from(SessionOrchestratorTaskTable)
    .where(eq(SessionOrchestratorTaskTable.child_session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  const session = yield* db
    .select({ policy: SessionTable.agent_policy })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (task || session?.policy?.source.type === "orchestrator")
    return yield* new Blocked({ sessionID, reason: "retired" })
  return false
})

export const assertRunner = assertAdmissible

const overlaps = (resource: string, target: string) => {
  if (resource === "project:*" || resource === `path:${target}`) return true
  if (!resource.startsWith("path:")) return false
  const root = resource.slice(5)
  return (
    target.startsWith(root.endsWith("/") ? root : `${root}/`) ||
    root.startsWith(target.endsWith("/") ? target : `${target}/`)
  )
}

/** Protect unresolved claims, including reservation rows retained after repair.
 * No historical state, receipt or feature flag can authorize a child write. */
const assertClaims = Effect.fn("LegacyDelegationGuard.assertClaims")(function* (
  env: Environment,
  sessionID: SessionSchema.ID,
  target?: string,
) {
  if (!env.db) return yield* new Blocked({ sessionID, reason: "unattestable" })
  yield* assertAdmissible(env.db, sessionID)
  const settings = yield* env.db
    .select()
    .from(SessionOrchestratorTable)
    .where(eq(SessionOrchestratorTable.main_session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!settings) return false
  const main = yield* env.db
    .select({ directory: SessionTable.directory })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!main || !env.checkouts) return yield* new Blocked({ sessionID, reason: "unattestable" })
  const checkout = yield* env.checkouts
    .resolve(main.directory)
    .pipe(Effect.mapError(() => new Blocked({ sessionID, reason: "drifted" })))
  if (checkout !== settings.checkout_id) return yield* new Blocked({ sessionID, reason: "drifted" })
  const tasks = yield* env.db
    .select()
    .from(SessionOrchestratorTaskTable)
    .where(
      and(eq(SessionOrchestratorTaskTable.checkout_id, checkout), eq(SessionOrchestratorTaskTable.slot_claimed, true)),
    )
    .all()
    .pipe(Effect.orDie)
  const claims = yield* env.db
    .select()
    .from(SessionOrchestratorReservationTable)
    .where(eq(SessionOrchestratorReservationTable.directory, checkout))
    .all()
    .pipe(Effect.orDie)
  const resources = [...tasks.flatMap((task) => task.resources), ...claims.map((claim) => claim.resource)]
  if (resources.some((resource) => target === undefined || overlaps(resource, WorkspaceCheckout.pathKey(target))))
    return yield* new Blocked({ sessionID, reason: "unreserved" })
  return true
})

export const assertFileWrite = Effect.fn("LegacyDelegationGuard.assertFileWrite")(function* (
  env: Environment,
  sessionID: SessionSchema.ID,
  target: string,
) {
  if (env.db) yield* WorkspaceCheckout.assertWrite(env.db, sessionID, target)
  const legacyManaged = yield* assertClaims(env, sessionID, target)
  if (legacyManaged || !env.db) return legacyManaged
  // Native dispatch children are managed writers too: their guarded mutation
  // must receive the final ownership/placement recheck before commit, not
  // only the earlier preparation check.
  const row = yield* env.db.select({ dispatch: SessionTable.fork_dispatch_digest }).from(SessionTable)
    .where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
  return Boolean(row?.dispatch)
})

export const assertShell = Effect.fn("LegacyDelegationGuard.assertShell")(function* (
  env: Environment,
  sessionID: SessionSchema.ID,
  workdir?: string,
) {
  if (env.db) yield* WorkspaceCheckout.assertWrite(env.db, sessionID, workdir)
  return yield* assertClaims(env, sessionID)
})
