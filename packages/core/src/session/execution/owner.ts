export * as SessionExecutionOwner from "./owner"

import { eq } from "drizzle-orm"
import { Context, Effect, Schema } from "effect"
import type { Database } from "../../database/database"
import type { SessionSchema } from "../schema"
import { SessionActivityTable } from "../sql"

type Lease = { readonly sessionID: SessionSchema.ID; readonly activityID: string; readonly ownerID: string }
class Owner extends Context.Service<Owner, Lease & { active: boolean }>()("SessionExecutionOwner.Owner") {}

export class Lost extends Schema.TaggedErrorClass<Lost>()("SessionExecutionOwner.Lost", {
  sessionID: Schema.String,
}) {
  override get message() { return "The Session execution owner is no longer active" }
}

/** Supplied only by the local execution coordinator after claiming an Activity.
 * Neither a durable lease nor an inherited fiber outliving this scope is an
 * execution owner. This exclusion grants no permission or user consent. */
export const withOwner = <A, E, R>(lease: Lease, operation: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => ({ ...lease, active: true })),
    (owner) => operation.pipe(Effect.provideService(Owner, owner)),
    (owner) => Effect.sync(() => { owner.active = false }),
  )

export const assertOwner = Effect.fn("SessionExecutionOwner.assertOwner")(function* (
  db: Pick<Database.Interface["db"], "select">,
  sessionID: SessionSchema.ID,
) {
  const owner = yield* Effect.serviceOption(Owner)
  if (owner._tag !== "Some" || !owner.value.active || owner.value.sessionID !== sessionID)
    return yield* new Lost({ sessionID })
  const activity = yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.id, owner.value.activityID))
    .get().pipe(Effect.orDie)
  if (!owner.value.active || !activity || activity.session_id !== sessionID ||
    activity.owner_id !== owner.value.ownerID || activity.status !== "running" || activity.closed_seq !== null ||
    activity.lease_until === null || activity.lease_until <= Date.now())
    return yield* new Lost({ sessionID })
  return { activityID: activity.id, ownerID: owner.value.ownerID }
})
