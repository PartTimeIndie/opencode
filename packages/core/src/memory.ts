export * as Memory from "./memory"

import { Context, Effect, Layer, Schema } from "effect"
import { and, desc, eq, inArray, or, sql } from "drizzle-orm"
import { Database } from "./database/database"
import { Identifier } from "./id/id"
import { MemoryEmbeddingTable, MemoryTable } from "./memory/sql"
import { SystemContext } from "./system-context/index"

export const Scope = Schema.Literals(["global", "project", "workspace", "session"])
export const State = Schema.Literals(["pending", "approved", "rejected", "deleted"])
export const Provenance = Schema.Struct({
  origin: Schema.NonEmptyString,
  captured_at: Schema.Number,
  session_id: Schema.String.pipe(Schema.optional),
  message_id: Schema.String.pipe(Schema.optional),
  artifact: Schema.String.pipe(Schema.optional),
})

export class Info extends Schema.Class<Info>("Memory.Info")({
  id: Schema.String,
  scope: Scope,
  scope_key: Schema.String,
  content: Schema.String,
  source: Schema.String,
  provenance: Provenance,
  state: State,
  reviewed_by: Schema.String.pipe(Schema.optional),
  time_reviewed: Schema.Number.pipe(Schema.optional),
  time_created: Schema.Number,
  time_updated: Schema.Number,
}) {}

export type Scope = typeof Scope.Type
export type State = typeof State.Type
export type Provenance = typeof Provenance.Type

export interface Interface {
  readonly propose: (input: {
    readonly scope: Scope
    readonly scopeKey: string
    readonly content: string
    readonly source: string
    readonly provenance: Provenance
  }) => Effect.Effect<Info>
  readonly review: (input: {
    readonly id: string
    readonly decision: "approved" | "rejected"
    readonly reviewedBy: string
  }) => Effect.Effect<Info | undefined>
  readonly remove: (id: string, reviewedBy: string) => Effect.Effect<Info | undefined>
  readonly list: (input?: {
    readonly state?: State
    readonly scope?: Scope
    readonly scopeKey?: string
    readonly limit?: number
  }) => Effect.Effect<Info[]>
  readonly recall: (input: {
    readonly projectID: string
    readonly workspaceID?: string
    readonly sessionID: string
    readonly query?: string
    readonly limit?: number
  }) => Effect.Effect<Info[]>
  readonly putEmbedding: (input: {
    readonly memoryID: string
    readonly model: string
    readonly vector: readonly number[]
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fromRow = (row: typeof MemoryTable.$inferSelect) =>
      new Info({
        id: row.id,
        scope: row.scope,
        scope_key: row.scope_key,
        content: row.content,
        source: row.source,
        provenance: row.provenance,
        state: row.state,
        ...(row.reviewed_by === null ? {} : { reviewed_by: row.reviewed_by }),
        ...(row.time_reviewed === null ? {} : { time_reviewed: row.time_reviewed }),
        time_created: row.time_created,
        time_updated: row.time_updated,
      })
    const get = (id: string) =>
      db.select().from(MemoryTable).where(eq(MemoryTable.id, id)).get().pipe(
        Effect.orDie,
        Effect.map((row) => (row ? fromRow(row) : undefined)),
      )

    return Service.of({
      propose: Effect.fn("Memory.propose")(function* (input) {
        const content = input.content.trim()
        if (!content) return yield* Effect.die("Memory content must not be empty")
        const now = Date.now()
        const row = yield* db
          .insert(MemoryTable)
          .values({
            id: Identifier.ascending("memory"),
            scope: input.scope,
            scope_key: input.scope === "global" ? "" : input.scopeKey,
            content,
            source: input.source,
            provenance: input.provenance,
            state: "pending",
            time_created: now,
            time_updated: now,
          })
          .returning()
          .get()
          .pipe(Effect.orDie)
        return fromRow(row)
      }),
      review: Effect.fn("Memory.review")(function* (input) {
        const now = Date.now()
        const row = yield* db
          .update(MemoryTable)
          .set({
            state: input.decision,
            reviewed_by: input.reviewedBy,
            time_reviewed: now,
            time_updated: now,
          })
          .where(and(eq(MemoryTable.id, input.id), eq(MemoryTable.state, "pending")))
          .returning()
          .get()
          .pipe(Effect.orDie)
        return row ? fromRow(row) : yield* get(input.id)
      }),
      remove: Effect.fn("Memory.remove")(function* (id, reviewedBy) {
        const now = Date.now()
        const row = yield* db
          .update(MemoryTable)
          .set({ state: "deleted", reviewed_by: reviewedBy, time_reviewed: now, time_updated: now })
          .where(and(eq(MemoryTable.id, id), inArray(MemoryTable.state, ["pending", "approved", "rejected"])))
          .returning()
          .get()
          .pipe(Effect.orDie)
        return row ? fromRow(row) : yield* get(id)
      }),
      list: Effect.fn("Memory.list")(function* (input = {}) {
        const rows = yield* db
          .select()
          .from(MemoryTable)
          .where(
            and(
              input.state ? eq(MemoryTable.state, input.state) : undefined,
              input.scope ? eq(MemoryTable.scope, input.scope) : undefined,
              input.scopeKey === undefined ? undefined : eq(MemoryTable.scope_key, input.scopeKey),
            ),
          )
          .orderBy(desc(MemoryTable.time_updated))
          .limit(Math.min(Math.max(input.limit ?? 100, 1), 500))
          .all()
          .pipe(Effect.orDie)
        return rows.map(fromRow)
      }),
      recall: Effect.fn("Memory.recall")(function* (input) {
        const scope = or(
          and(eq(MemoryTable.scope, "global"), eq(MemoryTable.scope_key, "")),
          and(eq(MemoryTable.scope, "project"), eq(MemoryTable.scope_key, input.projectID)),
          input.workspaceID
            ? and(eq(MemoryTable.scope, "workspace"), eq(MemoryTable.scope_key, input.workspaceID))
            : undefined,
          and(eq(MemoryTable.scope, "session"), eq(MemoryTable.scope_key, input.sessionID)),
        )
        const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
        const query = input.query
          ?.trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((term) => `"${term.replaceAll('"', '""')}"`)
          .join(" AND ")
        const rows = query
          ? yield* Effect.gen(function* () {
              const ids = yield* db
                .all<{ id: string }>(sql`
                SELECT m.id
                FROM memory m
                JOIN memory_fts ON memory_fts.id = m.id
                WHERE m.state = 'approved'
                  AND memory_fts.content MATCH ${query}
                  AND (
                    (m.scope = 'global' AND m.scope_key = '') OR
                    (m.scope = 'project' AND m.scope_key = ${input.projectID}) OR
                    (m.scope = 'workspace' AND m.scope_key = ${input.workspaceID ?? "__none__"}) OR
                    (m.scope = 'session' AND m.scope_key = ${input.sessionID})
                  )
                ORDER BY bm25(memory_fts), m.time_updated DESC
                LIMIT ${limit}
              `)
                .pipe(Effect.orDie)
              if (ids.length === 0) return []
              const selected = yield* db
                .select()
                .from(MemoryTable)
                .where(inArray(MemoryTable.id, ids.map((item) => item.id)))
                .all()
                .pipe(Effect.orDie)
              const byID = new Map(selected.map((item) => [item.id, item]))
              return ids.flatMap((item) => {
                const row = byID.get(item.id)
                return row ? [row] : []
              })
            })
          : yield* db
              .select()
              .from(MemoryTable)
              .where(and(eq(MemoryTable.state, "approved"), scope))
              .orderBy(desc(MemoryTable.time_updated))
              .limit(limit)
              .all()
              .pipe(Effect.orDie)
        return rows.map(fromRow)
      }),
      putEmbedding: Effect.fn("Memory.putEmbedding")(function* (input) {
        yield* db
          .insert(MemoryEmbeddingTable)
          .values({
            memory_id: input.memoryID,
            model: input.model,
            dimensions: input.vector.length,
            vector: [...input.vector],
          })
          .onConflictDoUpdate({
            target: [MemoryEmbeddingTable.memory_id, MemoryEmbeddingTable.model],
            set: { dimensions: input.vector.length, vector: [...input.vector] },
          })
          .run()
          .pipe(Effect.orDie)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export function context(
  service: Interface,
  input: { readonly projectID: string; readonly workspaceID?: string; readonly sessionID: string },
) {
  const load = service.recall({ ...input, limit: 50 })
  const render = (items: readonly Info[]) =>
    items.length === 0
      ? "Approved memories: (none)"
      : [
          "Approved memories (reviewed, scoped, and provenance-bearing):",
          ...items.map(
            (item) =>
              `- [${item.id}; ${item.scope}; source=${item.source}; origin=${item.provenance.origin}] ${item.content}`,
          ),
        ].join("\n")
  return SystemContext.make({
    key: SystemContext.Key.make("memory/approved"),
    codec: Schema.toCodecJson(Schema.Array(Info)),
    load,
    baseline: render,
    update: (_previous, current) => `Approved memory changed:\n${render(current)}`,
    removed: () => "Approved memories are no longer available.",
  })
}
