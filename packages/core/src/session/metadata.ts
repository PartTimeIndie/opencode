export * as SessionMetadata from "./metadata"

import { DateTime, Effect } from "effect"
import { isDeepStrictEqual } from "node:util"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import type { SessionV2 } from "../session"
import { SessionEvent } from "./event"
import { SessionOperations } from "./operations"
import type { SessionSchema } from "./schema"

export type CompareAndPatch = {
  readonly sessionID: SessionSchema.ID
  readonly patch: SessionSchema.MetadataPatch
  readonly expectedMetadata: Record<string, unknown>
}

/** Both Session API and Location-owned preference tools use this exact lane and
 * atomic event owner. Caller-owned patches are copied before waiting for it. */
export function compareAndPatch(
  dependencies: {
    readonly db: Database.Interface["db"]
    readonly events: EventV2.Interface
    readonly get: SessionV2.Interface["get"]
    readonly activate?: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionV2.NotFoundError>
  },
  request: CompareAndPatch,
) {
  const input = structuredClone(request)
  return SessionOperations.withLock(input.sessionID)(Effect.gen(function* () {
    if (dependencies.activate) yield* dependencies.activate(input.sessionID)
    return yield* EventV2.atomic(dependencies.db, Effect.gen(function* () {
      const session = yield* dependencies.get(input.sessionID)
      if (Object.entries(input.expectedMetadata).some(([key, value]) => !isDeepStrictEqual(session.metadata?.[key], value)))
        return false
      yield* dependencies.events.publish(SessionEvent.MetadataPatched, {
        sessionID: input.sessionID, timestamp: yield* DateTime.now, ...input.patch,
      })
      return true
    }))
  }))
}
