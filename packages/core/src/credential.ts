export * as Credential from "./credential"

import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import type { Scope } from "effect"
import { Database } from "./database/database"
import { IntegrationSchema } from "./integration/schema"
import { NonNegativeInt, withStatics } from "./schema"
import { Identifier } from "./util/identifier"
import { CredentialTable } from "./credential/sql"
import { LayerNode } from "./effect/layer-node"

export const ID = Schema.String.pipe(
  Schema.brand("Credential.ID"),
  withStatics((schema) => ({ create: () => schema.make("cred_" + Identifier.ascending()) })),
)
export type ID = typeof ID.Type

export class OAuth extends Schema.Class<OAuth>("Credential.OAuth")({
  type: Schema.Literal("oauth"),
  methodID: IntegrationSchema.MethodID,
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class Key extends Schema.Class<Key>("Credential.Key")({
  type: Schema.Literal("key"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export const Info = Schema.Union([OAuth, Key])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Credential.Info" })
export type Info = Schema.Schema.Type<typeof Info>

export class Stored extends Schema.Class<Stored>("Credential.Stored")({
  id: ID,
  integrationID: IntegrationSchema.ID,
  label: Schema.String,
  connectorID: Schema.optional(Schema.String),
  value: Info,
}) {}

export const LegacyLabel = "Imported from auth.json"
export const LegacySource = "legacy-auth-json"

export type LegacySyncInput =
  | { readonly mode: "bootstrap"; readonly integrationID: IntegrationSchema.ID; readonly value: Info }
  | { readonly mode: "set"; readonly integrationID: IntegrationSchema.ID; readonly value: Info }
  | { readonly mode: "remove"; readonly integrationID: IntegrationSchema.ID }

export interface Interface {
  /** Returns every stored credential. */
  readonly all: () => Effect.Effect<Stored[]>
  /** Returns stored credentials belonging to one integration. */
  readonly list: (integrationID: IntegrationSchema.ID) => Effect.Effect<Stored[]>
  /** Returns credentials durably marked as auth.json mirrors. */
  readonly legacy: () => Effect.Effect<Stored[]>
  /** Returns one stored credential by ID. */
  readonly get: (id: ID) => Effect.Effect<Stored | undefined>
  /** Replaces any credential for an integration and returns the new record. */
  readonly create: (input: {
    readonly integrationID: IntegrationSchema.ID
    readonly value: Info
    readonly label?: string
  }) => Effect.Effect<Stored>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (id: ID, updates: Partial<Pick<Stored, "label" | "value">>) => Effect.Effect<void>
  /** Removes a stored credential. */
  readonly remove: (id: ID) => Effect.Effect<void>
  /** Imports, replaces, or removes a marked auth.json mirror without mutating native V2 credentials. */
  readonly syncLegacy: (input: LegacySyncInput) => Effect.Effect<boolean>
  readonly onChange: (
    listener: (change: CredentialChange) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>
}

export type CredentialChange = {
  readonly before: Stored | undefined
  readonly after: Stored | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Credential") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decode = Schema.decodeUnknownSync(Info)
    const equivalent = Schema.toEquivalence(Info)
    const listeners = new Set<(change: CredentialChange) => Effect.Effect<void>>()
    const notify = Effect.fnUntraced(function* (change: CredentialChange) {
      yield* Effect.forEach(
        listeners,
        (listener) =>
          listener(change).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("credential change listener failed", { cause: String(cause) }),
            ),
          ),
        { discard: true },
      )
    })
    const stored = (row: typeof CredentialTable.$inferSelect) => {
      if (!row.integration_id) return
      return new Stored({
        id: row.id,
        integrationID: row.integration_id,
        label: row.label,
        connectorID: row.connector_id ?? undefined,
        value: decode(row.value),
      })
    }

    return Service.of({
      all: Effect.fn("Credential.all")(function* () {
        return (yield* db
          .select()
          .from(CredentialTable)
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)).flatMap((row) => {
          const credential = stored(row)
          return credential ? [credential] : []
        })
      }),
      list: Effect.fn("Credential.list")(function* (integrationID) {
        return (yield* db
          .select()
          .from(CredentialTable)
          .where(eq(CredentialTable.integration_id, integrationID))
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)).flatMap((row) => {
          const credential = stored(row)
          return credential ? [credential] : []
        })
      }),
      legacy: Effect.fn("Credential.legacy")(function* () {
        return (yield* db
          .select()
          .from(CredentialTable)
          .where(eq(CredentialTable.connector_id, LegacySource))
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)).flatMap((row) => {
          const credential = stored(row)
          return credential ? [credential] : []
        })
      }),
      get: Effect.fn("Credential.get")(function* (id) {
        const row = yield* db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)
        return row ? stored(row) : undefined
      }),
      create: Effect.fn("Credential.create")(function* (input) {
        const credential = new Stored({
          id: ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
        })
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(CredentialTable)
                .where(eq(CredentialTable.integration_id, credential.integrationID))
                .run()
              yield* tx
                .insert(CredentialTable)
                .values({
                  id: credential.id,
                  integration_id: credential.integrationID,
                  label: credential.label,
                  value: credential.value,
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        yield* notify({ before: undefined, after: credential })
        return credential
      }),
      update: Effect.fn("Credential.update")(function* (id, updates) {
        if (!updates.label && !updates.value) return
        const before = yield* db
          .select()
          .from(CredentialTable)
          .where(eq(CredentialTable.id, id))
          .get()
          .pipe(Effect.orDie)
        yield* db
          .update(CredentialTable)
          .set({ label: updates.label, value: updates.value })
          .where(eq(CredentialTable.id, id))
          .run()
          .pipe(Effect.orDie)
        const current = before ? stored(before) : undefined
        const after = current
          ? new Stored({
              ...current,
              label: updates.label ?? current.label,
              value: updates.value ?? current.value,
            })
          : undefined
        yield* notify({ before: current, after })
      }),
      remove: Effect.fn("Credential.remove")(function* (id) {
        const before = yield* db
          .select()
          .from(CredentialTable)
          .where(eq(CredentialTable.id, id))
          .get()
          .pipe(Effect.orDie)
        yield* db.delete(CredentialTable).where(eq(CredentialTable.id, id)).run().pipe(Effect.orDie)
        yield* notify({ before: before ? stored(before) : undefined, after: undefined })
      }),
      syncLegacy: Effect.fn("Credential.syncLegacy")(function* (input) {
        const changed = yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const existing = yield* tx
                  .select()
                  .from(CredentialTable)
                  .where(eq(CredentialTable.integration_id, input.integrationID))
                  .orderBy(asc(CredentialTable.time_created))
                  .all()
                const legacy = existing.filter((item) => item.connector_id === LegacySource)

                if (input.mode === "remove") {
                  if (legacy.length === 0) return false
                  yield* Effect.forEach(
                    legacy,
                    (item) => tx.delete(CredentialTable).where(eq(CredentialTable.id, item.id)).run(),
                    { discard: true },
                  )
                  return true
                }

                // auth.json remains authoritative for legacy mirrors unless a process
                // has already persisted a clearly newer OAuth token. Never overwrite
                // native V2 credentials below.
                if (existing.some((item) => !legacy.includes(item))) return false
                const current = legacy.length === 1 ? legacy[0] : undefined
                const currentValue = current ? decode(current.value) : undefined
                if (
                  input.mode === "bootstrap" &&
                  currentValue?.type === "oauth" &&
                  input.value.type === "oauth" &&
                  currentValue.methodID === input.value.methodID &&
                  currentValue.expires > input.value.expires
                )
                  return true
                if (
                  current?.label === LegacyLabel &&
                  currentValue !== undefined &&
                  equivalent(currentValue, input.value)
                )
                  return true
                const id = legacy.at(-1)?.id ?? ID.create()
                if (legacy.length > 0) {
                  yield* tx.delete(CredentialTable).where(eq(CredentialTable.integration_id, input.integrationID)).run()
                }
                yield* tx
                  .insert(CredentialTable)
                  .values({
                    id,
                    integration_id: input.integrationID,
                    connector_id: LegacySource,
                    label: LegacyLabel,
                    value: input.value,
                  })
                  .run()
                return true
              }),
            // Acquire the writer before reading mirrors: concurrent startup imports
            // cannot upgrade a stale WAL read snapshot to a write transaction.
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        if (!changed) return false
        return true
      }),
      onChange: Effect.fn("Credential.onChange")(function* (listener) {
        listeners.add(listener)
        yield* Effect.addFinalizer(() => Effect.sync(() => listeners.delete(listener)).pipe(Effect.asVoid))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = LayerNode.make(layer, [Database.node])
