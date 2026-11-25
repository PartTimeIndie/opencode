export * as SessionOperations from "./operations"

import { KeyedMutex } from "../effect/keyed-mutex"
import type { SessionSchema } from "./schema"

// One existing per-Session operation lane shared by the public Session API and
// Location-owned settings tools. This is exclusion, not execution authority.
const operations = KeyedMutex.makeUnsafe<SessionSchema.ID>()
export const withLock = operations.withLock
