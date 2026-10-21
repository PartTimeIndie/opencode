export * as SessionToolCancellation from "./tool-cancellation"

import { Context, Deferred, Effect, Layer } from "effect"
import { SessionSchema } from "./schema"

export const ManualCancelMessage =
  "Tool call manually cancelled by the user. Treat this as a failed tool result and continue with a safer alternative if possible."

export type Key = {
  readonly sessionID: SessionSchema.ID
  readonly callID: string
}

export type Cancellation = {
  readonly message: string
}

export type Registration = {
  readonly cancelled: Effect.Effect<Cancellation>
  readonly unregister: Effect.Effect<void>
}

export interface Interface {
  readonly register: (key: Key) => Effect.Effect<Registration>
  readonly cancel: (key: Key) => Effect.Effect<boolean>
  readonly cancelSession: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionToolCancellation") {}

const mapKey = (key: Key) => `${key.sessionID}\u0000${key.callID}`

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const active = new Map<string, Deferred.Deferred<Cancellation>>()

    const register = Effect.fn("SessionToolCancellation.register")(function* (key: Key) {
      const token = yield* Deferred.make<Cancellation>()
      const id = mapKey(key)
      active.set(id, token)
      return {
        cancelled: Deferred.await(token),
        unregister: Effect.sync(() => {
          if (active.get(id) === token) active.delete(id)
        }),
      }
    })

    const cancel = Effect.fn("SessionToolCancellation.cancel")(function* (key: Key) {
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const id = mapKey(key)
          const token = active.get(id)
          if (!token) return false
          active.delete(id)
          yield* Deferred.succeed(token, { message: ManualCancelMessage })
          return true
        }),
      )
    })

    const cancelSession = Effect.fn("SessionToolCancellation.cancelSession")(function* (sessionID: SessionSchema.ID) {
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const entries = [...active].filter(([id]) => id.startsWith(`${sessionID}\u0000`))
          for (const [id, token] of entries) {
            active.delete(id)
            yield* Deferred.succeed(token, { message: ManualCancelMessage })
          }
          return entries.length > 0
        }),
      )
    })

    return Service.of({ register, cancel, cancelSession })
  }),
)

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    register: () => Effect.succeed({ cancelled: Effect.never, unregister: Effect.void }),
    cancel: () => Effect.succeed(false),
    cancelSession: () => Effect.succeed(false),
  }),
)
