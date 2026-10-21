export * as SessionWakeup from "./wakeup"

import { Effect } from "effect"
import { SessionSchema } from "./schema"

export type Handler = (sessionID: SessionSchema.ID, admittedSeq: number) => Effect.Effect<void>

const handlers = new Set<Handler>()

export const listen = (handler: Handler) =>
  Effect.acquireRelease(
    Effect.sync(() => handlers.add(handler)),
    () => Effect.sync(() => handlers.delete(handler)),
  ).pipe(Effect.asVoid)

export const request = (sessionID: SessionSchema.ID, admittedSeq: number) =>
  Effect.forEach(handlers, (handler) => handler(sessionID, admittedSeq).pipe(Effect.ignore), { discard: true })
