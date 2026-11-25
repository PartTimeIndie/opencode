export * as DelegationSettings from "./delegation-settings"

import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "../config"
import { ConfigDelegation } from "../config/delegation"
import { ConfigFileTarget } from "../config/file-target"
import { ConfigFileWriter } from "../config/file-writer"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Global } from "../global"
import { Location } from "../location"
import { SessionV2 } from "../session"
import { DelegationPreferences } from "./delegation-preferences"
import { SessionMetadata } from "./metadata"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"

export const Snapshot = Schema.Struct({
  scope: DelegationPreferences.Scope,
  value: ConfigDelegation.Info,
  revision: Schema.Int.pipe(Schema.optional),
  version: Schema.String.pipe(Schema.optional),
  taskID: SessionSchema.ID.pipe(Schema.optional),
  changed: Schema.Boolean.pipe(Schema.optional),
})
export type Snapshot = typeof Snapshot.Type
export type Authorize = DelegationPreferences.ScopedDependencies["authorize"]

const make = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const store = yield* SessionStore.Service
  const writer = yield* ConfigFileWriter.Service
  const global = yield* Global.Service
  const location = yield* Location.Service
  const config = yield* Config.Service
  const get: SessionV2.Interface["get"] = (sessionID) => store.get(sessionID).pipe(Effect.flatMap((session) =>
    session ? Effect.succeed(session) : Effect.fail(new SessionV2.NotFoundError({ sessionID }))))
  const assertLocation = Effect.fn("DelegationSettings.assertLocation")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (!Location.same(session.location, location)) return yield* new SessionV2.NotFoundError({ sessionID })
  })
  const sessions = { get, compareAndPatchMetadata: (input: SessionMetadata.CompareAndPatch) =>
    SessionMetadata.compareAndPatch({ db, events, get }, input) }
  const dependencies = (sessionID: SessionSchema.ID, authorize: Authorize): DelegationPreferences.ScopedDependencies => ({ sessions, writer,
    authorize: (request) => authorize(request).pipe(Effect.andThen(assertLocation(sessionID))),
    documentTarget: (scope) => Effect.try({
      try: () => ({ scope, file: scope === "global" ? ConfigFileTarget.global(global.config) : ConfigFileTarget.project(location.directory) }),
      catch: () => new DelegationPreferences.Invalid({ reason: "owner" }),
    }),
  })
  return {
    get: Effect.fn("DelegationSettings.get")(function* (sessionID: SessionSchema.ID, target: DelegationPreferences.Target, authorize: Authorize) {
      yield* assertLocation(sessionID)
      return yield* DelegationPreferences.getScoped(dependencies(sessionID, authorize), sessionID, target)
    }),
    patch: Effect.fn("DelegationSettings.patch")(function* (sessionID: SessionSchema.ID, request: DelegationPreferences.ScopedPatch, authorize: Authorize) {
      yield* assertLocation(sessionID)
      const saved = yield* DelegationPreferences.patchScoped(dependencies(sessionID, authorize), sessionID, request)
      if (saved.scope === "global" || saved.scope === "project") yield* config.entries({ refresh: true })
      return saved
    }),
  }
})

export class Service extends Context.Service<Service, Effect.Success<typeof make>>()("@opencode/DelegationSettings") {}
export const layer = Layer.effect(Service, make)
