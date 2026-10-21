export * as SessionArchive from "./session-archive"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { createHash, randomUUID } from "crypto"
import { asc, eq, sql, type SQL } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { existsSync } from "fs"
import { mkdir, realpath, stat } from "fs/promises"
import path from "path"
import {
  SessionArchiveCatalogTable,
  SessionArchiveJournalTable,
  SessionArchiveShardTable,
  type SessionArchiveJournalState,
} from "./archive.sql"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { SessionProjector } from "./session/projector"
import * as SessionProtection from "./session/protection"
import { SessionSchema } from "./session/schema"
import { Hash } from "./util/hash"

type DatabaseShape = Database.Interface["db"]
type QueryDatabase = Pick<DatabaseShape, "all" | "get" | "run">
type ActiveReadDatabase = Pick<DatabaseShape, "select">
type RawValue = string | number | bigint | Uint8Array | null
type RawRow = Record<string, RawValue>
type JournalRow = typeof SessionArchiveJournalTable.$inferSelect
type CatalogRow = typeof SessionArchiveCatalogTable.$inferSelect
type RawCatalogRow = Omit<CatalogRow, "session_data"> & { readonly session_data: string | null }
type StoredMutationReference = {
  readonly mutation_id: string
  readonly before_sha256: string | null
  readonly after_sha256: string | null
  readonly row_hash: string
}

const DEFAULT_INACTIVE_MS = 7 * 24 * 60 * 60 * 1_000
const DEFAULT_SHARD_BYTES = 2_000_000_000
const DEFAULT_LEASE_MS = 5 * 60 * 1_000
const CLAIM_WAIT_MS = 5_000
const PAGE_SIZE = 128
const SHARD_FORMAT_VERSION = 1
const SNAPSHOT_FORMAT_VERSION = 1
const SHA256 = /^[0-9a-f]{64}$/
const LEGACY_PROJECTION_MARKER = "legacy_projection_checkpoint"

const sections = [
  { name: "todo", column: "session_id", order: ["position"] },
  { name: "session_activity", column: "session_id", order: ["time_created", "id"] },
  { name: "session_context_epoch", column: "session_id", order: ["session_id"] },
  { name: "session_file_mutation", column: "session_id", order: ["time_created", "id"] },
  { name: "session_share", column: "session_id", order: ["session_id"] },
  { name: "attachment", column: "session_id", order: ["created_at", "id"] },
  { name: "event_sequence", column: "aggregate_id", order: ["aggregate_id"] },
  { name: "event_checkpoint", column: "aggregate_id", order: ["seq"] },
  { name: "event", column: "aggregate_id", order: ["seq"] },
] as const

type SectionName = (typeof sections)[number]["name"]

type Summary = {
  readonly session: RawRow
  readonly hash: string
  readonly bytes: number
  readonly messageCount: number
  readonly inputCount: number
}

type Visitor = {
  readonly session?: (row: RawRow, data: string) => Effect.Effect<void>
  readonly section?: (name: SectionName, ordinal: number, row: RawRow, data: string) => Effect.Effect<void>
  readonly message?: (row: RawRow, data: string) => Effect.Effect<void>
  readonly input?: (row: RawRow, data: string) => Effect.Effect<void>
  readonly legacyMessage?: (row: RawRow, data: string) => Effect.Effect<void>
  readonly legacyPart?: (row: RawRow, data: string) => Effect.Effect<void>
  readonly batch?: () => Effect.Effect<void>
}

export type CatalogEntry = {
  readonly sessionID: SessionSchema.ID
  readonly projectID: string
  readonly title: string
  readonly directory: string
  readonly sessionData?: Readonly<Record<string, unknown>>
  readonly location: "active" | "archived"
  readonly shardID?: string
  readonly revision: number
  readonly contentHash?: string
  readonly messageCount: number
  readonly inputCount: number
  readonly logicalBytes: number
  readonly timeCreated: number
  readonly timeLastModified: number
  readonly timeArchived?: number
}

export type MessagePage = {
  readonly rows: ReadonlyArray<RawRow>
  readonly hasOlder: boolean
  readonly hasNewer: boolean
  readonly hasPrevious: boolean
  readonly hasNext: boolean
}

export type LegacyMessage = {
  readonly message: Readonly<RawRow>
  readonly parts: ReadonlyArray<Readonly<RawRow>>
}

export type LegacyMessagePage = {
  readonly items: ReadonlyArray<LegacyMessage>
  readonly more: boolean
  readonly cursor?: { readonly id: string; readonly time: number }
}

export type MessageOrder = "asc" | "desc"

export type MessageCursor = {
  readonly messageID: string
  readonly direction: "previous" | "next"
}

export type MessagePageOptions = {
  readonly cursor?: MessageCursor
  readonly limit?: number
  readonly order?: MessageOrder
}

export type MessageTargetPage = MessagePage & {
  readonly targetID: string
  readonly targetIndex: number
}

export type CatalogOrder = "created-desc" | "created-asc" | "updated-desc" | "updated-asc" | "title-asc" | "title-desc"

export type CatalogAnchor = {
  readonly sessionID: SessionSchema.ID
  readonly timeCreated: number
  readonly timeLastModified: number
  readonly title: string
}

export type CatalogListOptions = {
  readonly directory?: string
  readonly projectID?: string
  readonly workspaceID?: string | null
  readonly location?: "active" | "archived"
  readonly search?: string
  readonly includeHidden?: boolean
  readonly order?: CatalogOrder
  readonly anchor?: CatalogAnchor
  readonly limit?: number
}

export type CatalogPage = {
  readonly rows: ReadonlyArray<CatalogEntry>
  readonly hasMore: boolean
  readonly nextAnchor?: CatalogAnchor
}

export type AttachmentRecord = {
  readonly attachmentID: string
  readonly blobSha256: string
  readonly metadata: Readonly<RawRow>
}

export type InputPage = {
  readonly rows: ReadonlyArray<RawRow>
  readonly hasOlder: boolean
  readonly hasNewer: boolean
  readonly hasPrevious: boolean
  readonly hasNext: boolean
}

export type InputPageOptions = {
  readonly cursor?: { readonly inputID: string; readonly direction: "previous" | "next" }
  readonly limit?: number
  readonly order?: MessageOrder
}

export type EventReplayPage = {
  readonly sequence?: Readonly<RawRow>
  readonly checkpoint?: Readonly<RawRow>
  readonly tail: ReadonlyArray<RawRow>
  readonly hasMore: boolean
  readonly nextSeq?: number
}

export type ArchiveResult = {
  readonly sessionID: SessionSchema.ID
  readonly shardID: string
  readonly revision: number
  readonly contentHash: string
  readonly logicalBytes: number
}

export type PurgeResult = {
  readonly sessionID: SessionSchema.ID
  readonly shardID: string
  readonly revision: number
  readonly logicalBytes: number
}

export type CandidateStats = {
  /** Inactive by durable DB state; process ownership or pending questions may still make them unavailable. */
  readonly backlog: number
  readonly oldestEligibleAt?: number
}

export type ReactivationResult = {
  readonly sessionID: SessionSchema.ID
  readonly revision: number
  readonly reactivated: boolean
}

export class IntegrityError extends Schema.TaggedErrorClass<IntegrityError>()("SessionArchive.IntegrityError", {
  sessionID: SessionSchema.ID,
  message: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionArchive.NotFoundError", {
  sessionID: SessionSchema.ID,
  itemID: Schema.optional(Schema.String),
}) {}

export type Error = IntegrityError | NotFoundError

export type Options = {
  readonly directory: string
  readonly isIdle: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  readonly inactiveMs?: number
  readonly maxShardBytes?: number
  readonly leaseMs?: number
  readonly now?: () => number
}

export interface Interface {
  readonly initialize: Effect.Effect<void>
  readonly refreshCatalog: (sessionID?: SessionSchema.ID) => Effect.Effect<void>
  readonly getCatalog: (sessionID: SessionSchema.ID) => Effect.Effect<CatalogEntry, NotFoundError>
  readonly listCatalog: (options?: CatalogListOptions) => Effect.Effect<CatalogPage>
  readonly candidateStats: Effect.Effect<CandidateStats>
  readonly candidates: (limit?: number) => Effect.Effect<ReadonlyArray<SessionSchema.ID>>
  readonly archiveOne: (sessionID?: SessionSchema.ID) => Effect.Effect<ArchiveResult | undefined, IntegrityError>
  readonly purgeCandidates: (inactiveMs: number, limit?: number) => Effect.Effect<ReadonlyArray<SessionSchema.ID>>
  readonly purgeOne: (
    sessionID: SessionSchema.ID,
    inactiveMs: number,
  ) => Effect.Effect<PurgeResult | undefined, IntegrityError>
  readonly readMessages: (
    sessionID: SessionSchema.ID,
    options?: MessagePageOptions,
  ) => Effect.Effect<MessagePage, NotFoundError | IntegrityError>
  readonly readMessage: (
    sessionID: SessionSchema.ID,
    messageID: string,
  ) => Effect.Effect<Readonly<RawRow>, NotFoundError | IntegrityError>
  readonly readLegacyMessages: (
    sessionID: SessionSchema.ID,
    options?: { readonly before?: { readonly id: string; readonly time: number }; readonly limit?: number },
  ) => Effect.Effect<LegacyMessagePage, NotFoundError | IntegrityError>
  readonly readLegacyMessage: (
    sessionID: SessionSchema.ID,
    messageID: string,
  ) => Effect.Effect<LegacyMessage, NotFoundError | IntegrityError>
  readonly resolveMessageTarget: (
    sessionID: SessionSchema.ID,
    target: {
      readonly messageID: string
      readonly before?: number
      readonly after?: number
      readonly order?: MessageOrder
    },
  ) => Effect.Effect<MessageTargetPage, NotFoundError | IntegrityError>
  readonly readAttachment: (
    sessionID: SessionSchema.ID,
    attachmentID: string,
  ) => Effect.Effect<AttachmentRecord, NotFoundError | IntegrityError>
  readonly readInputs: (
    sessionID: SessionSchema.ID,
    options?: InputPageOptions,
  ) => Effect.Effect<InputPage, NotFoundError | IntegrityError>
  readonly readEventReplay: (
    sessionID: SessionSchema.ID,
    options?: { readonly afterSeq?: number; readonly limit?: number },
  ) => Effect.Effect<EventReplayPage, NotFoundError | IntegrityError>
  readonly ensureActive: (sessionID: SessionSchema.ID) => Effect.Effect<ReactivationResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionArchive") {}

const makeShardDatabase = EffectDrizzleSqlite.makeWithDefaults()

export function make(options: Options) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const inactiveMs = options.inactiveMs ?? DEFAULT_INACTIVE_MS
    const maxShardBytes = options.maxShardBytes ?? DEFAULT_SHARD_BYTES
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    const now = options.now ?? Date.now
    const root = path.resolve(options.directory)
    const exclusive = Semaphore.makeUnsafe(1).withPermit

    const initialize = Effect.gen(function* () {
      const objects = new Set(
        (yield* db
          .all<{ name: string }>(
            `
          SELECT name FROM sqlite_master
          WHERE name IN (${catalogObjects.map((object) => `'${object}'`).join(", ")})
        `,
          )
          .pipe(Effect.orDie)).map((object) => object.name),
      )
      if (catalogObjects.every((object) => objects.has(object)) && existsSync(root)) return
      yield* Effect.tryPromise(() => mkdir(root, { recursive: true })).pipe(Effect.orDie)
      yield* Effect.tryPromise(() => realpath(root)).pipe(Effect.orDie)
      for (const statement of catalogSchema) yield* db.run(statement).pipe(Effect.orDie)
    })

    const refreshCatalog: Interface["refreshCatalog"] = Effect.fn("SessionArchive.refreshCatalog")(
      function* (sessionID) {
        const rows = yield* db
          .all<
            RawRow & {
              id: string
              project_id: string
              title: string
              directory: string
              time_created: number
              time_updated: number
              message_count: number
              input_count: number
            }
          >(
            sql`
              SELECT s.*,
                (SELECT COUNT(*) FROM session_message sm WHERE sm.session_id = s.id) AS message_count,
                (SELECT COUNT(*) FROM session_input si WHERE si.session_id = s.id) AS input_count
              FROM session s
              ${sessionID === undefined ? sql`` : sql`WHERE s.id = ${sessionID}`}
              ORDER BY s.time_updated DESC, s.id
            `,
          )
          .pipe(Effect.orDie)
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* Effect.forEach(
                rows,
                (row) =>
                  tx
                    .insert(SessionArchiveCatalogTable)
                    .values({
                      session_id: SessionSchema.ID.make(row.id),
                      project_id: row.project_id,
                      title: row.title,
                      directory: row.directory,
                      session_data: sessionData(row),
                      location: "active",
                      revision: 0,
                      message_count: row.message_count,
                      input_count: row.input_count,
                      logical_bytes: 0,
                      time_last_modified: row.time_updated,
                      time_created: row.time_created,
                      time_updated: now(),
                    })
                    .onConflictDoUpdate({
                      target: SessionArchiveCatalogTable.session_id,
                      set: {
                        project_id: row.project_id,
                        title: row.title,
                        directory: row.directory,
                        session_data: sessionData(row),
                        location: "active",
                        shard_id: null,
                        message_count: row.message_count,
                        input_count: row.input_count,
                        time_last_modified: row.time_updated,
                        time_updated: now(),
                      },
                    })
                    .run(),
                { discard: true },
              )
              yield* tx.run(sql`
                DELETE FROM session_archive_catalog
                WHERE location = 'active'
                  ${sessionID === undefined ? sql`` : sql`AND session_id = ${sessionID}`}
                  AND NOT EXISTS (
                    SELECT 1 FROM session WHERE session.id = session_archive_catalog.session_id
                  )
              `)
            }),
          )
          .pipe(Effect.orDie)
      },
    )

    const getCatalog: Interface["getCatalog"] = Effect.fn("SessionArchive.getCatalog")(function* (sessionID) {
      const row = yield* catalogFor(db, sessionID)
      if (!row) return yield* new NotFoundError({ sessionID })
      return fromCatalogRow(row)
    })

    const listCatalog: Interface["listCatalog"] = Effect.fn("SessionArchive.listCatalog")(function* (query = {}) {
      const limit = Math.max(1, Math.min(query.limit ?? 100, 500))
      const order = query.order ?? "created-desc"
      const filters = [
        query.directory === undefined ? undefined : sql`directory = ${query.directory}`,
        query.projectID === undefined ? undefined : sql`project_id = ${query.projectID}`,
        query.location === undefined ? undefined : sql`location = ${query.location}`,
        query.workspaceID === undefined
          ? undefined
          : query.workspaceID === null
            ? sql`json_extract(session_data, '$.workspace_id') IS NULL`
            : sql`json_extract(session_data, '$.workspace_id') = ${query.workspaceID}`,
        query.includeHidden ? undefined : sql`json_extract(session_data, '$.time_archived') IS NULL`,
        catalogSearch(query.search),
        catalogAnchorFilter(order, query.anchor),
      ].filter((filter): filter is SQL => filter !== undefined)
      const rows = yield* db
        .all<RawCatalogRow>(
          sql`
          SELECT * FROM session_archive_catalog
          WHERE ${filters.length === 0 ? sql`1 = 1` : sql.join(filters, sql` AND `)}
          ORDER BY ${catalogOrder(order)}
          LIMIT ${limit + 1}
        `,
        )
        .pipe(Effect.orDie)
      const page = rows.slice(0, limit).map(decodeCatalogRow).map(fromCatalogRow)
      const last = page.at(-1)
      return {
        rows: page,
        hasMore: rows.length > limit,
        ...(last
          ? {
              nextAnchor: {
                sessionID: last.sessionID,
                timeCreated: last.timeCreated,
                timeLastModified: last.timeLastModified,
                title: last.title,
              },
            }
          : {}),
      }
    })

    const candidateStats = Effect.gen(function* () {
      const cutoff = now() - inactiveMs
      const row = yield* db
        .get<{ backlog: number; oldest_eligible_at: number | null }>(
          sql`
          SELECT COUNT(*) AS backlog, MIN(s.time_updated) AS oldest_eligible_at
          FROM session s
          WHERE ${candidateFilter(cutoff)}
        `,
        )
        .pipe(Effect.orDie)
      return {
        backlog: row?.backlog ?? 0,
        ...(row?.oldest_eligible_at === null || row?.oldest_eligible_at === undefined
          ? {}
          : { oldestEligibleAt: row.oldest_eligible_at }),
      }
    })

    const candidates: Interface["candidates"] = Effect.fn("SessionArchive.candidates")(function* (limit = 100) {
      const requested = Math.max(1, Math.min(limit, 1_000))
      const cutoff = now() - inactiveMs
      const pageSize = 100
      const scan = (
        after?: { readonly id: string; readonly timeUpdated: number },
        found: ReadonlyArray<SessionSchema.ID> = [],
      ): Effect.Effect<ReadonlyArray<SessionSchema.ID>> =>
        Effect.gen(function* () {
          const rows = yield* candidateRows(db, cutoff, pageSize, undefined, after)
          const protectedSet = yield* SessionProtection.protectedIDs(
            db,
            rows.map((row) => SessionSchema.ID.make(row.id)),
          )
          const idle = yield* Effect.filter(
            rows.filter((row) => !protectedSet.has(SessionSchema.ID.make(row.id))),
            (row) => options.isIdle(SessionSchema.ID.make(row.id)),
          )
          const selected = [...found, ...idle.map((row) => SessionSchema.ID.make(row.id))].slice(0, requested)
          const last = rows.at(-1)
          if (selected.length === requested || rows.length < pageSize || !last) return selected
          return yield* scan({ id: last.id, timeUpdated: last.time_updated }, selected)
        })
      return yield* scan()
    })

    const archiveOne: Interface["archiveOne"] = (sessionID) =>
      exclusive(
        SessionProtection.withMutationLock(
          Effect.gen(function* () {
            const selected = sessionID ?? (yield* candidates(1))[0]
            if (!selected) return
            const existing = yield* catalogFor(db, selected)
            if (existing?.location === "archived") return yield* archiveResult(selected, existing)
            if (yield* SessionProtection.isProtected(db, selected)) return
            if (sessionID && !(yield* candidatesForSession(db, selected, now() - inactiveMs))) return
            if (!(yield* options.isIdle(selected))) return
            yield* SessionProjector.materializeActiveCheckpoint(db, selected)
            yield* refreshCatalog(selected)
            const catalog = yield* catalogFor(db, selected)
            if (!catalog) return
            if (catalog.location === "archived") return yield* archiveResult(selected, catalog)
            if (yield* SessionProtection.isProtected(db, selected)) return

            const estimate = yield* scanActive(db, selected)
            if (!estimate) return
            const revision = catalog.revision + 1
            const operationKey = `archive:${selected}:${revision}`
            const claim = yield* claimJournal({
              db,
              operationKey,
              sessionID: selected,
              operation: "archive",
              revision,
              now,
              leaseMs,
            }).pipe(Effect.mapError((cause) => integrity(selected, cause)))
            if (!claim.owned) {
              const current = yield* catalogFor(db, selected)
              if (current?.location === "archived") return yield* archiveResult(selected, current)
              return yield* new IntegrityError({ sessionID: selected, message: "Archive operation is already owned" })
            }

            const shard = claim.row.shard_id
              ? yield* shardFor(db, claim.row.shard_id, selected)
              : yield* selectShard(db, root, maxShardBytes, estimate.bytes, now()).pipe(
                  Effect.mapError((cause) => integrity(selected, cause)),
                )
            yield* bindJournalShard(db, operationKey, claim.owner, shard.id, now()).pipe(
              Effect.mapError((cause) => integrity(selected, cause)),
            )
            const copied = yield* copyActiveToShard({
              active: db,
              root,
              filename: shard.path,
              sessionID: selected,
              revision,
              heartbeat: () => heartbeatJournal(db, operationKey, claim.owner, now()).pipe(Effect.orDie),
              timestamp: now(),
            }).pipe(Effect.mapError((cause) => integrity(selected, cause)))
            const copiedSource = yield* scanActive(db, selected)
            if (!copiedSource || copiedSource.hash !== copied.hash || !(yield* options.isIdle(selected))) {
              const error = new IntegrityError({
                sessionID: selected,
                message: "Session changed or resumed before archive revision cleanup",
              })
              yield* failJournal(db, operationKey, claim.owner, now(), error.message)
              return yield* error
            }
            yield* updateJournal(db, operationKey, claim.owner, "copied", now(), copied).pipe(
              Effect.mapError((cause) => integrity(selected, cause)),
            )
            yield* pruneArchivedRevisions(db, root, selected, revision, now()).pipe(
              Effect.mapError((cause) => integrity(selected, cause)),
              Effect.tapError((error) => failJournal(db, operationKey, claim.owner, now(), error.message)),
            )
            const fileBytes = yield* sizeWithWal(shard.path).pipe(
              Effect.mapError((cause) => integrity(selected, cause)),
            )

            yield* db
              .transaction(
                (tx) =>
                  Effect.gen(function* () {
                    yield* requireJournalOwner(tx, operationKey, claim.owner, selected)
                    if (yield* SessionProtection.isProtected(tx, selected))
                      return yield* new IntegrityError({
                        sessionID: selected,
                        message: "Session became protected while its archive snapshot was being written",
                      })
                    if (!(yield* candidatesForSession(tx, selected, now() - inactiveMs)))
                      return yield* new IntegrityError({
                        sessionID: selected,
                        message: "Session became active while its archive snapshot was being written",
                      })
                    if (!(yield* options.isIdle(selected)))
                      return yield* new IntegrityError({
                        sessionID: selected,
                        message: "Session runner became active while its archive snapshot was being written",
                      })
                    const current = yield* scanActive(tx, selected)
                    if (!current || current.hash !== copied.hash)
                      return yield* new IntegrityError({
                        sessionID: selected,
                        message: "Session changed while its archive snapshot was being written",
                      })
                    yield* tx
                      .update(SessionArchiveCatalogTable)
                      .set({
                        location: "archived",
                        session_data: copied.session,
                        shard_id: shard.id,
                        revision,
                        content_hash: copied.hash,
                        message_count: copied.messageCount,
                        input_count: copied.inputCount,
                        logical_bytes: copied.bytes,
                        time_last_modified: Number(copied.session.time_updated),
                        time_archived: now(),
                        time_updated: now(),
                      })
                      .where(eq(SessionArchiveCatalogTable.session_id, selected))
                      .run()
                    yield* deleteActiveSnapshot(tx, selected)
                    yield* tx.run(sql`
                    UPDATE session_archive_shard SET
                      size_bytes = ${fileBytes},
                      session_count = session_count + 1,
                      state = CASE WHEN ${fileBytes >= maxShardBytes ? 1 : 0} = 1 THEN 'sealed' ELSE state END,
                      time_sealed = CASE WHEN ${fileBytes >= maxShardBytes ? 1 : 0} = 1 THEN ${now()} ELSE time_sealed END,
                      time_updated = ${now()}
                    WHERE id = ${shard.id}
                  `)
                    yield* completeJournal(tx, operationKey, claim.owner, now())
                  }),
                { behavior: "immediate" },
              )
              .pipe(
                Effect.mapError((cause) => (cause instanceof IntegrityError ? cause : integrity(selected, cause))),
                Effect.tapError((error) => failJournal(db, operationKey, claim.owner, now(), error.message)),
              )
            return {
              sessionID: selected,
              shardID: shard.id,
              revision,
              contentHash: copied.hash,
              logicalBytes: copied.bytes,
            }
          }),
        ),
      )

    const purgeCandidates: Interface["purgeCandidates"] = Effect.fn("SessionArchive.purgeCandidates")(function* (
      retentionMs,
      limit = 100,
    ) {
      const requested = Math.max(1, Math.min(limit, 1_000))
      const cutoff = now() - retentionMs
      const rows = yield* db
        .all<{ session_id: string }>(
          sql`
            SELECT session_id FROM session_archive_catalog
            WHERE location = 'archived' AND time_last_modified < ${cutoff}
              AND NOT EXISTS (
                SELECT 1 FROM session_protection sp WHERE sp.session_id = session_archive_catalog.session_id
              )
            ORDER BY time_last_modified, session_id
            LIMIT ${requested}
          `,
        )
        .pipe(Effect.orDie)
      return rows.map((row) => SessionSchema.ID.make(row.session_id))
    })

    const purgeOne: Interface["purgeOne"] = (sessionID, retentionMs) =>
      exclusive(
        SessionProtection.withMutationLock(
          Effect.gen(function* () {
            const catalog = yield* catalogFor(db, sessionID)
            if (!catalog || catalog.location !== "archived" || catalog.time_last_modified >= now() - retentionMs) return
            if (yield* SessionProtection.isProtected(db, sessionID)) return
            if (!catalog.shard_id)
              return yield* new IntegrityError({ sessionID, message: "Archived catalog entry has no shard" })
            const shard = yield* shardFor(db, catalog.shard_id, sessionID)
            const operationKey = `archive-access:${sessionID}:${catalog.revision}`
            const claim = yield* claimJournal({
              db,
              operationKey,
              sessionID,
              operation: "purge",
              revision: catalog.revision,
              shardID: shard.id,
              now,
              leaseMs,
            }).pipe(Effect.mapError((cause) => integrity(sessionID, cause)))
            if (!claim.owned) return

            yield* withShardWrite(root, shard.path, (archive) =>
              Effect.gen(function* () {
                yield* archive.run(sql`DELETE FROM archive_session WHERE session_id = ${sessionID}`)
                yield* archive.run("PRAGMA wal_checkpoint(TRUNCATE)")
                yield* archive.run("PRAGMA incremental_vacuum")
              }),
            ).pipe(
              Effect.mapError((cause) => integrity(sessionID, cause)),
              Effect.tapError((error) => failJournal(db, operationKey, claim.owner, now(), error.message)),
            )
            const fileBytes = yield* sizeWithWal(shard.path).pipe(
              Effect.mapError((cause) => integrity(sessionID, cause)),
              Effect.tapError((error) => failJournal(db, operationKey, claim.owner, now(), error.message)),
            )
            yield* db
              .transaction(
                (tx) =>
                  Effect.gen(function* () {
                    yield* requireJournalOwner(tx, operationKey, claim.owner, sessionID)
                    const current = yield* catalogSnapshotFor(tx, sessionID)
                    const protectedState = yield* SessionProtection.isProtected(tx, sessionID)
                    if (
                      !current ||
                      current.location !== "archived" ||
                      current.revision !== catalog.revision ||
                      current.shard_id !== shard.id ||
                      current.time_last_modified >= now() - retentionMs ||
                      protectedState
                    )
                      return yield* new IntegrityError({
                        sessionID,
                        message: "Session changed before permanent archive deletion",
                      })
                    yield* tx
                      .delete(SessionArchiveCatalogTable)
                      .where(eq(SessionArchiveCatalogTable.session_id, sessionID))
                      .run()
                    yield* tx.run(sql`
                    UPDATE session_archive_shard SET
                      size_bytes = ${fileBytes}, session_count = MAX(0, session_count - 1), time_updated = ${now()}
                    WHERE id = ${shard.id}
                  `)
                    yield* completeJournal(tx, operationKey, claim.owner, now())
                  }),
                { behavior: "immediate" },
              )
              .pipe(
                Effect.mapError((cause) => (cause instanceof IntegrityError ? cause : integrity(sessionID, cause))),
                Effect.tapError((error) => failJournal(db, operationKey, claim.owner, now(), error.message)),
              )
            return {
              sessionID,
              shardID: shard.id,
              revision: catalog.revision,
              logicalBytes: catalog.logical_bytes,
            }
          }),
        ),
      )

    const readMessages: Interface["readMessages"] = Effect.fn("SessionArchive.readMessages")(
      function* (sessionID, page) {
        const catalog = yield* catalogFor(db, sessionID)
        if (!catalog) return yield* new NotFoundError({ sessionID })
        return yield* readMessagePage(root, db, catalog, sessionID, page)
      },
    )

    const readMessage: Interface["readMessage"] = Effect.fn("SessionArchive.readMessage")(
      function* (sessionID, messageID) {
        const catalog = yield* catalogFor(db, sessionID)
        if (!catalog) return yield* new NotFoundError({ sessionID })
        return yield* readSingleMessage(root, db, catalog, sessionID, messageID)
      },
    )

    const readLegacyMessages: Interface["readLegacyMessages"] = Effect.fn("SessionArchive.readLegacyMessages")(
      function* (sessionID, page) {
        const catalog = yield* catalogFor(db, sessionID)
        if (!catalog) return yield* new NotFoundError({ sessionID })
        return yield* readLegacyMessagePage(root, db, catalog, sessionID, page)
      },
    )

    const readLegacyMessage: Interface["readLegacyMessage"] = Effect.fn("SessionArchive.readLegacyMessage")(
      function* (sessionID, messageID) {
        const catalog = yield* catalogFor(db, sessionID)
        if (!catalog) return yield* new NotFoundError({ sessionID })
        return yield* readSingleLegacyMessage(root, db, catalog, sessionID, messageID)
      },
    )

    const resolveMessageTarget: Interface["resolveMessageTarget"] = Effect.fn("SessionArchive.resolveMessageTarget")(
      function* (sessionID, target) {
        const catalog = yield* catalogFor(db, sessionID)
        if (!catalog) return yield* new NotFoundError({ sessionID })
        return yield* readMessageTarget(root, db, catalog, sessionID, target)
      },
    )

    const readAttachment: Interface["readAttachment"] = Effect.fn("SessionArchive.readAttachment")(
      function* (sessionID, attachmentID) {
        const catalog = yield* catalogFor(db, sessionID)
        if (!catalog) return yield* new NotFoundError({ sessionID })
        return yield* readSessionAttachment(root, db, catalog, sessionID, attachmentID)
      },
    )

    const readInputs: Interface["readInputs"] = Effect.fn("SessionArchive.readInputs")(function* (sessionID, page) {
      const catalog = yield* catalogFor(db, sessionID)
      if (!catalog) return yield* new NotFoundError({ sessionID })
      return yield* readInputPage(root, db, catalog, sessionID, page)
    })

    const readEventReplay: Interface["readEventReplay"] = Effect.fn("SessionArchive.readEventReplay")(
      function* (sessionID, page) {
        const catalog = yield* catalogFor(db, sessionID)
        if (!catalog) return yield* new NotFoundError({ sessionID })
        return yield* readReplayPage(root, db, catalog, sessionID, page)
      },
    )

    const ensureActive: Interface["ensureActive"] = (sessionID) =>
      exclusive(
        Effect.gen(function* () {
          const catalog = yield* catalogFor(db, sessionID)
          if (!catalog) return yield* new NotFoundError({ sessionID })
          if (catalog.location === "active") return { sessionID, revision: catalog.revision, reactivated: false }
          if (catalog.location !== "archived")
            return yield* new IntegrityError({
              sessionID,
              message: "Session archive is not available for reactivation",
            })
          if (!catalog.shard_id || !catalog.content_hash)
            return yield* new IntegrityError({ sessionID, message: "Archived catalog entry has no shard or hash" })
          const shard = yield* shardFor(db, catalog.shard_id, sessionID)
          const operationKey = `archive-access:${sessionID}:${catalog.revision}`
          const claim = yield* claimJournal({
            db,
            operationKey,
            sessionID,
            operation: "reactivate",
            revision: catalog.revision,
            shardID: shard.id,
            now,
            leaseMs,
          }).pipe(Effect.mapError((cause) => integrity(sessionID, cause)))
          if (!claim.owned) {
            const current = yield* catalogFor(db, sessionID)
            if (current?.location === "active") return { sessionID, revision: current.revision, reactivated: false }
            return yield* new IntegrityError({
              sessionID,
              message: "Session reactivation is still owned by another worker",
            })
          }
          const reactivated = yield* restoreFromShard({
            central: db,
            root,
            filename: shard.path,
            sessionID,
            catalog,
            operationKey,
            owner: claim.owner,
            timestamp: now(),
          }).pipe(
            Effect.mapError((cause) => (cause instanceof IntegrityError ? cause : integrity(sessionID, cause))),
            Effect.tapError((error) => failJournal(db, operationKey, claim.owner, now(), error.message)),
          )
          return { sessionID, revision: catalog.revision, reactivated }
        }),
      )

    return Service.of({
      initialize,
      refreshCatalog,
      getCatalog,
      listCatalog,
      candidateStats,
      candidates,
      archiveOne,
      purgeCandidates,
      purgeOne,
      readMessages,
      readMessage,
      readLegacyMessages,
      readLegacyMessage,
      resolveMessageTarget,
      readAttachment,
      readInputs,
      readEventReplay,
      ensureActive,
    })
  })
}

export function layer(options: Options) {
  return Layer.effect(Service, make(options))
}

const catalogSchema = [
  `CREATE TABLE IF NOT EXISTS session_archive_shard (
    id TEXT PRIMARY KEY, path TEXT NOT NULL, state TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0, max_bytes INTEGER NOT NULL,
    session_count INTEGER NOT NULL DEFAULT 0, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, time_sealed INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS session_archive_catalog (
    session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
    directory TEXT NOT NULL, session_data TEXT, location TEXT NOT NULL,
    shard_id TEXT REFERENCES session_archive_shard(id), revision INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT, message_count INTEGER NOT NULL DEFAULT 0,
    input_count INTEGER NOT NULL DEFAULT 0, logical_bytes INTEGER NOT NULL DEFAULT 0,
    time_last_modified INTEGER NOT NULL, time_archived INTEGER,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS session_archive_journal (
    id TEXT PRIMARY KEY, operation_key TEXT NOT NULL, session_id TEXT NOT NULL,
    operation TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL,
    shard_id TEXT REFERENCES session_archive_shard(id), content_hash TEXT,
    message_count INTEGER, input_count INTEGER, error TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_completed INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS session_archive_shard_state_idx ON session_archive_shard(state, time_created)",
  "CREATE INDEX IF NOT EXISTS session_archive_catalog_location_time_idx ON session_archive_catalog(location, time_last_modified)",
  "CREATE INDEX IF NOT EXISTS session_archive_catalog_project_idx ON session_archive_catalog(project_id, time_last_modified)",
  "CREATE INDEX IF NOT EXISTS session_archive_catalog_shard_idx ON session_archive_catalog(shard_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS session_archive_journal_operation_idx ON session_archive_journal(operation_key)",
  "CREATE INDEX IF NOT EXISTS session_archive_journal_state_idx ON session_archive_journal(state, time_updated)",
  "CREATE INDEX IF NOT EXISTS session_archive_journal_session_idx ON session_archive_journal(session_id, revision)",
]

const catalogObjects = [
  "session_archive_shard",
  "session_archive_catalog",
  "session_archive_journal",
  "session_archive_shard_state_idx",
  "session_archive_catalog_location_time_idx",
  "session_archive_catalog_project_idx",
  "session_archive_catalog_shard_idx",
  "session_archive_journal_operation_idx",
  "session_archive_journal_state_idx",
  "session_archive_journal_session_idx",
]

const shardSchema = [
  "CREATE TABLE IF NOT EXISTS archive_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS archive_session (
    session_id TEXT NOT NULL, revision INTEGER NOT NULL, format_version INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL, content_hash TEXT NOT NULL, message_count INTEGER NOT NULL,
    input_count INTEGER NOT NULL, logical_bytes INTEGER NOT NULL, time_archived INTEGER NOT NULL,
    PRIMARY KEY(session_id, revision)
  )`,
  `CREATE TABLE IF NOT EXISTS archive_session_section (
    session_id TEXT NOT NULL, revision INTEGER NOT NULL, section_name TEXT NOT NULL,
    ordinal INTEGER NOT NULL, data_json TEXT NOT NULL, row_hash TEXT NOT NULL,
    PRIMARY KEY(session_id, revision, section_name, ordinal),
    FOREIGN KEY(session_id, revision) REFERENCES archive_session(session_id, revision) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS archive_session_message (
    session_id TEXT NOT NULL, revision INTEGER NOT NULL, seq INTEGER NOT NULL,
    id TEXT NOT NULL, data_json TEXT NOT NULL, row_hash TEXT NOT NULL,
    PRIMARY KEY(session_id, revision, seq),
    FOREIGN KEY(session_id, revision) REFERENCES archive_session(session_id, revision) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS archive_session_input (
    session_id TEXT NOT NULL, revision INTEGER NOT NULL, admitted_seq INTEGER NOT NULL,
    id TEXT NOT NULL, data_json TEXT NOT NULL, row_hash TEXT NOT NULL,
    PRIMARY KEY(session_id, revision, admitted_seq),
    FOREIGN KEY(session_id, revision) REFERENCES archive_session(session_id, revision) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS archive_legacy_message (
    session_id TEXT NOT NULL, revision INTEGER NOT NULL, time_created INTEGER NOT NULL,
    id TEXT NOT NULL, data_json TEXT NOT NULL, row_hash TEXT NOT NULL,
    PRIMARY KEY(session_id, revision, id),
    FOREIGN KEY(session_id, revision) REFERENCES archive_session(session_id, revision) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS archive_legacy_part (
    session_id TEXT NOT NULL, revision INTEGER NOT NULL, message_id TEXT NOT NULL,
    id TEXT NOT NULL, data_json TEXT NOT NULL, row_hash TEXT NOT NULL,
    PRIMARY KEY(session_id, revision, id),
    FOREIGN KEY(session_id, revision) REFERENCES archive_session(session_id, revision) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS archive_attachment_ref (
    session_id TEXT NOT NULL, revision INTEGER NOT NULL, attachment_id TEXT NOT NULL,
    blob_sha256 TEXT NOT NULL, PRIMARY KEY(session_id, revision, attachment_id),
    FOREIGN KEY(session_id, revision) REFERENCES archive_session(session_id, revision) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS archive_file_mutation_ref (
    session_id TEXT NOT NULL, revision INTEGER NOT NULL, mutation_id TEXT NOT NULL,
    before_sha256 TEXT, after_sha256 TEXT, row_hash TEXT NOT NULL,
    PRIMARY KEY(session_id, revision, mutation_id),
    FOREIGN KEY(session_id, revision) REFERENCES archive_session(session_id, revision) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS archive_session_message_page_idx ON archive_session_message(session_id, revision, seq DESC)",
  "CREATE INDEX IF NOT EXISTS archive_session_input_page_idx ON archive_session_input(session_id, revision, admitted_seq)",
  "CREATE INDEX IF NOT EXISTS archive_legacy_message_page_idx ON archive_legacy_message(session_id, revision, time_created DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS archive_legacy_part_message_idx ON archive_legacy_part(session_id, revision, message_id, id)",
  "CREATE INDEX IF NOT EXISTS archive_session_section_idx ON archive_session_section(session_id, revision, section_name, ordinal)",
  "CREATE INDEX IF NOT EXISTS archive_attachment_blob_idx ON archive_attachment_ref(blob_sha256)",
  "CREATE INDEX IF NOT EXISTS archive_file_mutation_before_idx ON archive_file_mutation_ref(before_sha256)",
  "CREATE INDEX IF NOT EXISTS archive_file_mutation_after_idx ON archive_file_mutation_ref(after_sha256)",
]

function candidateRows(
  db: QueryDatabase,
  cutoff: number,
  limit: number,
  sessionID?: SessionSchema.ID,
  after?: { readonly id: string; readonly timeUpdated: number },
) {
  // Attachment rows are derived storage records. Prompt, message, and session timestamps own user activity; an
  // offline content migration must not make an otherwise inactive session look newly edited.
  return db
    .all<{ id: string; time_updated: number }>(
      sql`
      SELECT s.id, s.time_updated FROM session s
      WHERE ${candidateFilter(cutoff, sessionID)}
        ${after === undefined ? sql`` : sql`AND (s.time_updated > ${after.timeUpdated} OR (s.time_updated = ${after.timeUpdated} AND s.id > ${after.id}))`}
      ORDER BY s.time_updated, s.id LIMIT ${Math.max(1, Math.min(limit, 1_000))}
    `,
    )
    .pipe(Effect.orDie)
}

function candidateFilter(cutoff: number, sessionID?: SessionSchema.ID) {
  return sql`
    s.time_updated <= ${cutoff}
    ${sessionID === undefined ? sql`` : sql`AND s.id = ${sessionID}`}
    AND NOT EXISTS (SELECT 1 FROM session_protection sp WHERE sp.session_id = s.id)
    -- Orchestrator planning/ownership is not part of the cold-archive format.
    -- Keep both the Main and referenced children active until that format and
    -- execution-owner settlement have an explicit preservation contract.
    AND NOT EXISTS (SELECT 1 FROM session_orchestrator so WHERE so.main_session_id = s.id)
    AND NOT EXISTS (SELECT 1 FROM session_orchestrator_task sot WHERE sot.child_session_id = s.id)
    AND NOT EXISTS (SELECT 1 FROM session_input si WHERE si.session_id = s.id AND (si.time_created > ${cutoff} OR si.promoted_seq IS NULL))
    AND NOT EXISTS (SELECT 1 FROM session_message sm WHERE sm.session_id = s.id AND sm.time_updated > ${cutoff})
    AND NOT EXISTS (SELECT 1 FROM session_activity sa WHERE sa.session_id = s.id AND (sa.time_updated > ${cutoff} OR sa.status IN ('running', 'recovering')))
    AND NOT EXISTS (SELECT 1 FROM session_file_mutation sfm WHERE sfm.session_id = s.id AND sfm.time_created > ${cutoff})
    AND NOT EXISTS (SELECT 1 FROM todo t WHERE t.session_id = s.id AND t.time_updated > ${cutoff})
    AND NOT EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id AND m.time_updated > ${cutoff})
    AND NOT EXISTS (SELECT 1 FROM part p WHERE p.session_id = s.id AND p.time_updated > ${cutoff})
    AND NOT EXISTS (SELECT 1 FROM background_job bj
      WHERE (bj.parent_session_id = s.id OR bj.child_session_id = s.id)
        AND (bj.time_updated > ${cutoff} OR bj.status NOT IN ('completed', 'failed', 'error', 'cancelled', 'canceled', 'interrupted')))
  `
}

function candidatesForSession(db: QueryDatabase, sessionID: SessionSchema.ID, cutoff: number) {
  return candidateRows(db, cutoff, 1, sessionID).pipe(Effect.map((rows) => rows.length === 1))
}

function catalogFor(db: DatabaseShape, sessionID: SessionSchema.ID) {
  return db
    .select()
    .from(SessionArchiveCatalogTable)
    .where(eq(SessionArchiveCatalogTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
}

function catalogSnapshotFor(db: QueryDatabase, sessionID: SessionSchema.ID) {
  return db.get<{
    readonly location: string
    readonly revision: number
    readonly shard_id: string | null
    readonly content_hash: string | null
    readonly time_last_modified: number
  }>(sql`
    SELECT location, revision, shard_id, content_hash, time_last_modified
    FROM session_archive_catalog WHERE session_id = ${sessionID}
  `)
}

function archiveResult(sessionID: SessionSchema.ID, catalog: typeof SessionArchiveCatalogTable.$inferSelect) {
  if (!catalog.shard_id || !catalog.content_hash)
    return Effect.fail(new IntegrityError({ sessionID, message: "Archived catalog entry has no shard or hash" }))
  return Effect.succeed({
    sessionID,
    shardID: catalog.shard_id,
    revision: catalog.revision,
    contentHash: catalog.content_hash,
    logicalBytes: catalog.logical_bytes,
  })
}

function sessionData(row: RawRow & { readonly message_count: number; readonly input_count: number }) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "message_count" && key !== "input_count"))
}

function catalogSearch(search: string | undefined) {
  const value = search?.trim().toLowerCase()
  if (!value) return
  const pattern = `%${value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`
  return sql`(
    lower(title) LIKE ${pattern} ESCAPE '!'
    OR lower(directory) LIKE ${pattern} ESCAPE '!'
    OR lower(session_id) LIKE ${pattern} ESCAPE '!'
    OR lower(COALESCE(json_extract(session_data, '$.path'), '')) LIKE ${pattern} ESCAPE '!'
  )`
}

function catalogAnchorFilter(order: CatalogOrder, anchor: CatalogAnchor | undefined) {
  if (!anchor) return
  if (order === "created-desc")
    return sql`(time_created < ${anchor.timeCreated}
      OR (time_created = ${anchor.timeCreated} AND session_id < ${anchor.sessionID}))`
  if (order === "created-asc")
    return sql`(time_created > ${anchor.timeCreated}
      OR (time_created = ${anchor.timeCreated} AND session_id > ${anchor.sessionID}))`
  if (order === "updated-desc")
    return sql`(time_last_modified < ${anchor.timeLastModified}
      OR (time_last_modified = ${anchor.timeLastModified} AND session_id < ${anchor.sessionID}))`
  if (order === "updated-asc")
    return sql`(time_last_modified > ${anchor.timeLastModified}
      OR (time_last_modified = ${anchor.timeLastModified} AND session_id > ${anchor.sessionID}))`
  if (order === "title-desc")
    return sql`(lower(title) < ${anchor.title.toLowerCase()}
      OR (lower(title) = ${anchor.title.toLowerCase()} AND session_id < ${anchor.sessionID}))`
  return sql`(lower(title) > ${anchor.title.toLowerCase()}
    OR (lower(title) = ${anchor.title.toLowerCase()} AND session_id > ${anchor.sessionID}))`
}

function catalogOrder(order: CatalogOrder) {
  if (order === "created-asc") return sql`time_created ASC, session_id ASC`
  if (order === "created-desc") return sql`time_created DESC, session_id DESC`
  if (order === "updated-asc") return sql`time_last_modified ASC, session_id ASC`
  if (order === "title-asc") return sql`lower(title) ASC, session_id ASC`
  if (order === "title-desc") return sql`lower(title) DESC, session_id DESC`
  return sql`time_last_modified DESC, session_id DESC`
}

function decodeCatalogRow(row: RawCatalogRow): CatalogRow {
  return {
    ...row,
    session_data: row.session_data === null ? null : (JSON.parse(row.session_data) as Record<string, unknown>),
  }
}

function fromCatalogRow(row: typeof SessionArchiveCatalogTable.$inferSelect): CatalogEntry {
  return {
    sessionID: SessionSchema.ID.make(row.session_id),
    projectID: row.project_id,
    title: row.title,
    directory: row.directory,
    ...(row.session_data === null ? {} : { sessionData: row.session_data }),
    location: row.location,
    ...(row.shard_id === null ? {} : { shardID: row.shard_id }),
    revision: row.revision,
    ...(row.content_hash === null ? {} : { contentHash: row.content_hash }),
    messageCount: row.message_count,
    inputCount: row.input_count,
    logicalBytes: row.logical_bytes,
    timeCreated: row.time_created,
    timeLastModified: row.time_last_modified,
    ...(row.time_archived === null ? {} : { timeArchived: row.time_archived }),
  }
}

function scanActive(db: QueryDatabase, sessionID: SessionSchema.ID, visitor: Visitor = {}) {
  return Effect.gen(function* () {
    const session = yield* db.get<RawRow>(sql`SELECT * FROM session WHERE id = ${sessionID}`).pipe(Effect.orDie)
    if (!session) return
    const digest = snapshotDigest()
    const sessionJSON = JSON.stringify(session)
    digest.add("session", sessionJSON)
    yield* visitor.session?.(session, sessionJSON) ?? Effect.void

    for (const section of sections) {
      let offset = 0
      let ordinal = 0
      while (true) {
        const rows = yield* sectionBatch(db, section, sessionID, offset)
        if (rows.length === 0) break
        for (const row of rows) {
          const data = JSON.stringify(row)
          digest.add(`section:${section.name}`, data)
          yield* visitor.section?.(section.name, ordinal, row, data) ?? Effect.void
          ordinal += 1
        }
        offset += rows.length
        yield* visitor.batch?.() ?? Effect.void
      }
    }

    let messageAfter = -1
    let messageCount = 0
    while (true) {
      const rows = yield* db
        .all<RawRow>(
          sql`
          SELECT * FROM session_message WHERE session_id = ${sessionID} AND seq > ${messageAfter}
          ORDER BY seq, id LIMIT ${PAGE_SIZE}
        `,
        )
        .pipe(Effect.orDie)
      if (rows.length === 0) break
      for (const row of rows) {
        const data = JSON.stringify(row)
        digest.add("message", data)
        yield* visitor.message?.(row, data) ?? Effect.void
        messageAfter = Number(row.seq)
        messageCount += 1
      }
      yield* visitor.batch?.() ?? Effect.void
    }

    let inputAfter = -1
    let inputCount = 0
    while (true) {
      const rows = yield* db
        .all<RawRow>(
          sql`
          SELECT * FROM session_input WHERE session_id = ${sessionID} AND admitted_seq > ${inputAfter}
          ORDER BY admitted_seq, id LIMIT ${PAGE_SIZE}
        `,
        )
        .pipe(Effect.orDie)
      if (rows.length === 0) break
      for (const row of rows) {
        const data = JSON.stringify(row)
        digest.add("input", data)
        yield* visitor.input?.(row, data) ?? Effect.void
        inputAfter = Number(row.admitted_seq)
        inputCount += 1
      }
      yield* visitor.batch?.() ?? Effect.void
    }

    let legacyMessageOffset = 0
    while (true) {
      const rows = yield* db
        .all<RawRow>(
          sql`
          SELECT * FROM message WHERE session_id = ${sessionID}
          ORDER BY time_created, id LIMIT ${PAGE_SIZE} OFFSET ${legacyMessageOffset}
        `,
        )
        .pipe(Effect.orDie)
      if (rows.length === 0) break
      for (const row of rows) {
        const data = JSON.stringify(row)
        digest.add("legacy-message", data)
        yield* visitor.legacyMessage?.(row, data) ?? Effect.void
      }
      legacyMessageOffset += rows.length
      yield* visitor.batch?.() ?? Effect.void
    }

    let legacyPartOffset = 0
    while (true) {
      const rows = yield* db
        .all<RawRow>(
          sql`
          SELECT * FROM part WHERE session_id = ${sessionID}
          ORDER BY message_id, id LIMIT ${PAGE_SIZE} OFFSET ${legacyPartOffset}
        `,
        )
        .pipe(Effect.orDie)
      if (rows.length === 0) break
      for (const row of rows) {
        const data = JSON.stringify(row)
        digest.add("legacy-part", data)
        yield* visitor.legacyPart?.(row, data) ?? Effect.void
      }
      legacyPartOffset += rows.length
      yield* visitor.batch?.() ?? Effect.void
    }
    return { session, ...digest.finish(), messageCount, inputCount } satisfies Summary
  })
}

function sectionBatch(
  db: QueryDatabase,
  section: (typeof sections)[number],
  sessionID: SessionSchema.ID,
  offset: number,
) {
  if (section.name === "event")
    return db
      .all<RawRow>(
        sql`
        SELECT * FROM event WHERE aggregate_id = ${sessionID}
          AND seq > COALESCE((SELECT seq FROM event_checkpoint WHERE aggregate_id = ${sessionID}), -1)
        ORDER BY seq LIMIT ${PAGE_SIZE} OFFSET ${offset}
      `,
      )
      .pipe(Effect.orDie)
  return db
    .all<RawRow>(
      sql`
      SELECT * FROM ${sql.identifier(section.name)} WHERE ${sql.identifier(section.column)} = ${sessionID}
      ORDER BY ${sql.join(
        section.order.map((column) => sql.identifier(column)),
        sql`, `,
      )}
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `,
    )
    .pipe(Effect.orDie)
}

function snapshotDigest() {
  const hash = createHash("sha256")
  let bytes = 0
  const add = (kind: string, value: string) => {
    const prefix = `${kind}:${Buffer.byteLength(value)}:`
    hash.update(prefix)
    hash.update(value)
    bytes += Buffer.byteLength(prefix) + Buffer.byteLength(value)
  }
  return { add, finish: () => ({ hash: hash.digest("hex"), bytes }) }
}

function copyActiveToShard(input: {
  readonly active: QueryDatabase
  readonly root: string
  readonly filename: string
  readonly sessionID: SessionSchema.ID
  readonly revision: number
  readonly timestamp: number
  readonly heartbeat: () => Effect.Effect<void>
}) {
  return withShardWrite(input.root, input.filename, (shard) =>
    Effect.gen(function* () {
      const legacyProjection = yield* legacyProjectionElision(input.active, input.sessionID)
      const summary = yield* shard.transaction((tx) => {
        return scanActive(input.active, input.sessionID, {
          session: (row) =>
            Effect.gen(function* () {
              yield* tx.run(sql`
                INSERT INTO archive_session(session_id, revision, format_version, snapshot_json, content_hash,
                  message_count, input_count, logical_bytes, time_archived)
                VALUES (${input.sessionID}, ${input.revision}, ${SNAPSHOT_FORMAT_VERSION},
                  ${JSON.stringify({ formatVersion: SNAPSHOT_FORMAT_VERSION, session: row })}, '', 0, 0, 0, ${input.timestamp})
                ON CONFLICT(session_id, revision) DO UPDATE SET
                  format_version = excluded.format_version, snapshot_json = excluded.snapshot_json,
                  content_hash = '', message_count = 0, input_count = 0, logical_bytes = 0,
                  time_archived = excluded.time_archived
              `)
              yield* tx.run(
                sql`DELETE FROM archive_session_section WHERE session_id = ${input.sessionID} AND revision = ${input.revision}`,
              )
              yield* tx.run(
                sql`DELETE FROM archive_session_message WHERE session_id = ${input.sessionID} AND revision = ${input.revision}`,
              )
              yield* tx.run(
                sql`DELETE FROM archive_session_input WHERE session_id = ${input.sessionID} AND revision = ${input.revision}`,
              )
              yield* tx.run(
                sql`DELETE FROM archive_legacy_part WHERE session_id = ${input.sessionID} AND revision = ${input.revision}`,
              )
              yield* tx.run(
                sql`DELETE FROM archive_legacy_message WHERE session_id = ${input.sessionID} AND revision = ${input.revision}`,
              )
              yield* tx.run(
                sql`DELETE FROM archive_attachment_ref WHERE session_id = ${input.sessionID} AND revision = ${input.revision}`,
              )
              yield* tx.run(
                sql`DELETE FROM archive_file_mutation_ref WHERE session_id = ${input.sessionID} AND revision = ${input.revision}`,
              )
              if (legacyProjection) {
                const data = JSON.stringify(legacyProjection.marker)
                yield* tx.run(sql`
                  INSERT INTO archive_session_section(session_id, revision, section_name, ordinal, data_json, row_hash)
                  VALUES (
                    ${input.sessionID}, ${input.revision}, ${LEGACY_PROJECTION_MARKER}, 0,
                    ${data}, ${Hash.sha256(data)}
                  )
                `)
              }
            }).pipe(Effect.orDie),
          section: (name, ordinal, row, data) =>
            Effect.gen(function* () {
              const archived =
                name === "event_checkpoint" && legacyProjection
                  ? yield* attempt(input.sessionID, () => {
                      const normalized = normalizeArchivedCheckpointRow(row, input.sessionID)
                      return { row: normalized, data: JSON.stringify(normalized) }
                    })
                  : { row, data }
              yield* tx.run(sql`
                INSERT INTO archive_session_section(session_id, revision, section_name, ordinal, data_json, row_hash)
                VALUES (
                  ${input.sessionID}, ${input.revision}, ${name}, ${ordinal},
                  ${archived.data}, ${Hash.sha256(archived.data)}
                )
              `)
              if (
                name === "attachment" &&
                typeof archived.row.id === "string" &&
                typeof archived.row.blob_sha256 === "string"
              )
                yield* tx.run(sql`
                  INSERT INTO archive_attachment_ref(session_id, revision, attachment_id, blob_sha256)
                  VALUES (${input.sessionID}, ${input.revision}, ${archived.row.id}, ${archived.row.blob_sha256})
                `)
              if (name === "session_file_mutation") {
                const reference = mutationReference(archived.row, archived.data)
                yield* tx.run(sql`
                  INSERT INTO archive_file_mutation_ref(
                    session_id, revision, mutation_id, before_sha256, after_sha256, row_hash
                  ) VALUES (
                    ${input.sessionID}, ${input.revision}, ${reference.mutationID},
                    ${reference.beforeSha256}, ${reference.afterSha256}, ${reference.rowHash}
                  )
                `)
              }
            }).pipe(Effect.orDie),
          message: (row, data) =>
            tx
              .run(
                sql`
                INSERT INTO archive_session_message(session_id, revision, seq, id, data_json, row_hash)
                VALUES (${input.sessionID}, ${input.revision}, ${Number(row.seq)}, ${String(row.id)}, ${data}, ${Hash.sha256(data)})
              `,
              )
              .pipe(Effect.orDie, Effect.asVoid),
          input: (row, data) =>
            tx
              .run(
                sql`
                INSERT INTO archive_session_input(session_id, revision, admitted_seq, id, data_json, row_hash)
                VALUES (${input.sessionID}, ${input.revision}, ${Number(row.admitted_seq)}, ${String(row.id)}, ${data}, ${Hash.sha256(data)})
              `,
              )
              .pipe(Effect.orDie, Effect.asVoid),
          legacyMessage: (row, data) =>
            tx
              .run(
                sql`
                INSERT INTO archive_legacy_message(session_id, revision, time_created, id, data_json, row_hash)
                VALUES (${input.sessionID}, ${input.revision}, ${Number(row.time_created)}, ${String(row.id)}, ${data}, ${Hash.sha256(data)})
              `,
              )
              .pipe(Effect.orDie, Effect.asVoid),
          legacyPart: (row, data) =>
            tx
              .run(
                sql`
                INSERT INTO archive_legacy_part(session_id, revision, message_id, id, data_json, row_hash)
                VALUES (${input.sessionID}, ${input.revision}, ${String(row.message_id)}, ${String(row.id)}, ${data}, ${Hash.sha256(data)})
              `,
              )
              .pipe(Effect.orDie, Effect.asVoid),
          batch: input.heartbeat,
        }).pipe(
          Effect.tap((result) =>
            result
              ? tx
                  .run(
                    sql`
                    UPDATE archive_session SET content_hash = ${result.hash}, message_count = ${result.messageCount},
                      input_count = ${result.inputCount}, logical_bytes = ${result.bytes}
                    WHERE session_id = ${input.sessionID} AND revision = ${input.revision}
                  `,
                  )
                  .pipe(Effect.orDie)
              : Effect.die("Active session disappeared during archive copy"),
          ),
        )
      })
      yield* shard.run("PRAGMA wal_checkpoint(TRUNCATE)")
      if (!summary) return yield* Effect.die("Active session disappeared during archive copy")
      if (legacyProjection) {
        const archived = yield* archivedLegacyProjection(shard, input.sessionID, input.revision)
        const current = yield* legacyProjectionElision(input.active, input.sessionID)
        if (
          !archived ||
          !current ||
          legacyProjectionHash(archived) !== legacyProjection.marker.projectionHash ||
          current.marker.projectionHash !== legacyProjection.marker.projectionHash
        )
          return yield* new IntegrityError({
            sessionID: input.sessionID,
            message: "Archived legacy checkpoint projection failed copy validation",
          })
      }
      return summary
    }),
  )
}

function restoreFromShard(input: {
  readonly central: DatabaseShape
  readonly root: string
  readonly filename: string
  readonly sessionID: SessionSchema.ID
  readonly catalog: typeof SessionArchiveCatalogTable.$inferSelect
  readonly operationKey: string
  readonly owner: string
  readonly timestamp: number
}) {
  return withShardRead(input.root, input.filename, (shard) =>
    input.central.transaction(
      (tx) =>
        Effect.gen(function* () {
          yield* requireJournalOwner(tx, input.operationKey, input.owner, input.sessionID)
          const current = yield* catalogSnapshotFor(tx, input.sessionID)
          if (
            !current ||
            current.location !== "archived" ||
            current.revision !== input.catalog.revision ||
            current.shard_id !== input.catalog.shard_id ||
            current.content_hash !== input.catalog.content_hash
          )
            return yield* new IntegrityError({
              sessionID: input.sessionID,
              message: "Archive catalog changed before reactivation",
            })
          const archived = yield* archiveHeader(shard, input.sessionID, input.catalog.revision)
          yield* attempt(input.sessionID, () => validateArchiveHeader(archived, input.catalog, input.sessionID))
          const envelope = yield* attempt(input.sessionID, () => decodeEnvelope(archived.snapshot_json))
          yield* insertRow(tx, "session", envelope.session)
          const digest = snapshotDigest()
          const sessionJSON = JSON.stringify(envelope.session)
          digest.add("session", sessionJSON)
          const mutationReferences = yield* readMutationReferences(shard, input.sessionID, input.catalog.revision)
          const restoredMutationReferences = new Set<string>()
          const legacyProjection = yield* archivedLegacyProjection(shard, input.sessionID, input.catalog.revision)

          for (const section of sections) {
            let ordinal = 0
            while (true) {
              const rows = yield* shard.all<{ data_json: string; row_hash: string }>(sql`
                SELECT data_json, row_hash FROM archive_session_section
                WHERE session_id = ${input.sessionID} AND revision = ${input.catalog.revision}
                  AND section_name = ${section.name} AND ordinal >= ${ordinal}
                ORDER BY ordinal LIMIT ${PAGE_SIZE}
              `)
              if (rows.length === 0) break
              for (const row of rows) {
                yield* attempt(input.sessionID, () => validateRow(row))
                const stored = yield* attempt(input.sessionID, () => decodeRowSync(row.data_json))
                const decoded =
                  section.name === "event_checkpoint" && legacyProjection
                    ? yield* attempt(input.sessionID, () =>
                        hydrateArchivedCheckpointRow(stored, legacyProjection, input.sessionID),
                      )
                    : stored
                const data =
                  section.name === "event_checkpoint" && legacyProjection ? JSON.stringify(decoded) : row.data_json
                digest.add(`section:${section.name}`, data)
                if (section.name === "session_file_mutation" && mutationReferences) {
                  const reference = yield* attempt(input.sessionID, () => mutationReference(decoded, data))
                  const stored = mutationReferences.get(reference.mutationID)
                  if (!stored || !sameMutationReference(reference, stored))
                    return yield* new IntegrityError({
                      sessionID: input.sessionID,
                      message: `Archived file mutation ${reference.mutationID} has inconsistent blob references`,
                    })
                  restoredMutationReferences.add(reference.mutationID)
                }
                yield* insertRow(tx, section.name, decoded)
                ordinal += 1
              }
            }
          }
          if (mutationReferences && restoredMutationReferences.size !== mutationReferences.size)
            return yield* new IntegrityError({
              sessionID: input.sessionID,
              message: "Archived file mutation references do not match the session snapshot",
            })

          let messageAfter = -1
          let messageCount = 0
          while (true) {
            const rows = yield* shard.all<{ seq: number; data_json: string; row_hash: string }>(sql`
              SELECT seq, data_json, row_hash FROM archive_session_message
              WHERE session_id = ${input.sessionID} AND revision = ${input.catalog.revision} AND seq > ${messageAfter}
              ORDER BY seq LIMIT ${PAGE_SIZE}
            `)
            if (rows.length === 0) break
            for (const row of rows) {
              yield* attempt(input.sessionID, () => validateRow(row))
              digest.add("message", row.data_json)
              yield* insertRow(
                tx,
                "session_message",
                yield* attempt(input.sessionID, () => decodeRowSync(row.data_json)),
              )
              messageAfter = row.seq
              messageCount += 1
            }
          }

          let inputAfter = -1
          let inputCount = 0
          while (true) {
            const rows = yield* shard.all<{ admitted_seq: number; data_json: string; row_hash: string }>(sql`
              SELECT admitted_seq, data_json, row_hash FROM archive_session_input
              WHERE session_id = ${input.sessionID} AND revision = ${input.catalog.revision} AND admitted_seq > ${inputAfter}
              ORDER BY admitted_seq LIMIT ${PAGE_SIZE}
            `)
            if (rows.length === 0) break
            for (const row of rows) {
              yield* attempt(input.sessionID, () => validateRow(row))
              digest.add("input", row.data_json)
              yield* insertRow(tx, "session_input", yield* attempt(input.sessionID, () => decodeRowSync(row.data_json)))
              inputAfter = row.admitted_seq
              inputCount += 1
            }
          }

          if (legacyProjection) {
            for (const row of legacyProjection.messages) {
              const data = JSON.stringify(row)
              digest.add("legacy-message", data)
              yield* insertRow(tx, "message", row)
            }
            for (const row of legacyProjection.parts) {
              const data = JSON.stringify(row)
              digest.add("legacy-part", data)
              yield* insertRow(tx, "part", row)
            }
          }
          if (!legacyProjection) {
            let legacyMessageOffset = 0
            while (true) {
              const rows = yield* shard.all<{ data_json: string; row_hash: string }>(sql`
                SELECT data_json, row_hash FROM archive_legacy_message
                WHERE session_id = ${input.sessionID} AND revision = ${input.catalog.revision}
                ORDER BY time_created, id LIMIT ${PAGE_SIZE} OFFSET ${legacyMessageOffset}
              `)
              if (rows.length === 0) break
              for (const row of rows) {
                yield* attempt(input.sessionID, () => validateRow(row))
                digest.add("legacy-message", row.data_json)
                yield* insertRow(tx, "message", yield* attempt(input.sessionID, () => decodeRowSync(row.data_json)))
              }
              legacyMessageOffset += rows.length
            }

            let legacyPartOffset = 0
            while (true) {
              const rows = yield* shard.all<{ data_json: string; row_hash: string }>(sql`
                SELECT data_json, row_hash FROM archive_legacy_part
                WHERE session_id = ${input.sessionID} AND revision = ${input.catalog.revision}
                ORDER BY message_id, id LIMIT ${PAGE_SIZE} OFFSET ${legacyPartOffset}
              `)
              if (rows.length === 0) break
              for (const row of rows) {
                yield* attempt(input.sessionID, () => validateRow(row))
                digest.add("legacy-part", row.data_json)
                yield* insertRow(tx, "part", yield* attempt(input.sessionID, () => decodeRowSync(row.data_json)))
              }
              legacyPartOffset += rows.length
            }
          }
          const restored = digest.finish()
          if (
            restored.hash !== archived.content_hash ||
            restored.hash !== input.catalog.content_hash ||
            messageCount !== archived.message_count ||
            inputCount !== archived.input_count
          )
            return yield* new IntegrityError({
              sessionID: input.sessionID,
              message: "Archived session failed restore validation",
            })
          const active = yield* scanActive(tx, input.sessionID)
          if (!active || active.hash !== restored.hash)
            return yield* new IntegrityError({
              sessionID: input.sessionID,
              message: "Reactivated session failed hash validation",
            })
          yield* tx
            .update(SessionArchiveCatalogTable)
            .set({
              location: "active",
              session_data: active.session,
              shard_id: null,
              time_archived: null,
              time_last_modified: Number(active.session.time_updated),
              time_updated: input.timestamp,
            })
            .where(eq(SessionArchiveCatalogTable.session_id, input.sessionID))
            .run()
          if (input.catalog.shard_id)
            yield* tx.run(sql`
              UPDATE session_archive_shard
              SET session_count = MAX(0, session_count - 1), time_updated = ${input.timestamp}
              WHERE id = ${input.catalog.shard_id}
            `)
          yield* completeJournal(tx, input.operationKey, input.owner, input.timestamp)
          return true
        }),
      { behavior: "immediate" },
    ),
  )
}

function archiveHeader(db: QueryDatabase, sessionID: SessionSchema.ID, revision: number) {
  return db
    .get<{
      format_version: number
      snapshot_json: string
      content_hash: string
      message_count: number
      input_count: number
    }>(
      sql`
      SELECT format_version, snapshot_json, content_hash, message_count, input_count
      FROM archive_session WHERE session_id = ${sessionID} AND revision = ${revision}
    `,
    )
    .pipe(Effect.flatMap((row) => (row ? Effect.succeed(row) : Effect.fail(new Error("Archived session is missing")))))
}

function validateArchiveHeader(
  row: {
    readonly format_version: number
    readonly content_hash: string
    readonly message_count: number
    readonly input_count: number
  },
  catalog: typeof SessionArchiveCatalogTable.$inferSelect,
  sessionID: SessionSchema.ID,
) {
  if (
    row.format_version !== SNAPSHOT_FORMAT_VERSION ||
    row.content_hash !== catalog.content_hash ||
    row.message_count !== catalog.message_count ||
    row.input_count !== catalog.input_count
  )
    throw new IntegrityError({ sessionID, message: "Archive header does not match its catalog" })
}

function readMessagePage(
  root: string,
  central: DatabaseShape,
  catalog: CatalogRow,
  sessionID: SessionSchema.ID,
  options: MessagePageOptions = {},
) {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200))
  return withSessionReader(root, central, catalog, sessionID, (db, archived) =>
    Effect.gen(function* () {
      const anchor = options.cursor
        ? yield* messageSequence(db, archived, sessionID, catalog.revision, options.cursor.messageID)
        : undefined
      if (options.cursor && anchor === undefined)
        return yield* new NotFoundError({ sessionID, itemID: options.cursor.messageID })
      const rows = yield* messageRows(
        db,
        archived,
        sessionID,
        catalog.revision,
        options.order ?? "desc",
        options.cursor?.direction ?? "next",
        anchor,
        limit,
      )
      const bounds = yield* messageBounds(db, archived, sessionID, catalog.revision)
      if (archived && bounds.count !== catalog.message_count)
        return yield* new IntegrityError({ sessionID, message: "Archived message count does not match its catalog" })
      return pageResult(rows, bounds, options.order ?? "desc", anchor)
    }),
  )
}

function readSingleMessage(
  root: string,
  central: DatabaseShape,
  catalog: CatalogRow,
  sessionID: SessionSchema.ID,
  messageID: string,
) {
  return withSessionReader(root, central, catalog, sessionID, (db, archived) =>
    Effect.gen(function* () {
      const row = archived
        ? yield* db
            .get<{ data_json: string; row_hash: string }>(
              sql`
              SELECT data_json, row_hash FROM archive_session_message
              WHERE session_id = ${sessionID} AND revision = ${catalog.revision} AND id = ${messageID}
            `,
            )
            .pipe(Effect.orDie)
        : yield* db
            .get<RawRow>(
              sql`
              SELECT * FROM session_message WHERE session_id = ${sessionID} AND id = ${messageID}
            `,
            )
            .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ sessionID, itemID: messageID })
      if (!archived) return row as RawRow
      return yield* decodeStoredRow(sessionID, row as { data_json: string; row_hash: string })
    }),
  )
}

function readLegacyMessagePage(
  root: string,
  central: DatabaseShape,
  catalog: CatalogRow,
  sessionID: SessionSchema.ID,
  options: { readonly before?: { readonly id: string; readonly time: number }; readonly limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200))
  return withSessionReader(root, central, catalog, sessionID, (db, archived) =>
    Effect.gen(function* () {
      const boundary = options.before
        ? sql`AND (time_created < ${options.before.time}
            OR (time_created = ${options.before.time} AND id < ${options.before.id}))`
        : sql``
      const stored = archived
        ? yield* db
            .all<{ data_json: string; row_hash: string }>(
              sql`
              SELECT data_json, row_hash FROM archive_legacy_message
              WHERE session_id = ${sessionID} AND revision = ${catalog.revision} ${boundary}
              ORDER BY time_created DESC, id DESC LIMIT ${limit + 1}
            `,
            )
            .pipe(Effect.orDie)
        : yield* db
            .all<RawRow>(
              sql`
              SELECT * FROM message WHERE session_id = ${sessionID} ${boundary}
              ORDER BY time_created DESC, id DESC LIMIT ${limit + 1}
            `,
            )
            .pipe(Effect.orDie)
      const messages = archived
        ? yield* decodeStoredRows(sessionID, stored as ReadonlyArray<{ data_json: string; row_hash: string }>)
        : (stored as ReadonlyArray<RawRow>)
      const slice = messages.slice(0, limit)
      const ids = slice.map((row) => String(row.id))
      const partRows =
        ids.length === 0
          ? []
          : archived
            ? yield* db
                .all<{ data_json: string; row_hash: string }>(
                  sql`
                SELECT data_json, row_hash FROM archive_legacy_part
                WHERE session_id = ${sessionID} AND revision = ${catalog.revision}
                  AND message_id IN (${sql.join(
                    ids.map((id) => sql`${id}`),
                    sql`, `,
                  )})
                ORDER BY message_id, id
              `,
                )
                .pipe(
                  Effect.orDie,
                  Effect.flatMap((rows) => decodeStoredRows(sessionID, rows)),
                )
            : yield* db
                .all<RawRow>(
                  sql`
                SELECT * FROM part WHERE session_id = ${sessionID}
                  AND message_id IN (${sql.join(
                    ids.map((id) => sql`${id}`),
                    sql`, `,
                  )})
                ORDER BY message_id, id
              `,
                )
                .pipe(Effect.orDie)
      const grouped = Map.groupBy(partRows, (row) => String(row.message_id))
      const tail = slice.at(-1)
      return {
        items: slice.map((message) => ({ message, parts: grouped.get(String(message.id)) ?? [] })),
        more: messages.length > limit,
        ...(messages.length > limit && tail
          ? { cursor: { id: String(tail.id), time: Number(tail.time_created) } }
          : {}),
      }
    }),
  )
}

function readSingleLegacyMessage(
  root: string,
  central: DatabaseShape,
  catalog: CatalogRow,
  sessionID: SessionSchema.ID,
  messageID: string,
) {
  return withSessionReader(root, central, catalog, sessionID, (db, archived) =>
    Effect.gen(function* () {
      const stored = archived
        ? yield* db
            .get<{ data_json: string; row_hash: string }>(
              sql`
              SELECT data_json, row_hash FROM archive_legacy_message
              WHERE session_id = ${sessionID} AND revision = ${catalog.revision} AND id = ${messageID}
            `,
            )
            .pipe(Effect.orDie)
        : yield* db
            .get<RawRow>(sql`SELECT * FROM message WHERE session_id = ${sessionID} AND id = ${messageID}`)
            .pipe(Effect.orDie)
      if (!stored) return yield* new NotFoundError({ sessionID, itemID: messageID })
      const message = archived
        ? yield* decodeStoredRow(sessionID, stored as { data_json: string; row_hash: string })
        : (stored as RawRow)
      const parts = archived
        ? yield* db
            .all<{ data_json: string; row_hash: string }>(
              sql`
              SELECT data_json, row_hash FROM archive_legacy_part
              WHERE session_id = ${sessionID} AND revision = ${catalog.revision} AND message_id = ${messageID}
              ORDER BY id
            `,
            )
            .pipe(
              Effect.orDie,
              Effect.flatMap((rows) => decodeStoredRows(sessionID, rows)),
            )
        : yield* db
            .all<RawRow>(
              sql`
              SELECT * FROM part WHERE session_id = ${sessionID} AND message_id = ${messageID} ORDER BY id
            `,
            )
            .pipe(Effect.orDie)
      return { message, parts }
    }),
  )
}

function readMessageTarget(
  root: string,
  central: DatabaseShape,
  catalog: CatalogRow,
  sessionID: SessionSchema.ID,
  target: {
    readonly messageID: string
    readonly before?: number
    readonly after?: number
    readonly order?: MessageOrder
  },
) {
  const before = Math.max(0, Math.min(target.before ?? 25, 100))
  const after = Math.max(0, Math.min(target.after ?? 25, 100))
  return withSessionReader(root, central, catalog, sessionID, (db, archived) =>
    Effect.gen(function* () {
      const seq = yield* messageSequence(db, archived, sessionID, catalog.revision, target.messageID)
      if (seq === undefined) return yield* new NotFoundError({ sessionID, itemID: target.messageID })
      const [previous, selected, next, bounds] = yield* Effect.all([
        messageRows(db, archived, sessionID, catalog.revision, target.order ?? "desc", "previous", seq, before),
        singleMessageRow(db, archived, sessionID, catalog.revision, target.messageID),
        messageRows(db, archived, sessionID, catalog.revision, target.order ?? "desc", "next", seq, after),
        messageBounds(db, archived, sessionID, catalog.revision),
      ])
      if (!selected) return yield* new NotFoundError({ sessionID, itemID: target.messageID })
      if (archived && bounds.count !== catalog.message_count)
        return yield* new IntegrityError({ sessionID, message: "Archived message count does not match its catalog" })
      const page = pageResult([...previous, selected, ...next], bounds, target.order ?? "desc", seq)
      return {
        ...page,
        targetID: target.messageID,
        targetIndex: page.rows.findIndex((row) => row.id === target.messageID),
      }
    }),
  )
}

function readSessionAttachment(
  root: string,
  central: DatabaseShape,
  catalog: CatalogRow,
  sessionID: SessionSchema.ID,
  attachmentID: string,
) {
  return withSessionReader(root, central, catalog, sessionID, (db, archived) =>
    Effect.gen(function* () {
      const metadata = archived
        ? yield* db
            .get<{ data_json: string; row_hash: string }>(
              sql`
              SELECT data_json, row_hash FROM archive_session_section
              WHERE session_id = ${sessionID} AND revision = ${catalog.revision}
                AND section_name = 'attachment' AND json_extract(data_json, '$.id') = ${attachmentID}
            `,
            )
            .pipe(Effect.orDie)
        : yield* db
            .get<RawRow>(sql`SELECT * FROM attachment WHERE session_id = ${sessionID} AND id = ${attachmentID}`)
            .pipe(Effect.orDie)
      if (!metadata) return yield* new NotFoundError({ sessionID, itemID: attachmentID })
      const row = archived
        ? yield* decodeStoredRow(sessionID, metadata as { data_json: string; row_hash: string })
        : (metadata as RawRow)
      const archivedRef = archived
        ? yield* db
            .get<{ blob_sha256: string }>(
              sql`
              SELECT blob_sha256 FROM archive_attachment_ref
              WHERE session_id = ${sessionID} AND revision = ${catalog.revision} AND attachment_id = ${attachmentID}
            `,
            )
            .pipe(Effect.orDie)
        : undefined
      const blobSha256 = archivedRef?.blob_sha256 ?? row.blob_sha256
      if (
        typeof blobSha256 !== "string" ||
        !SHA256.test(blobSha256) ||
        (archivedRef && row.blob_sha256 !== archivedRef.blob_sha256)
      )
        return yield* new IntegrityError({
          sessionID,
          message: `Attachment ${attachmentID} has no valid blob reference`,
        })
      return { attachmentID, blobSha256, metadata: row }
    }),
  )
}

function readInputPage(
  root: string,
  central: DatabaseShape,
  catalog: CatalogRow,
  sessionID: SessionSchema.ID,
  options: InputPageOptions = {},
) {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200))
  return withSessionReader(root, central, catalog, sessionID, (db, archived) =>
    Effect.gen(function* () {
      const anchor = options.cursor
        ? yield* inputSequence(db, archived, sessionID, catalog.revision, options.cursor.inputID)
        : undefined
      if (options.cursor && anchor === undefined)
        return yield* new NotFoundError({ sessionID, itemID: options.cursor.inputID })
      const rows = yield* inputRows(
        db,
        archived,
        sessionID,
        catalog.revision,
        options.order ?? "desc",
        options.cursor?.direction ?? "next",
        anchor,
        limit,
      )
      const bounds = yield* inputBounds(db, archived, sessionID, catalog.revision)
      if (archived && bounds.count !== catalog.input_count)
        return yield* new IntegrityError({ sessionID, message: "Archived input count does not match its catalog" })
      return pageResult(rows, bounds, options.order ?? "desc", anchor, "admitted_seq")
    }),
  )
}

function readReplayPage(
  root: string,
  central: DatabaseShape,
  catalog: CatalogRow,
  sessionID: SessionSchema.ID,
  options: { readonly afterSeq?: number; readonly limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500))
  const read = (db: QueryDatabase, archived: boolean, active?: ActiveReadDatabase) =>
    Effect.gen(function* () {
      const sequence = yield* eventSectionRow(db, archived, sessionID, catalog.revision, "event_sequence")
      const storedCheckpoint = yield* eventSectionRow(db, archived, sessionID, catalog.revision, "event_checkpoint")
      const legacyProjection = archived ? yield* archivedLegacyProjection(db, sessionID, catalog.revision) : undefined
      const checkpoint =
        storedCheckpoint && legacyProjection
          ? yield* attempt(sessionID, () => hydrateArchivedCheckpointRow(storedCheckpoint, legacyProjection, sessionID))
          : storedCheckpoint && !archived && Number(storedCheckpoint.version) === EventV2.CheckpointVersion
            ? {
                ...storedCheckpoint,
                data: JSON.stringify(
                  yield* SessionProjector.hydrateActiveCheckpointData(
                    active!,
                    sessionID,
                    Number(storedCheckpoint.seq),
                    parseCheckpointData(storedCheckpoint.data),
                  ),
                ),
              }
            : storedCheckpoint
      const checkpointSeq = checkpoint ? Number(checkpoint.seq) : -1
      const after = Math.max(checkpointSeq, options.afterSeq ?? checkpointSeq)
      const rows = archived
        ? yield* db
            .all<{ data_json: string; row_hash: string }>(
              sql`
              SELECT data_json, row_hash FROM archive_session_section
              WHERE session_id = ${sessionID} AND revision = ${catalog.revision} AND section_name = 'event'
                AND CAST(json_extract(data_json, '$.seq') AS INTEGER) > ${after}
              ORDER BY CAST(json_extract(data_json, '$.seq') AS INTEGER) LIMIT ${limit + 1}
            `,
            )
            .pipe(
              Effect.orDie,
              Effect.flatMap((stored) => decodeStoredRows(sessionID, stored)),
            )
        : yield* db
            .all<RawRow>(
              sql`
              SELECT * FROM event WHERE aggregate_id = ${sessionID} AND seq > ${after}
                AND seq > COALESCE((SELECT seq FROM event_checkpoint WHERE aggregate_id = ${sessionID}), -1)
              ORDER BY seq LIMIT ${limit + 1}
            `,
            )
            .pipe(Effect.orDie)
      const tail = rows.slice(0, limit)
      return {
        ...(sequence ? { sequence } : {}),
        ...(checkpoint ? { checkpoint } : {}),
        tail,
        hasMore: rows.length > limit,
        ...(tail.length ? { nextSeq: Number(tail.at(-1)!.seq) } : {}),
      }
    })
  if (catalog.location === "active") return central.transaction((tx) => read(tx, false, tx)).pipe(Effect.orDie)
  return withSessionReader(root, central, catalog, sessionID, (db, archived) => read(db, archived))
}

function withSessionReader<A, E>(
  root: string,
  central: DatabaseShape,
  catalog: CatalogRow,
  sessionID: SessionSchema.ID,
  read: (db: QueryDatabase, archived: boolean) => Effect.Effect<A, E>,
) {
  if (catalog.location === "active") return read(central, false)
  if (!catalog.shard_id)
    return Effect.fail(new IntegrityError({ sessionID, message: "Archived session has no assigned shard" }))
  return Effect.gen(function* () {
    const shard = yield* shardFor(central, catalog.shard_id!, sessionID)
    return yield* withShardRead(root, shard.path, (db) =>
      Effect.gen(function* () {
        const header = yield* archiveHeader(db, sessionID, catalog.revision)
        yield* attempt(sessionID, () => validateArchiveHeader(header, catalog, sessionID))
        return yield* read(db, true)
      }),
    ).pipe(Effect.mapError((cause) => integrity(sessionID, cause)))
  })
}

function messageSequence(
  db: QueryDatabase,
  archived: boolean,
  sessionID: SessionSchema.ID,
  revision: number,
  messageID: string,
) {
  return db
    .get<{ seq: number }>(
      archived
        ? sql`SELECT seq FROM archive_session_message
            WHERE session_id = ${sessionID} AND revision = ${revision} AND id = ${messageID}`
        : sql`SELECT seq FROM session_message WHERE session_id = ${sessionID} AND id = ${messageID}`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.seq),
    )
}

function messageRows(
  db: QueryDatabase,
  archived: boolean,
  sessionID: SessionSchema.ID,
  revision: number,
  order: MessageOrder,
  direction: "previous" | "next",
  anchor: number | undefined,
  limit: number,
) {
  const physicalOrder = direction === "previous" ? (order === "asc" ? "desc" : "asc") : order
  const boundary =
    anchor === undefined ? sql`` : physicalOrder === "asc" ? sql`AND seq > ${anchor}` : sql`AND seq < ${anchor}`
  if (archived)
    return db
      .all<{ data_json: string; row_hash: string }>(
        sql`SELECT data_json, row_hash FROM archive_session_message
          WHERE session_id = ${sessionID} AND revision = ${revision} ${boundary}
          ORDER BY seq ${physicalOrder === "asc" ? sql`ASC` : sql`DESC`} LIMIT ${limit}`,
      )
      .pipe(
        Effect.orDie,
        Effect.flatMap((rows) => decodeStoredRows(sessionID, rows)),
        Effect.map((rows) => (direction === "previous" ? rows.toReversed() : rows)),
      )
  return db
    .all<RawRow>(
      sql`SELECT * FROM session_message WHERE session_id = ${sessionID} ${boundary}
      ORDER BY seq ${physicalOrder === "asc" ? sql`ASC` : sql`DESC`} LIMIT ${limit}`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => (direction === "previous" ? rows.toReversed() : rows)),
    )
}

function singleMessageRow(
  db: QueryDatabase,
  archived: boolean,
  sessionID: SessionSchema.ID,
  revision: number,
  messageID: string,
) {
  if (archived)
    return db
      .get<{ data_json: string; row_hash: string }>(
        sql`
        SELECT data_json, row_hash FROM archive_session_message
        WHERE session_id = ${sessionID} AND revision = ${revision} AND id = ${messageID}
      `,
      )
      .pipe(
        Effect.orDie,
        Effect.flatMap((row) => (row ? decodeStoredRow(sessionID, row) : Effect.succeed(undefined))),
      )
  return db
    .get<RawRow>(sql`SELECT * FROM session_message WHERE session_id = ${sessionID} AND id = ${messageID}`)
    .pipe(Effect.orDie)
}

type PageBounds = { readonly minimum: number | null; readonly maximum: number | null; readonly count: number }

function messageBounds(db: QueryDatabase, archived: boolean, sessionID: SessionSchema.ID, revision: number) {
  return db
    .get<PageBounds>(
      archived
        ? sql`SELECT MIN(seq) AS minimum, MAX(seq) AS maximum, COUNT(*) AS count
            FROM archive_session_message WHERE session_id = ${sessionID} AND revision = ${revision}`
        : sql`SELECT MIN(seq) AS minimum, MAX(seq) AS maximum, COUNT(*) AS count
            FROM session_message WHERE session_id = ${sessionID}`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((row) => row ?? { minimum: null, maximum: null, count: 0 }),
    )
}

function inputSequence(
  db: QueryDatabase,
  archived: boolean,
  sessionID: SessionSchema.ID,
  revision: number,
  inputID: string,
) {
  return db
    .get<{ admitted_seq: number }>(
      archived
        ? sql`SELECT admitted_seq FROM archive_session_input
            WHERE session_id = ${sessionID} AND revision = ${revision} AND id = ${inputID}`
        : sql`SELECT admitted_seq FROM session_input WHERE session_id = ${sessionID} AND id = ${inputID}`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.admitted_seq),
    )
}

function inputRows(
  db: QueryDatabase,
  archived: boolean,
  sessionID: SessionSchema.ID,
  revision: number,
  order: MessageOrder,
  direction: "previous" | "next",
  anchor: number | undefined,
  limit: number,
) {
  const physicalOrder = direction === "previous" ? (order === "asc" ? "desc" : "asc") : order
  const boundary =
    anchor === undefined
      ? sql``
      : physicalOrder === "asc"
        ? sql`AND admitted_seq > ${anchor}`
        : sql`AND admitted_seq < ${anchor}`
  if (archived)
    return db
      .all<{ data_json: string; row_hash: string }>(
        sql`SELECT data_json, row_hash FROM archive_session_input
          WHERE session_id = ${sessionID} AND revision = ${revision} ${boundary}
          ORDER BY admitted_seq ${physicalOrder === "asc" ? sql`ASC` : sql`DESC`} LIMIT ${limit}`,
      )
      .pipe(
        Effect.orDie,
        Effect.flatMap((rows) => decodeStoredRows(sessionID, rows)),
        Effect.map((rows) => (direction === "previous" ? rows.toReversed() : rows)),
      )
  return db
    .all<RawRow>(
      sql`SELECT * FROM session_input WHERE session_id = ${sessionID} ${boundary}
      ORDER BY admitted_seq ${physicalOrder === "asc" ? sql`ASC` : sql`DESC`} LIMIT ${limit}`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => (direction === "previous" ? rows.toReversed() : rows)),
    )
}

function inputBounds(db: QueryDatabase, archived: boolean, sessionID: SessionSchema.ID, revision: number) {
  return db
    .get<PageBounds>(
      archived
        ? sql`SELECT MIN(admitted_seq) AS minimum, MAX(admitted_seq) AS maximum, COUNT(*) AS count
            FROM archive_session_input WHERE session_id = ${sessionID} AND revision = ${revision}`
        : sql`SELECT MIN(admitted_seq) AS minimum, MAX(admitted_seq) AS maximum, COUNT(*) AS count
            FROM session_input WHERE session_id = ${sessionID}`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((row) => row ?? { minimum: null, maximum: null, count: 0 }),
    )
}

function pageResult(
  rows: ReadonlyArray<RawRow>,
  bounds: PageBounds,
  order: MessageOrder,
  anchor: number | undefined,
  sequence = "seq",
) {
  const sorted = rows.toSorted((a, b) => (Number(a[sequence]) - Number(b[sequence])) * (order === "asc" ? 1 : -1))
  const minimum = sorted.length ? Math.min(...sorted.map((row) => Number(row[sequence]))) : anchor
  const maximum = sorted.length ? Math.max(...sorted.map((row) => Number(row[sequence]))) : anchor
  const hasOlder = minimum !== undefined && bounds.minimum !== null && bounds.minimum < minimum
  const hasNewer = maximum !== undefined && bounds.maximum !== null && bounds.maximum > maximum
  return {
    rows: sorted,
    hasOlder,
    hasNewer,
    hasPrevious: order === "asc" ? hasOlder : hasNewer,
    hasNext: order === "asc" ? hasNewer : hasOlder,
  }
}

function eventSectionRow(
  db: QueryDatabase,
  archived: boolean,
  sessionID: SessionSchema.ID,
  revision: number,
  section: "event_sequence" | "event_checkpoint",
) {
  if (!archived)
    return db
      .get<RawRow>(
        sql`
        SELECT * FROM ${sql.identifier(section)} WHERE aggregate_id = ${sessionID}
      `,
      )
      .pipe(Effect.orDie)
  return db
    .get<{ data_json: string; row_hash: string }>(
      sql`
      SELECT data_json, row_hash FROM archive_session_section
      WHERE session_id = ${sessionID} AND revision = ${revision} AND section_name = ${section}
      ORDER BY ordinal LIMIT 1
    `,
    )
    .pipe(
      Effect.orDie,
      Effect.flatMap((row) => (row ? decodeStoredRow(sessionID, row) : Effect.succeed(undefined))),
    )
}

type LegacyProjection = {
  readonly messages: ReadonlyArray<RawRow>
  readonly parts: ReadonlyArray<RawRow>
}

type CheckpointLegacyProjection = LegacyProjection & {
  readonly checkpointSeq: number
}

type LegacyProjectionMarker = {
  readonly version: 2
  readonly checkpointSeq: number
  readonly messageCount: number
  readonly partCount: number
  readonly projectionHash: string
}

function checkpointLegacyProjection(
  db: QueryDatabase,
  sessionID: SessionSchema.ID,
): Effect.Effect<CheckpointLegacyProjection | undefined, IntegrityError> {
  return Effect.gen(function* () {
    const checkpoint = yield* eventSectionRow(db, false, sessionID, 0, "event_checkpoint")
    if (!checkpoint || Number(checkpoint.version) !== EventV2.CheckpointVersion) return
    const encoded = yield* attempt(sessionID, () => parseCheckpointData(checkpoint.data))
    const baseline = yield* attempt(sessionID, () => EventV2.readStoredCheckpointBaseline(encoded))
    const legacyMessages = Array.isArray(baseline.data.legacyMessages)
      ? (baseline.data.legacyMessages as ReadonlyArray<unknown>)
      : undefined
    const legacyParts = Array.isArray(baseline.data.legacyParts)
      ? (baseline.data.legacyParts as ReadonlyArray<unknown>)
      : undefined
    if (
      baseline.adapter !== SessionProjector.CheckpointAdapterID ||
      !SessionProjector.hasCheckpointLegacyProjection(baseline.version) ||
      !legacyMessages ||
      !legacyParts
    )
      return
    const messages = yield* attempt(sessionID, () =>
      legacyMessages.map((row) => checkpointLegacyRow(row, sessionID, "message")),
    )
    const parts = yield* attempt(sessionID, () => legacyParts.map((row) => checkpointLegacyRow(row, sessionID, "part")))
    const messageIDs = new Set(messages.map((row) => String(row.id)))
    if (messageIDs.size !== messages.length || new Set(parts.map((row) => String(row.id))).size !== parts.length)
      return yield* new IntegrityError({ sessionID, message: "Checkpoint legacy projection contains duplicate ids" })
    if (parts.some((row) => !messageIDs.has(String(row.message_id))))
      return yield* new IntegrityError({ sessionID, message: "Checkpoint legacy part has no matching message" })
    return { messages, parts, checkpointSeq: Number(checkpoint.seq) }
  })
}

function legacyProjectionElision(db: QueryDatabase, sessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    const checkpoint = yield* checkpointLegacyProjection(db, sessionID)
    if (!checkpoint || checkpoint.messages.length === 0) return
    const [messages, parts] = yield* Effect.all([
      db
        .all<RawRow>(
          sql`
        SELECT * FROM message WHERE session_id = ${sessionID} ORDER BY time_created, id
      `,
        )
        .pipe(Effect.orDie),
      db
        .all<RawRow>(
          sql`
        SELECT * FROM part WHERE session_id = ${sessionID} ORDER BY message_id, id
      `,
        )
        .pipe(Effect.orDie),
    ])
    if (JSON.stringify(messages) !== JSON.stringify(checkpoint.messages)) return
    if (JSON.stringify(parts) !== JSON.stringify(checkpoint.parts)) return
    const projection = { messages, parts }
    return {
      projection,
      marker: {
        version: 2,
        checkpointSeq: checkpoint.checkpointSeq,
        messageCount: messages.length,
        partCount: parts.length,
        projectionHash: legacyProjectionHash(projection),
      } satisfies LegacyProjectionMarker,
    }
  })
}

function archivedLegacyProjection(
  db: QueryDatabase,
  sessionID: SessionSchema.ID,
  revision: number,
): Effect.Effect<LegacyProjection | undefined, IntegrityError> {
  return Effect.gen(function* () {
    const stored = yield* db
      .get<{ data_json: string; row_hash: string }>(
        sql`
        SELECT data_json, row_hash FROM archive_session_section
        WHERE session_id = ${sessionID} AND revision = ${revision}
          AND section_name = ${LEGACY_PROJECTION_MARKER} AND ordinal = 0
      `,
      )
      .pipe(Effect.orDie)
    if (!stored) return
    const marker = yield* attempt(sessionID, () => {
      validateRow(stored)
      const value = JSON.parse(stored.data_json) as LegacyProjectionMarker
      if (
        value.version !== 2 ||
        !Number.isSafeInteger(value.checkpointSeq) ||
        !Number.isSafeInteger(value.messageCount) ||
        !Number.isSafeInteger(value.partCount) ||
        !SHA256.test(value.projectionHash)
      )
        throw new Error("Archived legacy projection marker is invalid")
      return value
    })
    const checkpoint = yield* eventSectionRow(db, true, sessionID, revision, "event_checkpoint")
    if (!checkpoint || Number(checkpoint.seq) !== marker.checkpointSeq)
      return yield* new IntegrityError({ sessionID, message: "Archived legacy projection checkpoint is missing" })
    const baseline = yield* attempt(sessionID, () =>
      EventV2.readStoredCheckpointBaseline(parseCheckpointData(checkpoint.data)),
    )
    if (
      baseline.adapter !== SessionProjector.CheckpointAdapterID ||
      !SessionProjector.hasCheckpointLegacyProjection(baseline.version) ||
      !Array.isArray(baseline.data.legacyMessages) ||
      !Array.isArray(baseline.data.legacyParts) ||
      baseline.data.legacyMessages.length !== 0 ||
      baseline.data.legacyParts.length !== 0
    )
      return yield* new IntegrityError({ sessionID, message: "Archived legacy checkpoint is not normalized" })
    const [messages, parts] = yield* Effect.all([
      db
        .all<{ data_json: string; row_hash: string }>(
          sql`
          SELECT data_json, row_hash FROM archive_legacy_message
          WHERE session_id = ${sessionID} AND revision = ${revision}
          ORDER BY time_created, id
        `,
        )
        .pipe(
          Effect.orDie,
          Effect.flatMap((rows) => decodeStoredRows(sessionID, rows)),
        ),
      db
        .all<{ data_json: string; row_hash: string }>(
          sql`
          SELECT data_json, row_hash FROM archive_legacy_part
          WHERE session_id = ${sessionID} AND revision = ${revision}
          ORDER BY message_id, id
        `,
        )
        .pipe(
          Effect.orDie,
          Effect.flatMap((rows) => decodeStoredRows(sessionID, rows)),
        ),
    ])
    const projection = { messages, parts }
    if (
      projection.messages.length !== marker.messageCount ||
      projection.parts.length !== marker.partCount ||
      legacyProjectionHash(projection) !== marker.projectionHash
    )
      return yield* new IntegrityError({
        sessionID,
        message: "Archived legacy projection marker does not match checkpoint",
      })
    return projection
  })
}

function normalizeArchivedCheckpointRow(row: RawRow, sessionID: SessionSchema.ID): RawRow {
  const encoded = parseCheckpointData(row.data)
  const baseline = EventV2.readStoredCheckpointBaseline(encoded)
  if (
    baseline.adapter !== SessionProjector.CheckpointAdapterID ||
    !SessionProjector.hasCheckpointLegacyProjection(baseline.version) ||
    !Array.isArray(baseline.data.legacyMessages) ||
    !Array.isArray(baseline.data.legacyParts)
  )
    throw new Error(`Session ${sessionID} has no normalizable legacy checkpoint`)
  return {
    ...row,
    data: JSON.stringify(
      EventV2.replaceStoredCheckpointBaseline(encoded, {
        ...baseline,
        data: { ...baseline.data, legacyMessages: [], legacyParts: [] },
      }),
    ),
  } satisfies RawRow
}

function hydrateArchivedCheckpointRow(row: RawRow, projection: LegacyProjection, sessionID: SessionSchema.ID): RawRow {
  const encoded = parseCheckpointData(row.data)
  const baseline = EventV2.readStoredCheckpointBaseline(encoded)
  if (
    baseline.adapter !== SessionProjector.CheckpointAdapterID ||
    !SessionProjector.hasCheckpointLegacyProjection(baseline.version) ||
    !Array.isArray(baseline.data.legacyMessages) ||
    !Array.isArray(baseline.data.legacyParts) ||
    baseline.data.legacyMessages.length !== 0 ||
    baseline.data.legacyParts.length !== 0
  )
    throw new Error(`Session ${sessionID} has no normalized legacy checkpoint`)
  return {
    ...row,
    data: JSON.stringify(
      EventV2.replaceStoredCheckpointBaseline(encoded, {
        ...baseline,
        data: {
          ...baseline.data,
          legacyMessages: projection.messages.map(checkpointBaselineRow),
          legacyParts: projection.parts.map(checkpointBaselineRow),
        },
      }),
    ),
  } satisfies RawRow
}

function parseCheckpointData(value: RawValue | undefined) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Checkpoint data is not an object")
  return parsed as Record<string, unknown>
}

function checkpointLegacyRow(value: unknown, sessionID: SessionSchema.ID, table: "message" | "part") {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Checkpoint legacy ${table} row is not an object`)
  const row = Object.fromEntries(
    Object.entries(value).map(([key, field]) => {
      if (key === "data") return [key, typeof field === "string" ? field : JSON.stringify(field)]
      if (["string", "number", "bigint"].includes(typeof field) || field === null || field instanceof Uint8Array)
        return [key, field]
      throw new Error(`Checkpoint legacy ${table} row has invalid ${key}`)
    }),
  ) as RawRow
  if (
    typeof row.id !== "string" ||
    row.session_id !== sessionID ||
    typeof row.time_created !== "number" ||
    typeof row.data !== "string" ||
    (table === "part" && typeof row.message_id !== "string")
  )
    throw new Error(`Checkpoint legacy ${table} row is incomplete`)
  return row
}

function checkpointBaselineRow(row: RawRow) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key === "data" && typeof value === "string" ? JSON.parse(value) : value,
    ]),
  )
}

function legacyProjectionHash(projection: LegacyProjection) {
  return Hash.sha256(JSON.stringify(projection))
}

function decodeStoredRows(
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<{ readonly data_json: string; readonly row_hash: string }>,
) {
  return Effect.forEach(rows, (row) => decodeStoredRow(sessionID, row))
}

function decodeStoredRow(sessionID: SessionSchema.ID, row: { readonly data_json: string; readonly row_hash: string }) {
  return attempt(sessionID, () => {
    validateRow(row)
    return decodeRowSync(row.data_json)
  })
}

function decodeEnvelope(input: string) {
  const value = JSON.parse(input) as { readonly formatVersion?: number; readonly session?: RawRow }
  if (value.formatVersion !== SNAPSHOT_FORMAT_VERSION || !value.session) throw new Error("Unsupported snapshot format")
  return { formatVersion: value.formatVersion, session: value.session }
}

function decodeRowSync(input: string) {
  const value = JSON.parse(input)
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Archive row is not an object")
  return value as RawRow
}

function validateRow(row: { readonly data_json: string; readonly row_hash: string }) {
  if (Hash.sha256(row.data_json) !== row.row_hash) throw new Error("Archived row hash mismatch")
}

function mutationReference(row: RawRow, data: string) {
  if (typeof row.id !== "string") throw new Error("Archived file mutation has no valid id")
  return {
    mutationID: row.id,
    beforeSha256: mutationHash(row.before_sha256, "before_sha256"),
    afterSha256: mutationHash(row.after_sha256, "after_sha256"),
    rowHash: Hash.sha256(data),
  }
}

function mutationHash(value: RawValue | undefined, column: string) {
  if (value === null || value === undefined) return null
  if (typeof value === "string" && SHA256.test(value)) return value
  throw new Error(`Archived file mutation has invalid ${column}`)
}

function sameMutationReference(expected: ReturnType<typeof mutationReference>, stored: StoredMutationReference) {
  return (
    SHA256.test(stored.row_hash) &&
    (stored.before_sha256 === null || SHA256.test(stored.before_sha256)) &&
    (stored.after_sha256 === null || SHA256.test(stored.after_sha256)) &&
    expected.beforeSha256 === stored.before_sha256 &&
    expected.afterSha256 === stored.after_sha256 &&
    expected.rowHash === stored.row_hash
  )
}

function readMutationReferences(db: QueryDatabase, sessionID: SessionSchema.ID, revision: number) {
  return Effect.gen(function* () {
    const exists = yield* db
      .get<{ count: number }>(
        sql`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name = 'archive_file_mutation_ref'
      `,
      )
      .pipe(Effect.orDie)
    if (!exists?.count) return
    const rows = yield* db
      .all<StoredMutationReference>(
        sql`
        SELECT mutation_id, before_sha256, after_sha256, row_hash
        FROM archive_file_mutation_ref
        WHERE session_id = ${sessionID} AND revision = ${revision}
      `,
      )
      .pipe(Effect.orDie)
    return new Map(rows.map((row) => [row.mutation_id, row]))
  })
}

function ensureMutationReferences(db: DatabaseShape) {
  return Effect.gen(function* () {
    const rows = yield* db
      .all<{
        session_id: string
        revision: number
        data_json: string
        row_hash: string
      }>(
        sql`
        SELECT session_id, revision, data_json, row_hash
        FROM archive_session_section
        WHERE section_name = 'session_file_mutation'
        ORDER BY session_id, revision, ordinal
      `,
      )
      .pipe(Effect.orDie)
    const references = yield* db
      .all<StoredMutationReference & { session_id: string; revision: number }>(
        sql`
        SELECT session_id, revision, mutation_id, before_sha256, after_sha256, row_hash
        FROM archive_file_mutation_ref
      `,
      )
      .pipe(Effect.orDie)
    const existing = new Map(
      references.map((reference) => [
        `${reference.session_id}\0${reference.revision}\0${reference.mutation_id}`,
        reference,
      ]),
    )
    for (const row of rows) {
      const decoded = yield* Effect.try({
        try: () => {
          validateRow(row)
          return decodeRowSync(row.data_json)
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error("Archived file mutation is invalid")),
      })
      if (decoded.session_id !== row.session_id)
        return yield* Effect.fail(new Error("Archived file mutation belongs to a different session"))
      const reference = yield* Effect.try({
        try: () => mutationReference(decoded, row.data_json),
        catch: (cause) => (cause instanceof Error ? cause : new Error("Archived file mutation reference is invalid")),
      })
      const key = `${row.session_id}\0${row.revision}\0${reference.mutationID}`
      const stored = existing.get(key)
      if (stored && !sameMutationReference(reference, stored))
        return yield* Effect.fail(
          new Error(`Archived file mutation ${reference.mutationID} has inconsistent references`),
        )
      if (!stored)
        yield* db.run(sql`
          INSERT INTO archive_file_mutation_ref(
            session_id, revision, mutation_id, before_sha256, after_sha256, row_hash
          ) VALUES (
            ${row.session_id}, ${row.revision}, ${reference.mutationID},
            ${reference.beforeSha256}, ${reference.afterSha256}, ${reference.rowHash}
          )
        `)
      existing.delete(key)
    }
    if (existing.size > 0)
      return yield* Effect.fail(new Error("Archive shard contains file mutation references without snapshot rows"))
  })
}

function insertRow(db: QueryDatabase, table: string, row: RawRow) {
  const columns = Object.keys(row)
  return db.run(sql`
    INSERT OR IGNORE INTO ${sql.identifier(table)}
    (${sql.join(
      columns.map((column) => sql.identifier(column)),
      sql`, `,
    )})
    VALUES (${sql.join(
      columns.map((column) => sql`${row[column]}`),
      sql`, `,
    )})
  `)
}

function deleteActiveSnapshot(db: QueryDatabase, sessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    yield* db.run(sql`DELETE FROM attachment WHERE session_id = ${sessionID}`)
    yield* db.run(sql`DELETE FROM event_sequence WHERE aggregate_id = ${sessionID}`)
    yield* db.run(sql`DELETE FROM session WHERE id = ${sessionID}`)
  })
}

function pruneArchivedRevisions(
  db: DatabaseShape,
  root: string,
  sessionID: SessionSchema.ID,
  revision: number,
  timestamp: number,
) {
  return Effect.gen(function* () {
    const shards = yield* db
      .all<{ id: string; path: string }>(
        sql`
        SELECT DISTINCT s.id, s.path
        FROM session_archive_journal j
        JOIN session_archive_shard s ON s.id = j.shard_id
        WHERE j.session_id = ${sessionID} AND j.operation = 'archive'
          AND j.state = 'completed' AND j.revision < ${revision}
        ORDER BY s.id
      `,
      )
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      shards,
      (row) =>
        Effect.gen(function* () {
          yield* withShardWrite(root, row.path, (shard) =>
            Effect.gen(function* () {
              yield* shard.run(sql`
                DELETE FROM archive_session WHERE session_id = ${sessionID} AND revision < ${revision}
              `)
              yield* shard.run("PRAGMA wal_checkpoint(TRUNCATE)")
              // This also activates incremental auto-vacuum for pre-existing shards
              // and physically releases pages from retired revisions.
              yield* shard.run("VACUUM")
              yield* shard.run("PRAGMA wal_checkpoint(TRUNCATE)")
            }),
          )
          yield* db
            .update(SessionArchiveShardTable)
            .set({ size_bytes: yield* sizeWithWal(row.path), time_updated: timestamp })
            .where(eq(SessionArchiveShardTable.id, row.id))
            .run()
            .pipe(Effect.orDie)
        }),
      { discard: true },
    )
  })
}

function selectShard(db: DatabaseShape, root: string, maxBytes: number, estimatedBytes: number, timestamp: number) {
  return Effect.gen(function* () {
    const open = yield* db
      .select()
      .from(SessionArchiveShardTable)
      .where(eq(SessionArchiveShardTable.state, "open"))
      .orderBy(asc(SessionArchiveShardTable.time_created))
      .get()
      .pipe(Effect.orDie)
    const openBytes = open
      ? yield* canonicalShardPath(root, open.path, "read").pipe(Effect.flatMap(sizeWithWal))
      : undefined
    if (open && openBytes !== undefined && openBytes + estimatedBytes <= maxBytes) {
      if (openBytes !== open.size_bytes)
        yield* db
          .update(SessionArchiveShardTable)
          .set({ size_bytes: openBytes, time_updated: timestamp })
          .where(eq(SessionArchiveShardTable.id, open.id))
          .run()
          .pipe(Effect.orDie)
      return { id: open.id, path: open.path }
    }
    if (open && openBytes !== undefined)
      yield* db
        .update(SessionArchiveShardTable)
        .set({ state: "sealed", size_bytes: openBytes, time_sealed: timestamp, time_updated: timestamp })
        .where(eq(SessionArchiveShardTable.id, open.id))
        .run()
        .pipe(Effect.orDie)
    const id = `archive_${timestamp}_${randomUUID().slice(0, 8)}`
    const filename = yield* canonicalShardPath(root, path.join(root, `${id}.sqlite`), "write")
    yield* withShardWrite(root, filename, () => Effect.void)
    yield* db
      .insert(SessionArchiveShardTable)
      .values({
        id,
        path: filename,
        state: estimatedBytes > maxBytes ? "sealed" : "open",
        size_bytes: yield* sizeWithWal(filename),
        max_bytes: maxBytes,
        session_count: 0,
        time_created: timestamp,
        time_updated: timestamp,
        ...(estimatedBytes > maxBytes ? { time_sealed: timestamp } : {}),
      })
      .run()
      .pipe(Effect.orDie)
    return { id, path: filename }
  })
}

function shardFor(db: DatabaseShape, shardID: string, sessionID: SessionSchema.ID) {
  return db
    .select()
    .from(SessionArchiveShardTable)
    .where(eq(SessionArchiveShardTable.id, shardID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.flatMap((row) =>
        row ? Effect.succeed(row) : Effect.fail(new IntegrityError({ sessionID, message: "Archive shard is missing" })),
      ),
    )
}

function claimJournal(input: {
  readonly db: DatabaseShape
  readonly operationKey: string
  readonly sessionID: SessionSchema.ID
  readonly operation: "archive" | "reactivate" | "purge"
  readonly revision: number
  readonly shardID?: string
  readonly now: () => number
  readonly leaseMs: number
}) {
  const owner = `lease_${randomUUID()}`
  return Effect.gen(function* () {
    yield* input.db
      .insert(SessionArchiveJournalTable)
      .values({
        id: owner,
        operation_key: input.operationKey,
        session_id: input.sessionID,
        operation: input.operation,
        state: "prepared",
        revision: input.revision,
        shard_id: input.shardID,
        time_created: input.now(),
        time_updated: input.now(),
      })
      .onConflictDoNothing({ target: SessionArchiveJournalTable.operation_key })
      .run()
      .pipe(Effect.orDie)
    const started = Date.now()
    while (Date.now() - started < CLAIM_WAIT_MS) {
      const row = yield* journalFor(input.db, input.operationKey)
      if (row.operation !== input.operation) {
        if (input.operation !== "purge" || (row.state !== "failed" && row.time_updated > input.now() - input.leaseMs))
          return { owner, row, owned: false as const }
        yield* input.db.run(sql`
          UPDATE session_archive_journal SET id = ${owner}, operation = ${input.operation}, state = 'prepared',
            shard_id = COALESCE(shard_id, ${input.shardID ?? null}), error = NULL, time_updated = ${input.now()}
          WHERE operation_key = ${input.operationKey} AND id = ${row.id} AND time_updated = ${row.time_updated}
            AND state <> 'completed'
        `)
        const claimed = yield* journalFor(input.db, input.operationKey)
        if (claimed.id === owner) return { owner, row: claimed, owned: true as const }
        continue
      }
      if (row.state === "completed") return { owner, row, owned: false as const }
      if (row.id === owner) return { owner, row, owned: true as const }
      if (row.state === "failed" || row.time_updated <= input.now() - input.leaseMs) {
        yield* input.db.run(sql`
          UPDATE session_archive_journal SET id = ${owner},
            state = CASE WHEN state = 'failed' THEN 'prepared' ELSE state END,
            shard_id = COALESCE(shard_id, ${input.shardID ?? null}), error = NULL, time_updated = ${input.now()}
          WHERE operation_key = ${input.operationKey} AND id = ${row.id} AND time_updated = ${row.time_updated}
            AND state <> 'completed'
        `)
        const claimed = yield* journalFor(input.db, input.operationKey)
        if (claimed.id === owner) return { owner, row: claimed, owned: true as const }
      }
      yield* Effect.sleep(25)
    }
    return { owner, row: yield* journalFor(input.db, input.operationKey), owned: false as const }
  })
}

function journalFor(db: DatabaseShape, operationKey: string) {
  return db
    .select()
    .from(SessionArchiveJournalTable)
    .where(eq(SessionArchiveJournalTable.operation_key, operationKey))
    .get()
    .pipe(
      Effect.orDie,
      Effect.flatMap((row) => (row ? Effect.succeed(row) : Effect.fail(new Error("Archive journal is missing")))),
    )
}

function bindJournalShard(db: DatabaseShape, operationKey: string, owner: string, shardID: string, timestamp: number) {
  return Effect.gen(function* () {
    yield* db.run(sql`
      UPDATE session_archive_journal SET shard_id = ${shardID}, time_updated = ${timestamp}
      WHERE operation_key = ${operationKey} AND id = ${owner} AND state <> 'completed'
    `)
    const row = yield* journalFor(db, operationKey)
    if (row.id !== owner || row.shard_id !== shardID) return yield* Effect.fail(new Error("Archive lease was lost"))
  })
}

function heartbeatJournal(db: DatabaseShape, operationKey: string, owner: string, timestamp: number) {
  return Effect.gen(function* () {
    yield* db.run(sql`
      UPDATE session_archive_journal SET time_updated = ${timestamp}
      WHERE operation_key = ${operationKey} AND id = ${owner} AND state <> 'completed'
    `)
    const row = yield* journalFor(db, operationKey)
    if (row.id !== owner) return yield* Effect.die("Archive lease was lost")
  })
}

function updateJournal(
  db: DatabaseShape,
  operationKey: string,
  owner: string,
  state: SessionArchiveJournalState,
  timestamp: number,
  summary: Summary,
) {
  return db.run(sql`
    UPDATE session_archive_journal SET state = ${state}, content_hash = ${summary.hash},
      message_count = ${summary.messageCount}, input_count = ${summary.inputCount}, time_updated = ${timestamp}
    WHERE operation_key = ${operationKey} AND id = ${owner} AND state <> 'completed'
  `)
}

function failJournal(db: DatabaseShape, operationKey: string, owner: string, timestamp: number, error: string) {
  return db
    .run(
      sql`
      UPDATE session_archive_journal SET state = 'failed', error = ${error}, time_updated = ${timestamp}
      WHERE operation_key = ${operationKey} AND id = ${owner} AND state <> 'completed'
    `,
    )
    .pipe(Effect.ignore)
}

function requireJournalOwner(db: QueryDatabase, operationKey: string, owner: string, sessionID: SessionSchema.ID) {
  return db
    .get<{ id: string }>(
      sql`
      SELECT id FROM session_archive_journal
      WHERE operation_key = ${operationKey} AND id = ${owner} AND state <> 'completed'
    `,
    )
    .pipe(
      Effect.flatMap((row) =>
        row
          ? Effect.void
          : Effect.fail(new IntegrityError({ sessionID, message: "Archive operation lease was lost before cutover" })),
      ),
    )
}

function completeJournal(db: QueryDatabase, operationKey: string, owner: string, timestamp: number) {
  return db.run(sql`
    UPDATE session_archive_journal SET state = 'completed', time_updated = ${timestamp}, time_completed = ${timestamp}
    WHERE operation_key = ${operationKey} AND id = ${owner} AND state <> 'completed'
  `)
}

function withShardWrite<A, E>(root: string, filename: string, use: (db: DatabaseShape) => Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    const canonical = yield* canonicalShardPath(root, filename, "write")
    const { layer } = yield* Effect.promise(() => import("#sqlite"))
    return yield* Effect.gen(function* () {
      const db = yield* makeShardDatabase
      yield* db.run("PRAGMA auto_vacuum = INCREMENTAL")
      yield* db.run("PRAGMA foreign_keys = ON")
      for (const statement of shardSchema) yield* db.run(statement)
      yield* ensureShardVersion(db)
      yield* ensureMutationReferences(db)
      return yield* use(db)
    }).pipe(Effect.provide(layer({ filename: canonical })), Effect.scoped)
  })
}

function withShardRead<A, E>(root: string, filename: string, use: (db: DatabaseShape) => Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    const canonical = yield* canonicalShardPath(root, filename, "read")
    const { layer } = yield* Effect.promise(() => import("#sqlite"))
    return yield* Effect.gen(function* () {
      const db = yield* makeShardDatabase
      yield* verifyShardVersion(db)
      return yield* use(db)
    }).pipe(
      Effect.provide(layer({ filename: canonical, readonly: true, readwrite: false, create: false, disableWAL: true })),
      Effect.scoped,
    )
  })
}

function ensureShardVersion(db: DatabaseShape) {
  return Effect.gen(function* () {
    const columns = yield* db.all<{ name: string }>("PRAGMA table_info(archive_session)")
    if (!columns.some((column) => column.name === "format_version")) {
      const count = yield* db.get<{ count: number }>("SELECT COUNT(*) AS count FROM archive_session")
      if (count?.count) return yield* Effect.fail(new Error("Unversioned non-empty archive shard requires migration"))
      yield* db.run("ALTER TABLE archive_session ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1")
    }
    const version = yield* db.get<{ value: string }>("SELECT value FROM archive_metadata WHERE key = 'format_version'")
    if (version && Number(version.value) !== SHARD_FORMAT_VERSION)
      return yield* Effect.fail(new Error(`Unsupported archive shard version ${version.value}`))
    yield* db.run(sql`
      INSERT INTO archive_metadata(key, value) VALUES ('format_version', ${String(SHARD_FORMAT_VERSION)})
      ON CONFLICT(key) DO NOTHING
    `)
  })
}

function verifyShardVersion(db: QueryDatabase) {
  return db
    .get<{ value: string }>("SELECT value FROM archive_metadata WHERE key = 'format_version'")
    .pipe(
      Effect.flatMap((row) =>
        row && Number(row.value) === SHARD_FORMAT_VERSION
          ? Effect.void
          : Effect.fail(new Error("Archive shard has an unsupported or missing format version")),
      ),
    )
}

function canonicalShardPath(root: string, filename: string, mode: "read" | "write") {
  return Effect.tryPromise({
    try: async () => {
      if (!path.isAbsolute(filename)) throw new Error("Archive shard path must be absolute")
      const canonicalRoot = await realpath(root)
      if (mode === "read") {
        const canonical = await realpath(filename)
        const info = await stat(canonical)
        if (!info.isFile() || !contains(canonicalRoot, canonical)) throw new Error("Archive shard escapes its root")
        return canonical
      }
      const parent = await realpath(path.dirname(filename))
      if (!contains(canonicalRoot, parent)) throw new Error("Archive shard write escapes its root")
      const target = path.join(parent, path.basename(filename))
      if (
        await stat(target)
          .then(() => true)
          .catch(() => false)
      ) {
        const canonical = await realpath(target)
        if (!contains(canonicalRoot, canonical)) throw new Error("Archive shard symlink escapes its root")
        return canonical
      }
      return target
    },
    catch: (cause) => cause,
  })
}

function sizeWithWal(filename: string) {
  return Effect.tryPromise({
    try: async () => {
      const main = await stat(filename)
      const wal = await stat(`${filename}-wal`).catch(() => undefined)
      return main.size + (wal?.size ?? 0)
    },
    catch: (cause) => cause,
  })
}

function contains(root: string, filename: string) {
  const relative = path.relative(root, filename)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function integrity(sessionID: SessionSchema.ID, cause: unknown) {
  return cause instanceof IntegrityError
    ? cause
    : new IntegrityError({ sessionID, message: cause instanceof Error ? cause.message : String(cause) })
}

function attempt<A>(sessionID: SessionSchema.ID, run: () => A) {
  return Effect.try({
    try: run,
    catch: (cause) => integrity(sessionID, cause),
  })
}

export { DEFAULT_INACTIVE_MS, DEFAULT_SHARD_BYTES, SHARD_FORMAT_VERSION, SNAPSHOT_FORMAT_VERSION }
