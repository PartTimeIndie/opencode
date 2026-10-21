export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Option, Schedule, Schema, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"
import { migrateLegacySessionLinks } from "./session-links-migration"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)
const LEGACY_EVENT_BACKFILL_ID = "repair_legacy_session_events_v1"
const migrationLockRetrySchedule = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5)),
)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export type ApplyOptions = {
  readonly deferLegacyEventBackfill?: boolean
  readonly deferStartupRepairs?: boolean
}

export function apply(db: Database, options: ApplyOptions = {}) {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      if (tables.some((table) => table.name === "session")) return yield* applyOnly(db, migrations, options)
      if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* schema.up(tx)
          yield* tx.run(
            sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
          )
          yield* Effect.forEach(migrations, (migration) =>
            tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
            ),
          )
        }),
      )
      if (!options.deferStartupRepairs) yield* repairMemorySearch(db)
    }),
  )
}

export function applyOnly(db: Database, input: Migration[], options: ApplyOptions = {}) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
      ) {
        yield* db.run(sql`
          INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
          SELECT name, ${Date.now()}
          FROM ${sql.identifier("__drizzle_migrations")}
          WHERE name IS NOT NULL
        `)
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            if (yield* tx.get(sql`SELECT id FROM ${sql.identifier("migration")} WHERE id = ${migration.id}`)) return
            yield* migration.up(tx)
            yield* tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
            )
          }),
        )
        .pipe(
          Effect.retry({
            while: isRetryableDatabaseLock,
            schedule: migrationLockRetrySchedule,
          }),
        )
      completed.add(migration.id)
    }

    if (!options.deferStartupRepairs) {
      yield* repairSchema(db)
      yield* db.transaction(migrateLegacySessionLinks)
      yield* repairMemorySearch(db)
      yield* repairSurfaceMetadata(db)
    }
    if (options.deferLegacyEventBackfill) return
    yield* repairLegacySessionEvents(db)
  })
}

export function repairLegacySessionEvents(db: Database) {
  return backfillLegacySessionEvents(db).pipe(
    Effect.retry({
      while: isRetryableDatabaseLock,
      schedule: migrationLockRetrySchedule,
    }),
    Effect.catch((error) => {
      if (!isRetryableDatabaseLock(error)) return Effect.fail(error)
      return Effect.logWarning("DatabaseMigration: legacy event backfill deferred because SQLite is busy")
    }),
  )
}

export function repairMemorySearch(db: Database) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const previous = yield* db.get<{ timeout: number }>("PRAGMA busy_timeout")
      yield* db.run("PRAGMA busy_timeout = 250")
      return previous?.timeout ?? 30_000
    }),
    () => repairMemorySearchAttempt(db),
    (timeout) => db.run(`PRAGMA busy_timeout = ${timeout}`).pipe(Effect.ignore),
  )
}

function repairMemorySearchAttempt(db: Database) {
  return Effect.gen(function* () {
    const objects = new Set(
      (yield* db.all<{ name: string }>(`
          SELECT name FROM sqlite_master
          WHERE name IN ('memory', 'memory_fts', 'memory_fts_insert', 'memory_fts_update', 'memory_fts_delete')
        `)).map((object) => object.name),
    )
    if (!objects.has("memory")) return
    if (!objects.has("memory_fts"))
      yield* db.run(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${identifier("memory_fts")} USING fts5(${identifier("id")} UNINDEXED, ${identifier("content")}, tokenize = 'unicode61')`,
      )
    if (!objects.has("memory_fts_insert"))
      yield* db.run(`
        CREATE TRIGGER IF NOT EXISTS ${identifier("memory_fts_insert")} AFTER INSERT ON ${identifier("memory")}
        WHEN NEW.${identifier("state")} = 'approved'
        BEGIN
          INSERT INTO ${identifier("memory_fts")} (${identifier("id")}, ${identifier("content")})
          VALUES (NEW.${identifier("id")}, NEW.${identifier("content")});
        END
      `)
    if (!objects.has("memory_fts_update"))
      yield* db.run(`
        CREATE TRIGGER IF NOT EXISTS ${identifier("memory_fts_update")} AFTER UPDATE ON ${identifier("memory")}
        BEGIN
          DELETE FROM ${identifier("memory_fts")} WHERE ${identifier("id")} = OLD.${identifier("id")};
          INSERT INTO ${identifier("memory_fts")} (${identifier("id")}, ${identifier("content")})
          SELECT NEW.${identifier("id")}, NEW.${identifier("content")}
          WHERE NEW.${identifier("state")} = 'approved';
        END
      `)
    if (!objects.has("memory_fts_delete"))
      yield* db.run(`
        CREATE TRIGGER IF NOT EXISTS ${identifier("memory_fts_delete")} AFTER DELETE ON ${identifier("memory")}
        BEGIN
          DELETE FROM ${identifier("memory_fts")} WHERE ${identifier("id")} = OLD.${identifier("id")};
        END
      `)

    if (
      !(yield* db.get(`
        SELECT 1
        FROM ${identifier("memory")} m
        WHERE m.${identifier("state")} = 'approved'
          AND NOT EXISTS (
            SELECT 1 FROM ${identifier("memory_fts")} f WHERE f.${identifier("id")} = m.${identifier("id")}
          )
        LIMIT 1
      `))
    )
      return
    yield* db.run(`
      INSERT INTO ${identifier("memory_fts")} (${identifier("id")}, ${identifier("content")})
      SELECT m.${identifier("id")}, m.${identifier("content")}
      FROM ${identifier("memory")} m
      WHERE m.${identifier("state")} = 'approved'
        AND NOT EXISTS (
          SELECT 1 FROM ${identifier("memory_fts")} f WHERE f.${identifier("id")} = m.${identifier("id")}
        )
    `)
  }).pipe(
    Effect.retry({
      while: isRetryableDatabaseLock,
      schedule: migrationLockRetrySchedule,
    }),
    Effect.catch((error) => {
      if (!isRetryableDatabaseLock(error)) return Effect.fail(error)
      return Effect.logWarning("DatabaseMigration: memory search repair deferred because SQLite is busy")
    }),
  )
}

function repairSurfaceMetadata(db: Database) {
  return Effect.gen(function* () {
    if (!(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"session_question"}`)))
      return
    const columns = yield* db.all<{ name: string }>(`PRAGMA table_info(${quoteString("session_question")})`)
    if (
      !["mode", "revision", "action_metadata", "request"].every((name) =>
        columns.some((column) => column.name === name),
      )
    )
      return
    const needsRepair = `
      \`mode\` IS NULL
      OR \`mode\` NOT IN ('blocking', 'interactive', 'passive')
      OR \`revision\` IS NULL
      OR \`revision\` <= 0
      OR NOT json_valid(\`action_metadata\`)
      OR (
        json_valid(\`request\`)
        AND \`request\` IS NOT json_set(
          \`request\`,
          '$.mode', CASE WHEN \`mode\` IN ('blocking', 'interactive', 'passive') THEN \`mode\` ELSE 'blocking' END,
          '$.revision', CASE WHEN \`revision\` > 0 THEN \`revision\` ELSE 1 END,
          '$.actions', json(CASE WHEN json_valid(\`action_metadata\`) THEN \`action_metadata\` ELSE '[]' END)
        )
      )
    `
    if (!(yield* db.get(`SELECT 1 FROM ${identifier("session_question")} WHERE ${needsRepair} LIMIT 1`))) return
    yield* db.run(`
      UPDATE ${identifier("session_question")}
      SET
        ${identifier("mode")} = CASE WHEN ${identifier("mode")} IN ('blocking', 'interactive', 'passive') THEN ${identifier("mode")} ELSE 'blocking' END,
        ${identifier("revision")} = CASE WHEN ${identifier("revision")} > 0 THEN ${identifier("revision")} ELSE 1 END,
        ${identifier("action_metadata")} = CASE WHEN json_valid(${identifier("action_metadata")}) THEN ${identifier("action_metadata")} ELSE '[]' END,
        ${identifier("request")} = CASE
          WHEN json_valid(${identifier("request")}) THEN json_set(
            ${identifier("request")},
            '$.mode', CASE WHEN ${identifier("mode")} IN ('blocking', 'interactive', 'passive') THEN ${identifier("mode")} ELSE 'blocking' END,
            '$.revision', CASE WHEN ${identifier("revision")} > 0 THEN ${identifier("revision")} ELSE 1 END,
            '$.actions', json(CASE WHEN json_valid(${identifier("action_metadata")}) THEN ${identifier("action_metadata")} ELSE '[]' END)
          )
          ELSE ${identifier("request")}
        END
      WHERE ${needsRepair}
    `)
  })
}

type SchemaTable = {
  name: string
  columns: SchemaColumn[]
  statement: string
}

type SchemaColumn = {
  name: string
  definition: string
}

type SchemaIndex = {
  name: string
  table: string
  columns: string[]
  statement: string
  unique: boolean
  where?: string
}

type LegacyMessageRow = {
  id: string
  session_id: string
  time_created: number
  time_updated: number
  data: string
}

type LegacyPartRow = {
  id: string
  message_id: string
  session_id: string
  time_created: number
  time_updated: number
  data: string
}

type BackfillEvent = {
  seq: number
  type: string
  version: number
  data: Record<string, unknown>
}

type BackfillProjection = {
  id: string
  sessionID: string
  type: "user" | "assistant"
  seq: number
  timeCreated: number
  timeUpdated: number
  data: Record<string, unknown>
}

type BackfillPromptInput = {
  id: string
  sessionID: string
  seq: number
  prompt: Record<string, unknown>
  timeCreated: number
}

type LegacyPart = LegacyPartRow & {
  value: Record<string, unknown>
}

function repairSchema(db: Database) {
  return db.transaction((tx) =>
    Effect.gen(function* () {
      if (!(yield* tableExists(tx, "session"))) return
      const statements = yield* schemaStatements()
      const tables = statements.flatMap(parseTable)
      for (const table of tables) {
        if (!(yield* tableExists(tx, table.name))) {
          yield* tx.run(table.statement.replace(/^CREATE TABLE/i, "CREATE TABLE IF NOT EXISTS"))
          continue
        }
        const columns = yield* tableColumns(tx, table.name)
        const repairTurnCompletionMarkers =
          table.name === "session_activity" &&
          ["turn_completion_state", "turn_completion_result", "turn_completion_completed_at"].some(
            (column) => !columns.has(column),
          )
        for (const column of table.columns) {
          if (columns.has(column.name) || !canAddColumn(column.definition)) continue
          yield* tx.run(`ALTER TABLE ${identifier(table.name)} ADD ${column.definition}`)
        }
        if (repairTurnCompletionMarkers) {
          const repaired = yield* tableColumns(tx, table.name)
          const marker = yield* tx.get<{ time_completed: number }>(
            sql`SELECT time_completed FROM ${sql.identifier("migration")} WHERE id = ${"20260713230853_turn_completion_activity_marker"}`,
          )
          if (
            !marker ||
            !Number.isSafeInteger(marker.time_completed) ||
            ![
              "status",
              "time_updated",
              "turn_completion_state",
              "turn_completion_result",
              "turn_completion_completed_at",
            ].every((column) => repaired.has(column))
          )
            continue
          yield* tx.run(`
            UPDATE ${identifier(table.name)}
            SET
              ${identifier("turn_completion_state")} = 'done',
              ${identifier("turn_completion_result")} = 'skipped',
              ${identifier("turn_completion_completed_at")} = COALESCE(
                ${identifier("turn_completion_completed_at")},
                ${identifier("time_updated")}
              )
            WHERE ${identifier("status")} IN ('completed', 'failed', 'interrupted')
              AND ${identifier("turn_completion_state")} IS NULL
              AND ${identifier("turn_completion_result")} IS NULL
              AND ${identifier("time_updated")} < ${marker.time_completed}
          `)
        }
      }

      for (const index of statements.flatMap(parseIndex)) {
        if (!(yield* tableExists(tx, index.table)) || (yield* indexExists(tx, index.name))) continue
        const columns = yield* tableColumns(tx, index.table)
        if (!index.columns.every((column) => columns.has(column))) continue
        if (index.unique && (yield* hasDuplicateIndexRows(tx, index))) continue
        yield* tx.run(
          index.statement.replace(
            /^CREATE (UNIQUE )?INDEX/i,
            `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS`,
          ),
        )
      }
    }),
  )
}

function backfillLegacySessionEvents(db: Database) {
  return db.transaction((tx) =>
    Effect.gen(function* () {
      for (const table of [
        "session",
        "message",
        "part",
        "session_message",
        "session_input",
        "event",
        "event_sequence",
      ]) {
        if (!(yield* tableExists(tx, table))) return
      }
      if (!(yield* hasColumns(tx, "message", ["id", "session_id", "time_created", "time_updated", "data"]))) return
      if (!(yield* hasColumns(tx, "part", ["id", "message_id", "session_id", "time_created", "time_updated", "data"])))
        return
      if (
        !(yield* hasColumns(tx, "session_message", [
          "id",
          "session_id",
          "type",
          "seq",
          "time_created",
          "time_updated",
          "data",
        ]))
      )
        return
      if (
        !(yield* hasColumns(tx, "session_input", [
          "id",
          "session_id",
          "prompt",
          "delivery",
          "admitted_seq",
          "promoted_seq",
          "time_created",
        ]))
      )
        return
      if (!(yield* hasColumns(tx, "event", ["id", "aggregate_id", "seq", "type", "data"]))) return
      if (!(yield* hasColumns(tx, "event_sequence", ["aggregate_id", "seq"]))) return

      const sessions = yield* tx.all<{ session_id: string }>(sql`
        SELECT DISTINCT m.session_id
        FROM ${sql.identifier("message")} m
        JOIN ${sql.identifier("session")} s ON s.id = m.session_id
        WHERE NOT EXISTS (
          SELECT 1 FROM ${sql.identifier("session_message")} sm WHERE sm.session_id = m.session_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${sql.identifier("event")} e
          WHERE e.aggregate_id = m.session_id AND e.type LIKE 'session.next.%'
        )
        ORDER BY m.session_id
      `)

      if (sessions.length === 0) return

      // Claim this repair inside the same transaction as the rewrite. The INSERT acquires
      // SQLite's writer lock before the potentially expensive legacy scan, and a crash rolls
      // the claim back so a later startup can safely retry. This also prevents every server
      // process from re-running the backfill forever after the first successful upgrade.
      yield* tx.run(sql`
        INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
        VALUES (${LEGACY_EVENT_BACKFILL_ID}, ${Date.now()})
      `)
      const claim = yield* tx.get<{ changes: number }>(sql`SELECT changes() AS changes`)
      if (claim?.changes !== 1) return

      for (const session of sessions) {
        yield* backfillLegacySession(tx, session.session_id)
      }
    }),
  )
}

function isRetryableDatabaseLock(error: unknown) {
  const seen = new Set<unknown>()
  const visit = (value: unknown): boolean => {
    if (value === null || value === undefined) return false
    if (typeof value === "string") return /database is locked|locktimeouterror/i.test(value)
    if (seen.has(value)) return false
    seen.add(value)
    if (value instanceof Error) {
      if (/database is locked|locktimeouterror/i.test(`${value.name} ${value.message}`)) return true
      return visit(value.cause)
    }
    return /database is locked|locktimeouterror/i.test(String(value))
  }
  return visit(error)
}

function backfillLegacySession(tx: Transaction, sessionID: string) {
  return Effect.gen(function* () {
    const messages = yield* tx.all<LegacyMessageRow>(sql`
      SELECT id, session_id, time_created, time_updated, data
      FROM ${sql.identifier("message")}
      WHERE session_id = ${sessionID}
      ORDER BY time_created, id
    `)
    const parts = yield* tx.all<LegacyPartRow>(sql`
      SELECT id, message_id, session_id, time_created, time_updated, data
      FROM ${sql.identifier("part")}
      WHERE session_id = ${sessionID}
      ORDER BY time_created, id
    `)
    const partsByMessage = new Map<string, LegacyPart[]>()
    for (const part of parts) {
      const value = recordFromJson(part.data)
      if (!value) continue
      partsByMessage.set(part.message_id, [...(partsByMessage.get(part.message_id) ?? []), { ...part, value }])
    }

    const events: BackfillEvent[] = []
    const projections: BackfillProjection[] = []
    const inputs: BackfillPromptInput[] = []
    const baseSeq = yield* legacyEventBaseSeq(tx, sessionID)
    const pushEvent = (type: string, version: number, data: Record<string, unknown>) => {
      const seq = baseSeq + events.length + 1
      events.push({ seq, type, version, data })
      return seq
    }

    for (const message of messages) {
      const value = recordFromJson(message.data)
      if (!value) continue
      const messageParts = partsByMessage.get(message.id) ?? []
      if (value.role === "user") {
        const prompt = legacyPrompt(value, messageParts)
        const timestamp = messageCreated(message, value)
        const seq = pushEvent("session.next.prompted", 1, {
          sessionID,
          timestamp,
          messageID: message.id,
          prompt,
          delivery: "steer",
        })
        inputs.push({ id: message.id, sessionID, seq, prompt, timeCreated: timestamp })
        projections.push({
          id: message.id,
          sessionID,
          type: "user",
          seq,
          timeCreated: timestamp,
          timeUpdated: timestamp,
          data: {
            time: { created: timestamp },
            text: prompt.text,
            files: prompt.files,
            agents: prompt.agents,
          },
        })
        continue
      }
      if (value.role === "assistant") {
        projections.push(backfillAssistantMessage(sessionID, message, value, messageParts, pushEvent))
      }
    }

    if (events.length === 0) return
    yield* tx.run(sql`
      INSERT INTO ${sql.identifier("event_sequence")} (aggregate_id, seq)
      VALUES (${sessionID}, ${events.at(-1)!.seq})
      ON CONFLICT(aggregate_id) DO UPDATE SET seq = excluded.seq
    `)
    for (const event of events) {
      yield* tx.run(sql`
        INSERT INTO ${sql.identifier("event")} (id, aggregate_id, seq, type, data)
        VALUES (
          ${`evt_backfill_${sessionID}_${event.seq}`},
          ${sessionID},
          ${event.seq},
          ${`${event.type}.${event.version}`},
          ${JSON.stringify(event.data)}
        )
      `)
    }
    for (const input of inputs) {
      yield* tx.run(sql`
        INSERT OR IGNORE INTO ${sql.identifier("session_input")}
          (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
        VALUES (${input.id}, ${input.sessionID}, ${JSON.stringify(input.prompt)}, 'steer', ${input.seq}, ${input.seq}, ${input.timeCreated})
      `)
    }
    for (const projection of projections) {
      yield* tx.run(sql`
        INSERT OR IGNORE INTO ${sql.identifier("session_message")}
          (id, session_id, type, seq, time_created, time_updated, data)
        VALUES (
          ${projection.id},
          ${projection.sessionID},
          ${projection.type},
          ${projection.seq},
          ${projection.timeCreated},
          ${projection.timeUpdated},
          ${JSON.stringify(projection.data)}
        )
      `)
    }
  })
}

function legacyEventBaseSeq(tx: Transaction, sessionID: string) {
  return Effect.gen(function* () {
    const row = yield* tx.get<{ seq: number | null }>(sql`
      SELECT MAX(seq) AS seq
      FROM (
        SELECT seq FROM ${sql.identifier("event_sequence")} WHERE aggregate_id = ${sessionID}
        UNION ALL
        SELECT seq FROM ${sql.identifier("event")} WHERE aggregate_id = ${sessionID}
      )
    `)
    return row?.seq ?? -1
  })
}

function backfillAssistantMessage(
  sessionID: string,
  message: LegacyMessageRow,
  value: Record<string, unknown>,
  parts: LegacyPart[],
  pushEvent: (type: string, version: number, data: Record<string, unknown>) => number,
): BackfillProjection {
  const created = messageCreated(message, value)
  const completed = messageCompleted(message, value)
  const agent = stringProperty(value, "agent") ?? "build"
  const model = legacyModelRef(value)
  const stepStart = parts.find((part) => part.value.type === "step-start")?.value
  const stepFinish = parts.findLast((part) => part.value.type === "step-finish")?.value
  const startSeq = pushEvent("session.next.step.started", 1, {
    sessionID,
    timestamp: created,
    assistantMessageID: message.id,
    agent,
    model,
    snapshot: stringProperty(stepStart, "snapshot"),
  })
  const content = parts.flatMap((part) => assistantContent(sessionID, message.id, part, pushEvent, created, completed))
  const finish = legacyFinish(value, stepFinish)
  const tokens = legacyTokens(recordProperty(value, "tokens") ?? recordProperty(stepFinish, "tokens"))
  const cost = numberProperty(value, "cost") ?? numberProperty(stepFinish, "cost") ?? 0
  const error = legacyError(recordProperty(value, "error"))
  pushEvent("session.next.step.ended", 2, {
    sessionID,
    timestamp: completed,
    assistantMessageID: message.id,
    finish,
    cost,
    tokens,
    snapshot: stringProperty(stepFinish, "snapshot"),
  })
  if (error) {
    pushEvent("session.next.step.failed", 2, {
      sessionID,
      timestamp: completed,
      assistantMessageID: message.id,
      error,
    })
  }
  return {
    id: message.id,
    sessionID,
    type: "assistant",
    seq: startSeq,
    timeCreated: created,
    timeUpdated: completed,
    data: {
      agent,
      model,
      time: { created, completed },
      content,
      snapshot: { start: stringProperty(stepStart, "snapshot"), end: stringProperty(stepFinish, "snapshot") },
      finish: error ? "error" : finish,
      cost,
      tokens,
      error,
    },
  }
}

function assistantContent(
  sessionID: string,
  assistantMessageID: string,
  part: LegacyPart,
  pushEvent: (type: string, version: number, data: Record<string, unknown>) => number,
  messageCreatedAt: number,
  messageCompletedAt: number,
): Record<string, unknown>[] {
  if (part.value.ignored === true) return []
  if (part.value.type === "text") {
    const text = stringProperty(part.value, "text") ?? ""
    const timestamp = partStart(part, messageCreatedAt)
    pushEvent("session.next.text.started", 1, { sessionID, timestamp, assistantMessageID, textID: part.id })
    pushEvent("session.next.text.ended", 1, {
      sessionID,
      timestamp: partEnd(part, messageCompletedAt),
      assistantMessageID,
      textID: part.id,
      text,
    })
    return [{ type: "text", id: part.id, text }]
  }
  if (part.value.type === "reasoning") {
    const text = stringProperty(part.value, "text") ?? ""
    const timestamp = partStart(part, messageCreatedAt)
    pushEvent("session.next.reasoning.started", 1, { sessionID, timestamp, assistantMessageID, reasoningID: part.id })
    pushEvent("session.next.reasoning.ended", 1, {
      sessionID,
      timestamp: partEnd(part, messageCompletedAt),
      assistantMessageID,
      reasoningID: part.id,
      text,
    })
    return [{ type: "reasoning", id: part.id, text }]
  }
  if (part.value.type === "custom") {
    const time = legacyPartTime(part)
    pushEvent("session.next.custom.added", 1, {
      sessionID,
      timestamp: time?.start ?? part.time_created,
      assistantMessageID,
      partID: part.id,
      kind: stringProperty(part.value, "kind") ?? "custom",
      data: part.value.data,
      title: stringProperty(part.value, "title"),
      fallback: stringProperty(part.value, "fallback"),
      metadata: recordProperty(part.value, "metadata"),
      time,
    })
    return [
      {
        type: "custom",
        id: part.id,
        kind: stringProperty(part.value, "kind") ?? "custom",
        data: part.value.data,
        title: stringProperty(part.value, "title"),
        fallback: stringProperty(part.value, "fallback"),
        metadata: recordProperty(part.value, "metadata"),
        time,
      },
    ]
  }
  if (part.value.type === "tool") {
    return [legacyToolContent(sessionID, assistantMessageID, part, pushEvent)]
  }
  return []
}

function legacyToolContent(
  sessionID: string,
  assistantMessageID: string,
  part: LegacyPart,
  pushEvent: (type: string, version: number, data: Record<string, unknown>) => number,
): Record<string, unknown> {
  const state = recordProperty(part.value, "state") ?? {}
  const tool = stringProperty(part.value, "tool") ?? "tool"
  const callID = stringProperty(part.value, "callID") ?? part.id
  const input = recordProperty(state, "input") ?? {}
  const raw = stringProperty(state, "raw") ?? JSON.stringify(input)
  const created = numberProperty(recordProperty(state, "time"), "start") ?? part.time_created
  pushEvent("session.next.tool.input.started", 1, {
    sessionID,
    timestamp: created,
    assistantMessageID,
    callID,
    name: tool,
  })
  pushEvent("session.next.tool.input.ended", 1, {
    sessionID,
    timestamp: created,
    assistantMessageID,
    callID,
    text: raw,
  })
  const base = { type: "tool", id: callID, name: tool, time: { created } }
  if (state.status === "pending") return { ...base, state: { status: "pending", input: raw } }

  pushEvent("session.next.tool.called", 1, {
    sessionID,
    timestamp: created,
    assistantMessageID,
    callID,
    tool,
    input,
    provider: { executed: false },
  })
  if (state.status === "completed") {
    const completed = numberProperty(recordProperty(state, "time"), "end") ?? part.time_updated
    const content = toolContent(state)
    const structured = recordProperty(state, "metadata") ?? {}
    pushEvent("session.next.tool.success", 1, {
      sessionID,
      timestamp: completed,
      assistantMessageID,
      callID,
      structured,
      content,
      result:
        stringProperty(state, "output") === undefined
          ? undefined
          : { type: "text", value: stringProperty(state, "output") },
      provider: { executed: false },
    })
    return {
      ...base,
      provider: { executed: false },
      time: { created, ran: created, completed },
      state: {
        status: "completed",
        input,
        structured,
        attachments: attachmentsFromLegacy(recordArray(state, "attachments")),
        content,
        outputPaths: [],
        result:
          stringProperty(state, "output") === undefined
            ? undefined
            : { type: "text", value: stringProperty(state, "output") },
      },
    }
  }
  if (state.status === "error") {
    const completed = numberProperty(recordProperty(state, "time"), "end") ?? part.time_updated
    const error = { type: "unknown", message: stringProperty(state, "error") ?? "Tool execution failed" }
    pushEvent("session.next.tool.failed", 1, {
      sessionID,
      timestamp: completed,
      assistantMessageID,
      callID,
      error,
      result: { type: "error", value: error.message },
      provider: { executed: false },
    })
    return {
      ...base,
      provider: { executed: false },
      time: { created, ran: created, completed },
      state: {
        status: "error",
        input,
        structured: recordProperty(state, "metadata") ?? {},
        content: [],
        error,
        result: { type: "error", value: error.message },
      },
    }
  }
  return {
    ...base,
    provider: { executed: false },
    time: { created, ran: created },
    state: { status: "running", input, structured: recordProperty(state, "metadata") ?? {}, content: [] },
  }
}

function legacyPrompt(message: Record<string, unknown>, parts: LegacyPart[]) {
  const text = parts
    .filter((part) => part.value.type === "text" && part.value.ignored !== true)
    .map((part) => stringProperty(part.value, "text"))
    .filter((part): part is string => part !== undefined)
    .join("\n\n")
  const files = parts.flatMap((part) => (part.value.type === "file" ? fileAttachment(part.value) : []))
  const agents = parts.flatMap((part) => (part.value.type === "agent" ? agentAttachment(part.value) : []))
  return {
    text,
    files: files.length > 0 ? files : undefined,
    agents: agents.length > 0 ? agents : undefined,
    agent: stringProperty(message, "agent"),
    model: legacyModelRef(recordProperty(message, "model")),
    system: stringProperty(message, "system"),
  }
}

function fileAttachment(value: Record<string, unknown>) {
  const uri = stringProperty(value, "url")
  const mime = stringProperty(value, "mime")
  if (!uri || !mime) return []
  return [
    {
      uri,
      mime,
      name: stringProperty(value, "filename"),
      source: sourceFromFile(recordProperty(value, "source")),
    },
  ]
}

function agentAttachment(value: Record<string, unknown>) {
  const name = stringProperty(value, "name")
  if (!name) return []
  return [{ name, source: sourceFromAgent(recordProperty(value, "source")) }]
}

function attachmentsFromLegacy(input: Record<string, unknown>[]) {
  return input.flatMap(fileAttachment)
}

function toolContent(state: Record<string, unknown>) {
  const text = stringProperty(state, "output")
  return [
    ...(text === undefined ? [] : [{ type: "text", text }]),
    ...attachmentsFromLegacy(recordArray(state, "attachments")).map((file) => ({
      type: "file",
      uri: file.uri,
      mime: file.mime,
      name: file.name,
    })),
  ]
}

function legacyModelRef(value: Record<string, unknown> | undefined) {
  return {
    id: stringProperty(value, "modelID") ?? stringProperty(value, "id") ?? "unknown",
    providerID: stringProperty(value, "providerID") ?? "unknown",
    variant: stringProperty(value, "variant"),
  }
}

function legacyTokens(value: Record<string, unknown> | undefined) {
  const cache = recordProperty(value, "cache")
  return {
    input: numberProperty(value, "input") ?? 0,
    output: numberProperty(value, "output") ?? 0,
    reasoning: numberProperty(value, "reasoning") ?? 0,
    cache: {
      read: numberProperty(cache, "read") ?? 0,
      write: numberProperty(cache, "write") ?? 0,
    },
  }
}

function legacyFinish(value: Record<string, unknown>, stepFinish: Record<string, unknown> | undefined) {
  return stringProperty(value, "finish") ?? stringProperty(stepFinish, "reason") ?? "stop"
}

function legacyError(value: Record<string, unknown> | undefined) {
  if (!value) return undefined
  const name = stringProperty(value, "name")
  const message = stringProperty(value, "message") ?? "Assistant step failed"
  return { type: "unknown", message: name ? `${name}: ${message}` : message }
}

function messageCreated(row: LegacyMessageRow, value: Record<string, unknown>) {
  return numberProperty(recordProperty(value, "time"), "created") ?? row.time_created
}

function messageCompleted(row: LegacyMessageRow, value: Record<string, unknown>) {
  return numberProperty(recordProperty(value, "time"), "completed") ?? row.time_updated
}

function partStart(part: LegacyPart, fallback: number) {
  return numberProperty(recordProperty(part.value, "time"), "start") ?? part.time_created ?? fallback
}

function partEnd(part: LegacyPart, fallback: number) {
  return numberProperty(recordProperty(part.value, "time"), "end") ?? part.time_updated ?? fallback
}

function legacyPartTime(part: LegacyPart) {
  const start = numberProperty(recordProperty(part.value, "time"), "start")
  if (start === undefined) return undefined
  return { start, end: numberProperty(recordProperty(part.value, "time"), "end") }
}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

function recordFromJson(input: string) {
  const decoded = Option.getOrUndefined(decodeJson(input))
  return isRecord(decoded) ? decoded : undefined
}

function recordProperty(value: Record<string, unknown> | undefined, key: string) {
  const property = value?.[key]
  return isRecord(property) ? property : undefined
}

function recordArray(value: Record<string, unknown>, key: string) {
  const property = value[key]
  return Array.isArray(property) ? property.filter(isRecord) : []
}

function stringProperty(value: Record<string, unknown> | undefined, key: string) {
  const property = value?.[key]
  return typeof property === "string" ? property : undefined
}

function numberProperty(value: Record<string, unknown> | undefined, key: string) {
  const property = value?.[key]
  return typeof property === "number" && Number.isFinite(property) ? property : undefined
}

function sourceFromFile(value: Record<string, unknown> | undefined) {
  return sourceFromText(recordProperty(value, "text"), "value")
}

function sourceFromAgent(value: Record<string, unknown> | undefined) {
  return sourceFromText(value, "value")
}

function sourceFromText(value: Record<string, unknown> | undefined, textKey: string) {
  const text = stringProperty(value, textKey)
  const start = numberProperty(value, "start")
  const end = numberProperty(value, "end")
  if (text === undefined || start === undefined || end === undefined) return undefined
  return { text, start, end }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function schemaStatements() {
  return Effect.gen(function* () {
    const statements: string[] = []
    const tx = {
      run(statement: string) {
        return Effect.sync(() => {
          statements.push(statement.trim())
        })
      },
    } as unknown as Transaction
    yield* schema.up(tx)
    return statements
  })
}

function parseTable(statement: string) {
  const match = statement.match(/^CREATE TABLE `([^`]+)` \(([\s\S]+)\);?$/)
  if (!match) return []
  return [
    {
      name: match[1],
      statement,
      columns: match[2]
        .split("\n")
        .map((line) => line.trim().replace(/,$/, ""))
        .flatMap((line) => {
          const column = line.match(/^`([^`]+)`\s+(.+)$/)
          if (!column) return []
          return [{ name: column[1], definition: line }]
        }),
    },
  ]
}

function parseIndex(statement: string) {
  const match = statement.match(/^CREATE (UNIQUE )?INDEX `([^`]+)` ON `([^`]+)` \(([^)]+)\)(?: WHERE ([\s\S]+?))?;?$/)
  if (!match) return []
  return [
    {
      unique: match[1] !== undefined,
      name: match[2],
      table: match[3],
      columns: Array.from(match[4].matchAll(/`([^`]+)`/g), (column) => column[1]),
      statement,
      where: match[5],
    },
  ]
}

function canAddColumn(definition: string) {
  if (/\bPRIMARY KEY\b/i.test(definition)) return false
  if (/\bUNIQUE\b/i.test(definition)) return false
  if (!/\bNOT NULL\b/i.test(definition)) return true
  return /\bDEFAULT\b/i.test(definition)
}

function tableExists(tx: Transaction, table: string) {
  return Effect.gen(function* () {
    return (
      (yield* tx.get<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
      )) !== undefined
    )
  })
}

function indexExists(tx: Transaction, index: string) {
  return Effect.gen(function* () {
    return (
      (yield* tx.get<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ${index}`,
      )) !== undefined
    )
  })
}

function tableColumns(tx: Transaction, table: string) {
  return Effect.gen(function* () {
    return new Set(
      (yield* tx.all<{ name: string }>(`PRAGMA table_info(${quoteString(table)})`)).map((column) => column.name),
    )
  })
}

function hasColumns(tx: Transaction, table: string, columns: string[]) {
  return Effect.gen(function* () {
    const existing = yield* tableColumns(tx, table)
    return columns.every((column) => existing.has(column))
  })
}

function hasDuplicateIndexRows(tx: Transaction, index: SchemaIndex) {
  if (index.columns.length === 0) return Effect.succeed(true)
  const columns = index.columns.map(identifier).join(", ")
  const presentColumns = index.columns.map((column) => `${identifier(column)} IS NOT NULL`).join(" AND ")
  const predicate = index.where === undefined ? presentColumns : `${presentColumns} AND (${index.where})`
  return Effect.gen(function* () {
    return (
      (yield* tx.get(
        `SELECT 1 FROM (SELECT ${columns} FROM ${identifier(index.table)} WHERE ${predicate} GROUP BY ${columns} HAVING COUNT(*) > 1) LIMIT 1`,
      )) !== undefined
    )
  })
}

function identifier(value: string) {
  return `\`${value.replaceAll("`", "``")}\``
}

function quoteString(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}
