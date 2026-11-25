export * as EventV2 from "./event"

import { Cause, Context, Effect, Layer, Option, PubSub, Schema, Stream } from "effect"
import { and, asc, eq, gt, lte } from "drizzle-orm"
import { Database } from "./database/database"
import { EventCheckpointTable, EventSequenceTable, EventTable } from "./event/sql"
import { Location } from "./location"
import { externalID, type ExternalID, NonNegativeInt, withStatics } from "./schema"
import { Identifier } from "./util/identifier"
import { LayerNode } from "./effect/layer-node"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { deflateRawSync, inflateRawSync } from "node:zlib"

const EVENT_DATA_COMPRESSION_THRESHOLD = 4_096
const EVENT_DATA_COMPRESSION_KEY = "__opencode_event_data_encoding"
const EVENT_DATA_COMPRESSION_VERSION = "deflate-raw-base64-v1"
const EVENT_DATA_DECODED_BYTES_KEY = "decodedBytes"
export const MAX_EVENT_DATA_DECODED_BYTES = 512 * 1024 * 1024
export const MAX_CHECKPOINT_EVENT_DECODED_BYTES = 64 * 1024 * 1024

type StoredEventData = Record<string, unknown>
type CompressedEventData = {
  readonly [EVENT_DATA_COMPRESSION_KEY]: typeof EVENT_DATA_COMPRESSION_VERSION
  readonly data: string
  readonly [EVENT_DATA_DECODED_BYTES_KEY]?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const isCompressedEventData = (value: StoredEventData): value is StoredEventData & CompressedEventData =>
  value[EVENT_DATA_COMPRESSION_KEY] === EVENT_DATA_COMPRESSION_VERSION &&
  typeof value.data === "string" &&
  (value[EVENT_DATA_DECODED_BYTES_KEY] === undefined ||
    (Number.isSafeInteger(value[EVENT_DATA_DECODED_BYTES_KEY]) && Number(value[EVENT_DATA_DECODED_BYTES_KEY]) >= 0)) &&
  Object.keys(value).every((key) => [EVENT_DATA_COMPRESSION_KEY, "data", EVENT_DATA_DECODED_BYTES_KEY].includes(key))

export const encodeStoredEventData = (data: Record<string, unknown>): StoredEventData => {
  const source = JSON.stringify(data)
  if (Buffer.byteLength(source) < EVENT_DATA_COMPRESSION_THRESHOLD) return data
  const compressed = {
    [EVENT_DATA_COMPRESSION_KEY]: EVENT_DATA_COMPRESSION_VERSION,
    data: deflateRawSync(source, { level: 1 }).toString("base64"),
    [EVENT_DATA_DECODED_BYTES_KEY]: Buffer.byteLength(source),
  }
  return Buffer.byteLength(JSON.stringify(compressed)) < Buffer.byteLength(source) ? compressed : data
}

/**
 * Reads both historical JSON event rows and the compact representation used for
 * large synchronized payloads. Callers that send EventTable rows over the wire
 * must use this so replication stays format-independent.
 */
export const decodeStoredEventData = (
  data: StoredEventData,
  maximumBytes = MAX_EVENT_DATA_DECODED_BYTES,
): Record<string, unknown> => {
  if (!isCompressedEventData(data)) return data
  if (data.decodedBytes !== undefined && data.decodedBytes > maximumBytes)
    throw new InvalidSyncEventError({
      type: CheckpointCapability,
      message: `Compressed event data exceeds the decoded-size limit (${data.decodedBytes} bytes, limit ${maximumBytes})`,
    })
  const source = inflateRawSync(Buffer.from(data.data, "base64"), { maxOutputLength: maximumBytes })
  if (data.decodedBytes !== undefined && source.byteLength !== data.decodedBytes)
    throw new InvalidSyncEventError({
      type: CheckpointCapability,
      message: `Compressed event decoded-size metadata differs (expected ${data.decodedBytes}, actual ${source.byteLength})`,
    })
  const decoded = JSON.parse(source.toString())
  if (!isRecord(decoded)) throw new Error("Compressed event data must decode to an object")
  return decoded
}

export const ID = Schema.String.check(Schema.isStartsWith("evt_")).pipe(
  Schema.brand("Event.ID"),
  withStatics((schema) => ({
    create: () => schema.make("evt_" + Identifier.ascending()),
    fromExternal: (input: ExternalID) => schema.make(externalID("evt", input)),
  })),
)
export type ID = typeof ID.Type

/**
 * Durable aggregate continuation position for embedded replay streams.
 * TODO: Decide whether a future HTTP / SDK surface should expose an opaque cursor instead.
 */
export const Cursor = NonNegativeInt.pipe(Schema.brand("EventV2.Cursor"))
export type Cursor = typeof Cursor.Type

export type Definition<Type extends string = string, DataSchema extends Schema.Top = Schema.Top> = {
  readonly type: Type
  readonly sync?: {
    readonly version: number
    readonly aggregate: string
  }
  readonly data: DataSchema
}

export type Data<D extends Definition> = Schema.Schema.Type<D["data"]>

export type Payload<D extends Definition = Definition> = {
  readonly id: ID
  readonly type: D["type"]
  readonly data: Data<D>
  /** Durable aggregate order, populated while synchronized events are projected. */
  readonly seq?: number
  readonly version?: number
  readonly location?: Location.Ref
  readonly metadata?: Record<string, unknown>
  /** Internal replay marker for projectors that own non-replicated operational state. */
  readonly replay?: boolean
}

export type Projector<D extends Definition = Definition> = (event: Payload<D>) => Effect.Effect<void>
type AnyProjector = (event: Payload) => Effect.Effect<void>
export type CommitGuard = (event: Payload) => Effect.Effect<void>
export type Listener = (event: Payload) => Effect.Effect<void>
export type Sync = (event: Payload) => Effect.Effect<void>
export type Unsubscribe = Effect.Effect<void>

export type SerializedEvent = {
  readonly id: ID
  readonly type: string
  readonly seq: number
  readonly aggregateID: string
  readonly data: Record<string, unknown>
}

export const LegacyCheckpointCapability = "event-checkpoint-v1" as const
export const PreviousCheckpointCapability = "event-checkpoint-v2" as const
export const CheckpointCapability = "event-checkpoint-v3" as const
export const LegacyCheckpointVersion = 1 as const
export const CheckpointVersion = 2 as const

export type CheckpointBaseline = {
  readonly adapter: string
  readonly version: number
  readonly data: Record<string, unknown>
}

export type SerializedCheckpoint = {
  readonly aggregateID: string
  readonly seq: number
  readonly version: typeof CheckpointVersion
  readonly baseline: CheckpointBaseline
  readonly baselineHash: string
  readonly eventHash: string
  readonly compactedSeq?: number
  readonly compactedAt?: number
}

export type LegacySerializedCheckpoint = {
  readonly aggregateID: string
  readonly seq: number
  readonly version: typeof LegacyCheckpointVersion
  readonly events: ReadonlyArray<SerializedEvent>
  readonly eventHash?: string
  readonly projectionHash?: string
  readonly compactedSeq?: number
  readonly compactedAt?: number
}

export type CheckpointCompaction = {
  readonly checkpoint: SerializedCheckpoint
  readonly deleted: number
}

export type CheckpointAdapter = {
  readonly id: string
  readonly version: number
  readonly capture: (aggregateID: string) => Effect.Effect<CheckpointBaseline | undefined>
  readonly upgrade?: (baseline: CheckpointBaseline) => Effect.Effect<CheckpointBaseline>
  readonly normalize?: (input: {
    readonly aggregateID: string
    readonly seq: number
    readonly baseline: CheckpointBaseline
  }) => Effect.Effect<CheckpointBaseline>
  readonly hydrate?: (input: {
    readonly aggregateID: string
    readonly seq: number
    readonly baseline: CheckpointBaseline
  }) => Effect.Effect<CheckpointBaseline>
  readonly restore: (aggregateID: string, baseline: CheckpointBaseline) => Effect.Effect<void>
  readonly verify: (input: {
    readonly aggregateID: string
    readonly expected: CheckpointBaseline
    readonly previous?: CheckpointBaseline
    readonly previousSeq?: number
    readonly events: ReadonlyArray<SerializedEvent>
  }) => Effect.Effect<void>
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

const checkpointHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(canonicalize(value)) ?? "undefined").digest("hex")

export function readStoredCheckpointBaseline(data: Record<string, unknown>) {
  const decoded = decodeStoredEventData(data)
  if (!isRecord(decoded.baseline) || typeof decoded.baselineHash !== "string")
    throw new InvalidSyncEventError({
      type: CheckpointCapability,
      message: "Checkpoint has no projection baseline",
    })
  if (checkpointHash(decoded.baseline) !== decoded.baselineHash)
    throw new InvalidSyncEventError({
      type: CheckpointCapability,
      message: "Checkpoint projection baseline hash does not match",
    })
  return decoded.baseline as CheckpointBaseline
}

export function replaceStoredCheckpointBaseline(data: Record<string, unknown>, baseline: CheckpointBaseline) {
  return encodeStoredEventData({
    ...decodeStoredEventData(data),
    baseline,
    baselineHash: checkpointHash(baseline),
  })
}

const checkpointEventHash = (events: ReadonlyArray<SerializedEvent>, previous?: string) =>
  checkpointHash(previous ? { previous, events } : events)

export type CursorEvent<E extends Payload = Payload> = {
  readonly cursor: Cursor
  readonly event: E
}

export class InvalidSyncEventError extends Schema.TaggedErrorClass<InvalidSyncEventError>()(
  "EventV2.InvalidSyncEvent",
  {
    type: Schema.String,
    message: Schema.String,
  },
) {}

export function versionedType(type: string, version: number) {
  return `${type}.${version}`
}

export const registry = new Map<string, Definition>()
type SyncDefinition = Definition & {
  readonly sync: NonNullable<Definition["sync"]>
  readonly encode: (data: unknown) => unknown
  readonly decode: (data: unknown) => unknown
}
const syncRegistry = new Map<string, SyncDefinition>()

// Synchronized events cross a JSON boundary, so their data schemas must encode and decode without services.
const syncCodec = (definition: Definition) => definition.data as Schema.Codec<unknown, unknown, never, never>

export function define<const Type extends string, Fields extends Schema.Struct.Fields>(input: {
  readonly type: Type
  readonly sync?: {
    readonly version: number
    readonly aggregate: string
  }
  readonly schema: Fields
}): Schema.Schema<Payload<Definition<Type, Schema.Struct<Fields>>>> & Definition<Type, Schema.Struct<Fields>> {
  const Data = Schema.Struct(input.schema)
  const Payload = Schema.Struct({
    id: ID,
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    type: Schema.Literal(input.type),
    version: Schema.optional(Schema.Number),
    location: Schema.optional(Location.Ref),
    data: Data,
  }).annotate({ identifier: input.type })

  const definition = Object.assign(Payload, {
    type: input.type,
    ...(input.sync === undefined ? {} : { sync: input.sync }),
    data: Data,
  })
  const existing = registry.get(input.type)
  if (input.sync === undefined || existing?.sync === undefined || input.sync.version >= existing.sync.version) {
    registry.set(input.type, definition)
  }
  if (input.sync)
    syncRegistry.set(
      versionedType(input.type, input.sync.version),
      Object.assign(definition, {
        encode: Schema.encodeUnknownSync(syncCodec(definition)),
        decode: Schema.decodeUnknownSync(syncCodec(definition)),
      }) as SyncDefinition,
    )
  return definition as Schema.Schema<Payload<Definition<Type, Schema.Struct<Fields>>>> &
    Definition<Type, Schema.Struct<Fields>>
}

export function definitions() {
  return registry.values().toArray()
}

export interface PublishOptions {
  readonly id?: ID
  readonly metadata?: Record<string, unknown>
  readonly location?: Location.Ref
  /** Keep listener failures from blocking later listeners and subscriptions. Interruptions still propagate. */
  readonly isolateListeners?: boolean
  /** Local operational projection committed atomically with a new synchronized event. Not replayed or serialized. */
  readonly commit?: (seq: number) => Effect.Effect<void>
}

export interface Interface {
  readonly publish: <D extends Definition>(
    definition: D,
    data: Data<D>,
    options?: PublishOptions,
  ) => Effect.Effect<Payload<D>>
  readonly subscribe: <D extends Definition>(definition: D) => Stream.Stream<Payload<D>>
  readonly all: () => Stream.Stream<Payload>
  readonly aggregateEvents: (input: {
    readonly aggregateID: string
    readonly after?: Cursor
  }) => Stream.Stream<CursorEvent>
  readonly sync: (handler: Sync) => Effect.Effect<Unsubscribe>
  readonly listen: (listener: Listener) => Effect.Effect<Unsubscribe>
  readonly beforeCommit: (guard: CommitGuard) => Effect.Effect<void>
  readonly project: <D extends Definition>(definition: D, projector: Projector<D>) => Effect.Effect<void>
  readonly registerCheckpointAdapter: (adapter: CheckpointAdapter) => Effect.Effect<void>
  readonly replay: (
    event: SerializedEvent,
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<void>
  readonly replayAll: (
    events: SerializedEvent[],
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<string | undefined>
  readonly createCheckpoint: (aggregateID: string) => Effect.Effect<SerializedCheckpoint | undefined>
  readonly checkpoint: (
    aggregateID: string,
  ) => Effect.Effect<SerializedCheckpoint | LegacySerializedCheckpoint | undefined>
  readonly compactCheckpoint: (aggregateID: string) => Effect.Effect<CheckpointCompaction | undefined>
  readonly replayCheckpoint: (
    checkpoint: SerializedCheckpoint,
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<string | undefined>
  readonly remove: (aggregateID: string) => Effect.Effect<void>
  readonly claim: (aggregateID: string, ownerID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Event") {}

export interface LayerOptions {
  readonly beforeAggregateRead?: (aggregateID: string) => Effect.Effect<void>
}

type AtomicPublication = {
  readonly db: Database.Interface["db"]
  readonly pending: Array<Effect.Effect<void>>
  transaction?: unknown
  owner?: number
  active: boolean
}
class PublicationScope extends Context.Service<PublicationScope, AtomicPublication>()("EventV2.PublicationScope") {}

/** Commit related projections and their events together. Observers (including
 * sync transports) see nothing until the outer transaction commits. A failed or
 * interrupted operation discards its queued notifications, not just its rows.
 * This does not grant execution authority to any of the created Sessions.
 */
export const atomic = <A, E, R>(db: Database.Interface["db"], operation: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const inherited = yield* Effect.serviceOption(PublicationScope)
    if (inherited._tag === "Some") {
      yield* publicationScope(db)
    }
    // A plain outer SQL transaction has no publication owner. Flushing from its
    // savepoint would announce rows which the outer transaction can still undo.
    if (inherited._tag === "None" && (yield* Effect.serviceOption(db.$client.transactionService))._tag === "Some")
      return yield* Effect.die("Atomic publication must own the outer database transaction")
    const scope: AtomicPublication = { db, pending: [], active: true }
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const result = yield* db.transaction(
          () => Effect.gen(function* () {
            const transaction = yield* Effect.serviceOption(db.$client.transactionService)
            if (transaction._tag === "None") return yield* Effect.die("Atomic publication has no database transaction")
            scope.transaction = transaction.value
            scope.owner = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.id))
            return yield* restore(operation.pipe(Effect.provideService(PublicationScope, scope)))
          }),
          { behavior: "immediate" },
        ).pipe(
          restore,
          Effect.catchTag("SqlError", Effect.die),
          Effect.ensuring(Effect.sync(() => { scope.active = false })),
        )
        if (inherited._tag === "Some") {
          // A released savepoint is not a committed batch. Its parent owns
          // delivery; a failed savepoint never contributes notifications.
          inherited.value.pending.push(...scope.pending)
          return result
        }
        // Rows are committed. Observer defects do not imply rollback. Explicit
        // cancellation stops remaining advisory delivery; durable event replay
        // is authoritative, and consumers must reconcile after reconnecting.
        yield* restore(Effect.forEach(scope.pending, (notification) => notification.pipe(
          Effect.catchCauseIf((cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logError("Atomic event observer failed", { cause })),
        ), { discard: true }))
        return result
      }),
    )
  })

const publicationScope = (db: Database.Interface["db"]) => Effect.gen(function* () {
  const scope = yield* Effect.serviceOption(PublicationScope)
  if (scope._tag === "None") return undefined
  if (!scope.value.active || scope.value.db !== db)
    return yield* Effect.die("Event transaction scope is closed or belongs to another database")
  const owner = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.id))
  if (scope.value.owner !== owner)
    return yield* Effect.die("Atomic publication is sequential and cannot be delegated to inherited fibers")
  const transaction = yield* Effect.serviceOption(db.$client.transactionService)
  if (transaction._tag === "None" || transaction.value !== scope.value.transaction)
    return yield* Effect.die("Event publication must use its owning atomic transaction, not a plain nested savepoint")
  return scope.value
})

const afterCommit = (db: Database.Interface["db"], notification: Effect.Effect<void>) => Effect.gen(function* () {
  const scope = yield* publicationScope(db)
  if (!scope) return yield* notification
  scope.pending.push(notification)
})

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const all = yield* PubSub.unbounded<Payload>()
      const synchronized = new Map<string, Set<PubSub.PubSub<void>>>()
      const typed = new Map<string, PubSub.PubSub<Payload>>()
      const projectors = new Map<string, AnyProjector[]>()
      const checkpointAdapters = new Map<string, CheckpointAdapter>()
      const commitGuards = new Array<CommitGuard>()
      const listeners = new Array<Listener>()
      const syncHandlers = new Array<Sync>()
      const { db } = yield* Database.Service

      const getOrCreate = (definition: Definition) =>
        Effect.gen(function* () {
          const existing = typed.get(definition.type)
          if (existing) return existing
          const pubsub = yield* PubSub.unbounded<Payload>()
          typed.set(definition.type, pubsub)
          return pubsub
        })

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* PubSub.shutdown(all)
          yield* Effect.forEach(
            synchronized.values(),
            (pubsubs) => Effect.forEach(pubsubs, PubSub.shutdown, { discard: true }),
            { discard: true },
          )
          yield* Effect.forEach(typed.values(), PubSub.shutdown, { discard: true })
        }),
      )

      const registerCheckpointAdapter = (adapter: CheckpointAdapter) =>
        Effect.sync(() => {
          if (checkpointAdapters.has(adapter.id))
            throw new InvalidSyncEventError({
              type: CheckpointCapability,
              message: `Checkpoint adapter ${adapter.id} is already registered`,
            })
          checkpointAdapters.set(adapter.id, adapter)
        })

      const findCheckpointAdapter = (aggregateID: string) =>
        Effect.gen(function* () {
          for (const adapter of checkpointAdapters.values()) {
            const baseline = yield* adapter.capture(aggregateID)
            if (baseline) return { adapter, baseline }
          }
          return yield* Effect.die(
            new InvalidSyncEventError({
              type: CheckpointCapability,
              message: `No trusted projection checkpoint adapter accepted aggregate ${aggregateID}`,
            }),
          )
        })

      const hydrateCheckpoint = (checkpoint: SerializedCheckpoint) =>
        Effect.gen(function* () {
          const adapter = checkpointAdapters.get(checkpoint.baseline.adapter)
          if (!adapter?.hydrate) return checkpoint
          const baseline = yield* adapter.hydrate({
            aggregateID: checkpoint.aggregateID,
            seq: checkpoint.seq,
            baseline: checkpoint.baseline,
          })
          if (baseline.adapter !== adapter.id || baseline.version !== checkpoint.baseline.version)
            return yield* Effect.die(
              new InvalidSyncEventError({
                type: CheckpointCapability,
                message: `Checkpoint adapter ${adapter.id} returned an invalid hydrated baseline identity`,
              }),
            )
          return { ...checkpoint, baseline, baselineHash: checkpointHash(baseline) }
        })

      const materializeCheckpointBeforeMutation = (aggregateID: string) =>
        Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(EventCheckpointTable)
            .where(eq(EventCheckpointTable.aggregate_id, aggregateID))
            .get()
            .pipe(Effect.orDie)
          const stored = readCheckpoint(aggregateID, row)
          if (!row || stored?.version !== CheckpointVersion) return
          const hydrated = yield* hydrateCheckpoint(stored)
          if (hydrated.baselineHash === stored.baselineHash) return
          yield* db
            .update(EventCheckpointTable)
            .set({ data: replaceStoredCheckpointBaseline(row.data, hydrated.baseline) })
            .where(eq(EventCheckpointTable.aggregate_id, aggregateID))
            .run()
            .pipe(Effect.orDie)
        })

      function commitSyncEvent(
        event: Payload,
        input?: {
          readonly seq: number
          readonly aggregateID: string
          readonly ownerID?: string
          readonly strictOwner?: boolean
        },
        commit?: (seq: number) => Effect.Effect<void>,
      ) {
        return Effect.gen(function* () {
          yield* publicationScope(db)
          const definition = event.version === undefined
            ? registry.get(event.type)
            : syncRegistry.get(versionedType(event.type, event.version)) ?? registry.get(event.type)
          const sync = definition?.sync
          if (sync) {
            if (event.version !== sync.version) {
              yield* Effect.die(
                new InvalidSyncEventError({
                  type: event.type,
                  message: `Expected event version ${sync.version}, got ${event.version}`,
                }),
              )
            }
            const aggregateID = (event.data as Record<string, unknown>)[sync.aggregate]
            if (typeof aggregateID !== "string") {
              yield* Effect.die(
                new InvalidSyncEventError({
                  type: event.type,
                  message: `Expected string aggregate field ${sync.aggregate}`,
                }),
              )
            } else {
              if (input && input.aggregateID !== aggregateID) {
                yield* Effect.die(
                  new InvalidSyncEventError({
                    type: event.type,
                    message: `Aggregate mismatch: expected ${input.aggregateID}, got ${aggregateID}`,
                  }),
                )
              }
              const list = projectors.get(event.type) ?? []
              return yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const committed = yield* db
                    .transaction(
                      () =>
                        Effect.gen(function* () {
                          const row = yield* db
                            .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
                            .from(EventSequenceTable)
                            .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                            .get()
                            .pipe(Effect.orDie)
                          const latest = row?.seq ?? -1
                          const encoded = syncRegistry
                            .get(versionedType(definition.type, sync.version))!
                            .encode(event.data) as Record<string, unknown>
                          if (input?.strictOwner && row?.ownerID && row.ownerID !== input.ownerID) {
                            yield* Effect.die(
                              new InvalidSyncEventError({
                                type: event.type,
                                message: `Replay owner mismatch for aggregate ${aggregateID}: expected ${row.ownerID}, got ${input.ownerID ?? "none"}`,
                              }),
                            )
                          }
                          if (input && input.seq <= latest) {
                            const stored = yield* db
                              .select()
                              .from(EventTable)
                              .where(and(eq(EventTable.aggregate_id, aggregateID), eq(EventTable.seq, input.seq)))
                              .get()
                              .pipe(Effect.orDie)
                            if (
                              stored?.id === event.id &&
                              stored.type === versionedType(definition.type, sync.version) &&
                              isDeepStrictEqual(decodeStoredEventData(stored.data), encoded)
                            ) {
                              if (input.ownerID && row?.ownerID == null) {
                                yield* db
                                  .update(EventSequenceTable)
                                  .set({ owner_id: input.ownerID })
                                  .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                                  .run()
                                  .pipe(Effect.orDie)
                              }
                              return
                            }
                            yield* Effect.die(
                              new InvalidSyncEventError({
                                type: event.type,
                                message: `Replay diverged at aggregate ${aggregateID} sequence ${input.seq}`,
                              }),
                            )
                          }
                          if (input && row?.ownerID && row.ownerID !== input.ownerID) {
                            return
                          }
                          const seq = input?.seq ?? latest + 1
                          if (input && seq !== latest + 1) {
                            yield* Effect.die(
                              new InvalidSyncEventError({
                                type: event.type,
                                message: `Sequence mismatch for aggregate ${aggregateID}: expected ${latest + 1}, got ${seq}`,
                              }),
                            )
                          }
                          const stored = yield* db
                            .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
                            .from(EventTable)
                            .where(eq(EventTable.id, event.id))
                            .get()
                            .pipe(Effect.orDie)
                          if (stored)
                            yield* Effect.die(
                              new InvalidSyncEventError({
                                type: event.type,
                                message: `Event ${event.id} already exists at aggregate ${stored.aggregateID} sequence ${stored.seq}`,
                              }),
                            )
                          yield* materializeCheckpointBeforeMutation(aggregateID)
                          for (const guard of commitGuards) {
                            yield* guard(event)
                          }
                          for (const projector of list) {
                            yield* projector({ ...event, seq } as Payload)
                          }
                          if (commit) yield* commit(seq)
                          yield* db
                            .insert(EventSequenceTable)
                            .values([{ aggregate_id: aggregateID, seq, owner_id: input?.ownerID }])
                            .onConflictDoUpdate({
                              target: EventSequenceTable.aggregate_id,
                              set: {
                                seq,
                                ...(input?.ownerID && row?.ownerID == null ? { owner_id: input.ownerID } : {}),
                              },
                            })
                            .run()
                            .pipe(Effect.orDie)
                          yield* db
                            .insert(EventTable)
                            .values([
                              {
                                id: event.id,
                                aggregate_id: aggregateID,
                                seq,
                                type: versionedType(definition.type, sync.version),
                                data: encodeStoredEventData(encoded),
                              },
                            ])
                            .run()
                            .pipe(Effect.orDie)
                          return { aggregateID, seq }
                        }),
                      { behavior: "immediate" },
                    )
                    .pipe(Effect.orDie)
                  if (committed) {
                    yield* afterCommit(db, Effect.forEach(
                      synchronized.get(committed.aggregateID) ?? [],
                      (pubsub) => PubSub.publish(pubsub, undefined),
                      { discard: true },
                    ))
                  }
                  return committed
                }),
              )
            }
          }
        })
      }

      function publishEvent<D extends Definition>(event: Payload<D>, options?: PublishOptions) {
        return Effect.gen(function* () {
          const durable = registry.get(event.type)?.sync !== undefined
          if (!durable && options?.commit)
            return yield* Effect.die(
              new InvalidSyncEventError({
                type: event.type,
                message: "Local commit hooks require a synchronized event",
              }),
            )
          if (durable) {
            const committed = yield* commitSyncEvent(event as Payload, undefined, options?.commit)
            if (committed) {
              event = { ...event, seq: committed.seq }
              yield* afterCommit(db, Effect.forEach(syncHandlers, (sync) => observe(event as Payload, "sync", sync), { discard: true }).pipe(
                Effect.andThen(notify(event as Payload, true)),
              ))
              return event
            }
          }
          yield* afterCommit(db, notify(event as Payload, options?.isolateListeners === true))
          return event
        })
      }

      const observe = (event: Payload, kind: "sync" | "listener", observer: (event: Payload) => Effect.Effect<void>) =>
        Effect.suspend(() => observer(event)).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Effect.logError("Event observer failed", { eventID: event.id, eventType: event.type, kind, cause }),
          ),
        )

      function notify(event: Payload, isolateListeners: boolean) {
        return Effect.gen(function* () {
          yield* Effect.forEach(
            listeners,
            (listener) => (isolateListeners ? observe(event, "listener", listener) : listener(event)),
            { discard: true },
          )
          const pubsub = typed.get(event.type)
          if (pubsub) yield* PubSub.publish(pubsub, event)
          yield* PubSub.publish(all, event)
        })
      }

      function publish<D extends Definition>(definition: D, data: Data<D>, options?: PublishOptions) {
        return Effect.gen(function* () {
          const serviceLocation = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
          const location =
            options?.location ??
            (serviceLocation
              ? { directory: serviceLocation.directory, workspaceID: serviceLocation.workspaceID }
              : undefined)
          return yield* publishEvent(
            {
              id: options?.id ?? ID.create(),
              ...(options?.metadata ? { metadata: options.metadata } : {}),
              type: definition.type,
              ...(definition.sync === undefined ? {} : { version: definition.sync.version }),
              ...(location ? { location } : {}),
              data,
            } as Payload<D>,
            options,
          )
        })
      }

      function replay(
        event: SerializedEvent,
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          const definition = syncRegistry.get(event.type)
          if (!definition) {
            yield* Effect.die(
              new InvalidSyncEventError({ type: event.type, message: `Unknown sync event type ${event.type}` }),
            )
          } else {
            const payload = {
              id: event.id,
              type: definition.type,
              version: definition.sync.version,
              data: definition.decode(event.data),
              replay: true,
            } as Payload
            const committed = yield* commitSyncEvent(payload, {
              seq: event.seq,
              aggregateID: event.aggregateID,
              ownerID: options?.ownerID,
              strictOwner: options?.strictOwner,
            })
            if (committed && options?.publish) {
              yield* afterCommit(db, notify({ ...payload, seq: committed.seq }, true))
            }
          }
        })
      }

      function replayAll(
        events: SerializedEvent[],
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          const source = events[0]?.aggregateID
          if (!source) return undefined
          if (events.some((event) => event.aggregateID !== source)) {
            yield* Effect.die(
              new InvalidSyncEventError({
                type: events[0]?.type ?? "unknown",
                message: "Replay events must belong to the same aggregate",
              }),
            )
          }
          const start = events[0]?.seq ?? 0
          for (const [index, event] of events.entries()) {
            const seq = start + index
            if (event.seq !== seq) {
              yield* Effect.die(
                new InvalidSyncEventError({
                  type: event.type,
                  message: `Replay sequence mismatch at index ${index}: expected ${seq}, got ${event.seq}`,
                }),
              )
            }
          }
          for (const event of events) {
            yield* replay(event, options)
          }
          return source
        })
      }

      const readCheckpoint = (
        aggregateID: string,
        row: typeof EventCheckpointTable.$inferSelect | undefined,
      ): SerializedCheckpoint | LegacySerializedCheckpoint | undefined => {
        if (!row) return undefined
        const data = decodeStoredEventData(row.data)
        if (row.version === LegacyCheckpointVersion) {
          if (!Array.isArray(data.events))
            throw new InvalidSyncEventError({
              type: LegacyCheckpointCapability,
              message: `Legacy checkpoint for aggregate ${aggregateID} has no event prefix`,
            })
          const events = data.events as SerializedEvent[]
          return {
            aggregateID,
            seq: row.seq,
            version: LegacyCheckpointVersion,
            events,
            eventHash: typeof data.eventHash === "string" ? data.eventHash : checkpointEventHash(events),
            ...(typeof data.projectionHash === "string" ? { projectionHash: data.projectionHash } : {}),
            ...(typeof data.compactedSeq === "number"
              ? { compactedSeq: data.compactedSeq }
              : typeof data.compactedAt === "number"
                ? { compactedSeq: row.seq }
                : {}),
            ...(typeof data.compactedAt === "number" ? { compactedAt: data.compactedAt } : {}),
          }
        }
        if (row.version !== CheckpointVersion)
          throw new InvalidSyncEventError({
            type: CheckpointCapability,
            message: `Unsupported stored checkpoint version ${row.version} for aggregate ${aggregateID}`,
          })
        if (!isRecord(data.baseline) || typeof data.baselineHash !== "string" || typeof data.eventHash !== "string")
          throw new InvalidSyncEventError({
            type: CheckpointCapability,
            message: `Checkpoint for aggregate ${aggregateID} has no projection baseline`,
          })
        const baseline = readStoredCheckpointBaseline(row.data)
        return {
          aggregateID,
          seq: row.seq,
          version: CheckpointVersion,
          baseline,
          baselineHash: data.baselineHash,
          eventHash: data.eventHash,
          ...(typeof data.compactedSeq === "number"
            ? { compactedSeq: data.compactedSeq }
            : typeof data.compactedAt === "number"
              ? { compactedSeq: row.seq }
              : {}),
          ...(typeof data.compactedAt === "number" ? { compactedAt: data.compactedAt } : {}),
        }
      }

      const checkpoint = (aggregateID: string) =>
        Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(EventCheckpointTable)
            .where(eq(EventCheckpointTable.aggregate_id, aggregateID))
            .get()
            .pipe(Effect.orDie)
          const stored = readCheckpoint(aggregateID, row)
          if (!stored || stored.version === LegacyCheckpointVersion) return stored
          return yield* hydrateCheckpoint(stored)
        })

      const createCheckpoint = (aggregateID: string) =>
        Effect.gen(function* () {
          const candidate = yield* db
            .transaction(
              () =>
                Effect.gen(function* () {
                  const previousStored = readCheckpoint(
                    aggregateID,
                    yield* db
                      .select()
                      .from(EventCheckpointTable)
                      .where(eq(EventCheckpointTable.aggregate_id, aggregateID))
                      .get()
                      .pipe(Effect.orDie),
                  )
                  const previous = previousStored?.version === CheckpointVersion
                    ? yield* hydrateCheckpoint(previousStored)
                    : previousStored
                  const sequence = yield* db
                    .select({ seq: EventSequenceTable.seq })
                    .from(EventSequenceTable)
                    .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                    .get()
                    .pipe(Effect.orDie)
                  if (!sequence) return undefined
                  const resolved = yield* findCheckpointAdapter(aggregateID)
                  if (resolved.baseline.adapter !== resolved.adapter.id || resolved.baseline.version !== resolved.adapter.version)
                    return yield* Effect.die(
                      new InvalidSyncEventError({
                        type: CheckpointCapability,
                        message: `Checkpoint adapter ${resolved.adapter.id} returned an invalid baseline identity`,
                      }),
                    )
                  const rows = yield* db
                    .select()
                    .from(EventTable)
                    .where(
                      previous?.version === CheckpointVersion
                        ? and(eq(EventTable.aggregate_id, aggregateID), gt(EventTable.seq, previous.seq))
                        : eq(EventTable.aggregate_id, aggregateID),
                    )
                    .orderBy(asc(EventTable.seq))
                    .all()
                    .pipe(Effect.orDie)
                  const tail = rows.map((event) => ({
                    id: event.id,
                    aggregateID: event.aggregate_id,
                    seq: event.seq,
                    type: event.type,
                    data: decodeStoredEventData(event.data, MAX_CHECKPOINT_EVENT_DECODED_BYTES),
                  }))
                  const events = previous?.version === LegacyCheckpointVersion ? [...previous.events, ...tail.filter((event) => event.seq > previous.seq)] : tail
                  const start = previous?.version === CheckpointVersion ? previous.seq + 1 : 0
                  if (events.some((event, index) => event.aggregateID !== aggregateID || event.seq !== start + index))
                    return yield* Effect.die(
                      new InvalidSyncEventError({
                        type: CheckpointCapability,
                        message: `Checkpoint source for aggregate ${aggregateID} is not contiguous from sequence ${start}`,
                      }),
                    )
                  if (sequence.seq !== (events.at(-1)?.seq ?? previous?.seq))
                    return yield* Effect.die(
                      new InvalidSyncEventError({
                        type: CheckpointCapability,
                        message: `Checkpoint source for aggregate ${aggregateID} does not reach sequence ${sequence.seq}`,
                      }),
                    )
                  return {
                    adapter: resolved.adapter,
                    baseline: resolved.baseline,
                    baselineHash: checkpointHash(resolved.baseline),
                    previous,
                    previousStored,
                    events,
                    seq: sequence.seq,
                    eventHash:
                      previous?.version === CheckpointVersion
                        ? checkpointEventHash(events, previous.eventHash)
                        : checkpointEventHash(events),
                  }
                }),
              // Capturing and hydrating a checkpoint can scan a large session projection or
              // wait on external content. A deferred snapshot keeps those reads consistent
              // without reserving SQLite's single writer for the duration of that work.
              { behavior: "deferred" },
            )
            .pipe(Effect.orDie)
          if (!candidate) return undefined
          yield* candidate.adapter.verify({
            aggregateID,
            expected: candidate.baseline,
            ...(candidate.previous?.version === CheckpointVersion ? { previous: candidate.previous.baseline } : {}),
            ...(candidate.previous?.version === CheckpointVersion ? { previousSeq: candidate.previous.seq } : {}),
            events: candidate.events,
          })
          const checkpoint: SerializedCheckpoint = {
            aggregateID,
            seq: candidate.seq,
            version: CheckpointVersion,
            baseline: candidate.baseline,
            baselineHash: candidate.baselineHash,
            eventHash: candidate.eventHash,
            ...(candidate.previous?.compactedSeq === undefined ? {} : { compactedSeq: candidate.previous.compactedSeq }),
            ...(candidate.previous?.compactedAt === undefined ? {} : { compactedAt: candidate.previous.compactedAt }),
          }
          return yield* db
            .transaction(
              () =>
                Effect.gen(function* () {
                  const current = readCheckpoint(
                    aggregateID,
                    yield* db
                      .select()
                      .from(EventCheckpointTable)
                      .where(eq(EventCheckpointTable.aggregate_id, aggregateID))
                      .get()
                      .pipe(Effect.orDie),
                  )
                  if (checkpointHash(current) !== checkpointHash(candidate.previousStored))
                    return yield* Effect.die(
                      new InvalidSyncEventError({
                        type: CheckpointCapability,
                        message: `Checkpoint changed while validating aggregate ${aggregateID}`,
                      }),
                    )
                  const timeCreated = Date.now()
                  yield* db
                    .insert(EventCheckpointTable)
                    .values({
                      aggregate_id: aggregateID,
                      seq: checkpoint.seq,
                      version: CheckpointVersion,
                      data: encodeStoredEventData({
                        baseline: checkpoint.baseline,
                        baselineHash: checkpoint.baselineHash,
                        eventHash: checkpoint.eventHash,
                        ...(checkpoint.compactedSeq === undefined ? {} : { compactedSeq: checkpoint.compactedSeq }),
                        ...(checkpoint.compactedAt === undefined ? {} : { compactedAt: checkpoint.compactedAt }),
                      }),
                      time_created: timeCreated,
                    })
                    .onConflictDoUpdate({
                      target: EventCheckpointTable.aggregate_id,
                      set: {
                        seq: checkpoint.seq,
                        version: CheckpointVersion,
                        data: encodeStoredEventData({
                          baseline: checkpoint.baseline,
                          baselineHash: checkpoint.baselineHash,
                          eventHash: checkpoint.eventHash,
                          ...(checkpoint.compactedSeq === undefined ? {} : { compactedSeq: checkpoint.compactedSeq }),
                          ...(checkpoint.compactedAt === undefined ? {} : { compactedAt: checkpoint.compactedAt }),
                        }),
                        time_created: timeCreated,
                      },
                    })
                    .run()
                    .pipe(Effect.orDie)
                  return checkpoint
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)
        })

      const compactCheckpoint = (aggregateID: string) =>
        Effect.gen(function* () {
          const snapshot = yield* createCheckpoint(aggregateID)
          if (!snapshot) return undefined
          return yield* db
            .transaction(
              () =>
                Effect.gen(function* () {
                  const current = readCheckpoint(
                    aggregateID,
                    yield* db
                      .select()
                      .from(EventCheckpointTable)
                      .where(eq(EventCheckpointTable.aggregate_id, aggregateID))
                      .get()
                      .pipe(Effect.orDie),
                  )
                  if (
                    current?.version !== CheckpointVersion ||
                    current.seq !== snapshot.seq ||
                    current.eventHash !== snapshot.eventHash ||
                    current.baselineHash !== snapshot.baselineHash
                  )
                    return yield* Effect.die(
                      new InvalidSyncEventError({
                        type: CheckpointCapability,
                        message: `Checkpoint changed while compacting aggregate ${aggregateID}`,
                      }),
                    )
                  const covered = yield* db
                    .select({ seq: EventTable.seq })
                    .from(EventTable)
                    .where(and(eq(EventTable.aggregate_id, aggregateID), lte(EventTable.seq, snapshot.seq)))
                    .all()
                    .pipe(Effect.orDie)
                  const compactedAt = Date.now()
                  const checkpoint = { ...current, compactedSeq: snapshot.seq, compactedAt }
                  const adapter = checkpointAdapters.get(checkpoint.baseline.adapter)
                  const baseline = adapter?.normalize
                    ? yield* adapter.normalize({ aggregateID, seq: checkpoint.seq, baseline: checkpoint.baseline })
                    : checkpoint.baseline
                  if (baseline.adapter !== checkpoint.baseline.adapter || baseline.version !== checkpoint.baseline.version)
                    return yield* Effect.die(
                      new InvalidSyncEventError({
                        type: CheckpointCapability,
                        message: `Checkpoint adapter ${checkpoint.baseline.adapter} returned an invalid normalized baseline identity`,
                      }),
                    )
                  yield* db
                    .update(EventCheckpointTable)
                    .set({
                      data: encodeStoredEventData({
                        baseline,
                        baselineHash: checkpointHash(baseline),
                        eventHash: checkpoint.eventHash,
                        compactedSeq: checkpoint.compactedSeq,
                        compactedAt,
                      }),
                      time_created: compactedAt,
                    })
                    .where(eq(EventCheckpointTable.aggregate_id, aggregateID))
                    .run()
                    .pipe(Effect.orDie)
                  yield* db
                    .delete(EventTable)
                    .where(and(eq(EventTable.aggregate_id, aggregateID), lte(EventTable.seq, snapshot.seq)))
                    .run()
                    .pipe(Effect.orDie)
                  return { checkpoint, deleted: covered.length }
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)
        })

      function replayCheckpoint(
        input: SerializedCheckpoint,
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          yield* publicationScope(db)
          if (input.version !== CheckpointVersion)
            return yield* Effect.die(
              new InvalidSyncEventError({
                type: CheckpointCapability,
                message: `Unsupported checkpoint version ${input.version}; expected ${CheckpointVersion}`,
              }),
            )
          if (input.baselineHash !== checkpointHash(input.baseline))
            return yield* Effect.die(
              new InvalidSyncEventError({
                type: CheckpointCapability,
                message: `Checkpoint baseline hash mismatch for aggregate ${input.aggregateID}`,
              }),
            )
          const adapter = checkpointAdapters.get(input.baseline.adapter)
          if (!adapter)
            return yield* Effect.die(
              new InvalidSyncEventError({
                type: CheckpointCapability,
                message: `Checkpoint adapter ${input.baseline.adapter}@${input.baseline.version} is unavailable`,
              }),
            )
          const hydratedInput = yield* hydrateCheckpoint(input)
          const upgraded = hydratedInput.baseline.version === adapter.version
            ? hydratedInput.baseline
            : adapter.upgrade
              ? yield* adapter.upgrade(hydratedInput.baseline)
              : undefined
          if (!upgraded || upgraded.adapter !== adapter.id || upgraded.version !== adapter.version)
            return yield* Effect.die(
              new InvalidSyncEventError({
                type: CheckpointCapability,
                message: `Checkpoint adapter ${input.baseline.adapter}@${input.baseline.version} cannot upgrade to ${adapter.id}@${adapter.version}`,
              }),
            )
          const baseline = adapter.hydrate
            ? yield* adapter.hydrate({ aggregateID: input.aggregateID, seq: input.seq, baseline: upgraded })
            : upgraded
          if (baseline.adapter !== adapter.id || baseline.version !== adapter.version)
            return yield* Effect.die(
              new InvalidSyncEventError({
                type: CheckpointCapability,
                message: `Checkpoint adapter ${adapter.id} returned an invalid hydrated baseline identity`,
              }),
            )
          const baselineHash = checkpointHash(baseline)
          const committed = yield* db
            .transaction(
              () =>
                Effect.gen(function* () {
                  const sequence = yield* db
                    .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
                    .from(EventSequenceTable)
                    .where(eq(EventSequenceTable.aggregate_id, input.aggregateID))
                    .get()
                    .pipe(Effect.orDie)
                  if (options?.strictOwner && sequence?.ownerID && sequence.ownerID !== options.ownerID)
                    return yield* Effect.die(
                      new InvalidSyncEventError({
                        type: CheckpointCapability,
                        message: `Replay owner mismatch for aggregate ${input.aggregateID}: expected ${sequence.ownerID}, got ${options.ownerID ?? "none"}`,
                      }),
                    )
                  const storedRow = yield* db
                    .select()
                    .from(EventCheckpointTable)
                    .where(eq(EventCheckpointTable.aggregate_id, input.aggregateID))
                    .get()
                    .pipe(Effect.orDie)
                  const stored = readCheckpoint(input.aggregateID, storedRow)
                  const hydratedStored = stored?.version === CheckpointVersion
                    ? yield* hydrateCheckpoint(stored)
                    : stored
                  if (sequence) {
                    if (
                      sequence.seq >= input.seq &&
                      hydratedStored?.version === CheckpointVersion &&
                      hydratedStored.seq === input.seq &&
                      [input.baselineHash, hydratedInput.baselineHash, baselineHash].includes(hydratedStored.baselineHash) &&
                      hydratedStored.eventHash === input.eventHash
                    ) {
                      if (
                        stored?.version === CheckpointVersion &&
                        (stored.baseline.adapter !== adapter.id || stored.baseline.version !== adapter.version) &&
                        storedRow
                      )
                        yield* db
                          .update(EventCheckpointTable)
                          .set({ data: replaceStoredCheckpointBaseline(storedRow.data, baseline) })
                          .where(eq(EventCheckpointTable.aggregate_id, input.aggregateID))
                          .run()
                          .pipe(Effect.orDie)
                      if (options?.ownerID && !sequence.ownerID)
                        yield* db
                          .update(EventSequenceTable)
                          .set({ owner_id: options.ownerID })
                          .where(eq(EventSequenceTable.aggregate_id, input.aggregateID))
                          .run()
                          .pipe(Effect.orDie)
                      return false
                    }
                    return yield* Effect.die(
                      new InvalidSyncEventError({
                        type: CheckpointCapability,
                        message: `Checkpoint replay requires a fresh aggregate; ${input.aggregateID} is already at sequence ${sequence.seq}`,
                      }),
                    )
                  }
                  yield* adapter.restore(input.aggregateID, baseline)
                  yield* db
                    .insert(EventSequenceTable)
                    .values({ aggregate_id: input.aggregateID, seq: input.seq, owner_id: options?.ownerID })
                    .run()
                    .pipe(Effect.orDie)
                  const compactedAt = Date.now()
                  yield* db
                    .insert(EventCheckpointTable)
                    .values({
                      aggregate_id: input.aggregateID,
                      seq: input.seq,
                      version: CheckpointVersion,
                      data: encodeStoredEventData({
                        baseline,
                        baselineHash,
                        eventHash: input.eventHash,
                        compactedSeq: input.seq,
                        compactedAt,
                      }),
                      time_created: compactedAt,
                    })
                    .run()
                    .pipe(Effect.orDie)
                  return true
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)
          if (!committed) return input.aggregateID
          yield* afterCommit(db, Effect.forEach(
            synchronized.get(input.aggregateID) ?? [],
            (pubsub) => PubSub.publish(pubsub, undefined),
            { discard: true },
          ))
          return input.aggregateID
        })
      }

      function remove(aggregateID: string) {
        return db
          .transaction(() =>
            Effect.gen(function* () {
              yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).run()
              yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).run()
            }),
          )
          .pipe(Effect.orDie)
      }

      function claim(aggregateID: string, ownerID: string) {
        return db
          .update(EventSequenceTable)
          .set({ owner_id: ownerID })
          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
          .run()
          .pipe(Effect.orDie)
      }

      const subscribe = <D extends Definition>(definition: D): Stream.Stream<Payload<D>> =>
        Stream.unwrap(getOrCreate(definition).pipe(Effect.map((pubsub) => Stream.fromPubSub(pubsub)))).pipe(
          Stream.map((event) => event as Payload<D>),
        )

      const streamAll = (): Stream.Stream<Payload> => Stream.fromPubSub(all)

      const decodeSerializedEvent = (event: SerializedEvent): CursorEvent => {
        const definition = syncRegistry.get(event.type)
        if (!definition) {
          throw new InvalidSyncEventError({ type: event.type, message: `Unknown sync event type ${event.type}` })
        }
        return {
          cursor: Cursor.make(event.seq),
          event: {
            id: event.id,
            type: definition.type,
            version: definition.sync.version,
            seq: event.seq,
            data: definition.decode(event.data),
          },
        }
      }

      const readAfter = (aggregateID: string, after: number) =>
        (options?.beforeAggregateRead?.(aggregateID) ?? Effect.void).pipe(
          Effect.andThen(
            db
              .select()
              .from(EventTable)
              .where(and(eq(EventTable.aggregate_id, aggregateID), gt(EventTable.seq, after)))
              .orderBy(asc(EventTable.seq))
              .all(),
          ),
          Effect.orDie,
          Effect.map((rows) =>
            rows.map((event) =>
              decodeSerializedEvent({
                id: event.id,
                aggregateID: event.aggregate_id,
                seq: event.seq,
                type: event.type,
                data: decodeStoredEventData(event.data),
              }),
            ),
          ),
        )

      const subscribeSynchronized = (aggregateID: string) =>
        Effect.gen(function* () {
          const pubsub = yield* PubSub.sliding<void>(1)
          const subscription = yield* PubSub.subscribe(pubsub)
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const pubsubs = synchronized.get(aggregateID) ?? new Set()
              pubsubs.add(pubsub)
              synchronized.set(aggregateID, pubsubs)
            }),
            () =>
              Effect.sync(() => {
                const pubsubs = synchronized.get(aggregateID)
                pubsubs?.delete(pubsub)
                if (pubsubs?.size === 0) synchronized.delete(aggregateID)
              }).pipe(Effect.andThen(PubSub.shutdown(pubsub))),
          )
          return subscription
        })

      const streamEvents = (input: {
        readonly aggregateID: string
        readonly after?: Cursor
      }): Stream.Stream<CursorEvent> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const synchronized = yield* subscribeSynchronized(input.aggregateID)
            let cursor = input.after ?? -1
            const read = Effect.suspend(() => readAfter(input.aggregateID, cursor)).pipe(
              Effect.tap((events) =>
                Effect.sync(() => {
                  cursor = events.at(-1)?.cursor ?? cursor
                }),
              ),
            )
            const historical = yield* read
            const live = Stream.fromSubscription(synchronized).pipe(
              Stream.mapEffect(() => read),
              Stream.flattenIterable,
            )
            return Stream.concat(Stream.fromIterable(historical), live)
          }),
        )

      const listen = (listener: Listener): Effect.Effect<Unsubscribe> =>
        Effect.sync(() => {
          listeners.push(listener)
          return Effect.sync(() => {
            const index = listeners.indexOf(listener)
            if (index >= 0) listeners.splice(index, 1)
          })
        })

      const sync = (handler: Sync): Effect.Effect<Unsubscribe> =>
        Effect.sync(() => {
          syncHandlers.push(handler)
          return Effect.sync(() => {
            const index = syncHandlers.indexOf(handler)
            if (index >= 0) syncHandlers.splice(index, 1)
          })
        })

      const beforeCommit = (guard: CommitGuard): Effect.Effect<void> =>
        Effect.sync(() => {
          commitGuards.push(guard)
        })

      const project = <D extends Definition>(definition: D, projector: Projector<D>): Effect.Effect<void> =>
        Effect.sync(() => {
          const list = projectors.get(definition.type) ?? []
          list.push((event) => projector(event as Payload<D>))
          projectors.set(definition.type, list)
        })

      return Service.of({
        publish,
        subscribe,
        all: streamAll,
        aggregateEvents: streamEvents,
        sync,
        listen,
        beforeCommit,
        project,
        registerCheckpointAdapter,
        replay,
        replayAll,
        createCheckpoint,
        checkpoint,
        compactCheckpoint,
        replayCheckpoint,
        remove,
        claim,
      })
    }),
  )

export const layer = layerWith()
export const node = LayerNode.make(layer, [Database.node])

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
