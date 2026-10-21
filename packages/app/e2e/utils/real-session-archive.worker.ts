import { Database } from "@opencode-ai/core/database/database"
import { SessionArchive } from "@opencode-ai/core/session-archive"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Effect } from "effect"
import { stat } from "node:fs/promises"
import path from "node:path"

type TimelinePart = Record<string, unknown> & { id: string }
type TimelineMessage = {
  info: Record<string, unknown> & {
    id: string
    role: "user" | "assistant"
    time: { created: number; completed?: number }
  }
  parts: TimelinePart[]
}

type Input = {
  session: Record<string, unknown> & {
    id: string
    projectID: string
    directory: string
    slug: string
    title: string
    version: string
  }
  messages: TimelineMessage[]
}

const command = process.argv[2]
const root = process.argv[3]
const filename = path.join(root, "active.sqlite")
const archives = path.join(root, "archives")
const now = Date.UTC(2026, 6, 13, 12)

// The result must reach the parent's pipe buffer before the process exits:
// a fire-and-forget write can be cut off mid-stream on process teardown,
// which the parent would see as a truncated payload.
const payload = `__OPENCODE_ARCHIVE_RESULT__${JSON.stringify(await main())}\n`
await new Promise<void>((resolve, reject) =>
  process.stdout.write(payload, (error) => (error ? reject(error) : resolve())),
)

async function main() {
  if (command === "create") {
    const input = (await Bun.file(path.join(root, "input.json")).json()) as Input
    const modified = now - 10 * 24 * 60 * 60 * 1_000
    await initialize()
    await seed(input, modified)
    await useArchive((archive) =>
      Effect.gen(function* () {
        yield* archive.initialize
        yield* archive.refreshCatalog(SessionSchema.ID.make(input.session.id))
        const archived = yield* archive.archiveOne(SessionSchema.ID.make(input.session.id))
        if (!archived) return yield* Effect.die("Real archive fixture did not produce an archive shard")
      }),
    )
    return inspect(input.session.id)
  }
  if (command === "page") return readPage(process.argv[4], Number(process.argv[5]), process.argv[6] || undefined)
  if (command === "catalog") return useArchive((archive) => archive.listCatalog({ limit: 500 }))
  if (command === "inspect") return inspect(process.argv[4])
  throw new Error(`Unknown real archive worker command: ${command}`)
}

async function initialize() {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Database.Service
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
}

async function seed(input: Input, modified: number) {
  const sqlite = await import("bun:sqlite")
  const database = new sqlite.Database(filename)
  database.run("PRAGMA foreign_keys = ON")
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO project(id, worktree, vcs, name, sandboxes, time_created, time_updated)
         VALUES (?, ?, 'git', ?, '[]', ?, ?)`,
      )
      .run(input.session.projectID, input.session.directory, input.session.title, modified, modified)
    database
      .prepare(
        `INSERT INTO session(
           id, project_id, slug, directory, title, version, cost,
           tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
           time_created, time_updated
         ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?)`,
      )
      .run(
        input.session.id,
        input.session.projectID,
        input.session.slug,
        input.session.directory,
        input.session.title,
        input.session.version,
        modified,
        modified,
      )
    const legacyMessage = database.prepare(
      "INSERT INTO message(id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    )
    const legacyPart = database.prepare(
      "INSERT INTO part(id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    )
    const projectedMessage = database.prepare(
      `INSERT INTO session_message(id, session_id, type, seq, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const promotedInput = database.prepare(
      `INSERT INTO session_input(id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
       VALUES (?, ?, ?, 'steer', ?, ?, ?)`,
    )
    input.messages.forEach((message, seq) => {
      const created = message.info.time.created
      const updated = message.info.time.completed ?? created
      legacyMessage.run(
        message.info.id,
        input.session.id,
        created,
        updated,
        JSON.stringify(without(message.info, ["id", "sessionID"])),
      )
      message.parts.forEach((part, index) =>
        legacyPart.run(
          part.id,
          message.info.id,
          input.session.id,
          created + index,
          updated,
          JSON.stringify(without(part, ["id", "sessionID", "messageID"])),
        ),
      )
      projectedMessage.run(
        `v2_${message.info.id}`,
        input.session.id,
        message.info.role,
        seq,
        created,
        updated,
        JSON.stringify({ text: `archived ${message.info.role} ${seq}` }),
      )
      if (message.info.role !== "user") return
      const admitted = Math.floor(seq / 2)
      promotedInput.run(
        `input_${message.info.id}`,
        input.session.id,
        JSON.stringify({ text: `archived prompt ${admitted}` }),
        admitted,
        admitted,
        created,
      )
    })
  })()
  database.close()
}

function without(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

async function readPage(sessionID: string, limit: number, before?: string) {
  return useArchive((archive) =>
    Effect.gen(function* () {
      const page = yield* archive.readLegacyMessages(SessionSchema.ID.make(sessionID), {
        ...(before ? { before: decodeCursor(before) } : {}),
        limit,
      })
      return {
        items: page.items
          .map((item) => ({
            info: restore(item.message, ["id", "session_id"], ["id", "sessionID"]),
            parts: item.parts.map((part) =>
              restore(part, ["id", "session_id", "message_id"], ["id", "sessionID", "messageID"]),
            ),
          }))
          .reverse(),
        ...(page.cursor ? { cursor: encodeCursor(page.cursor) } : {}),
      }
    }),
  )
}

function restore(row: Readonly<Record<string, unknown>>, source: string[], target: string[]) {
  const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data
  return {
    ...((data ?? {}) as Record<string, unknown>),
    ...Object.fromEntries(source.map((key, index) => [target[index], row[key]])),
  }
}

function encodeCursor(cursor: { readonly id: string; readonly time: number }) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url")
}

function decodeCursor(cursor: string) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id: string; time: number }
}

function useArchive<A, E>(effect: (archive: SessionArchive.Interface) => Effect.Effect<A, E>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const archive = yield* SessionArchive.make({
        directory: archives,
        now: () => now,
        isIdle: () => Effect.succeed(true),
      })
      yield* archive.initialize
      return yield* effect(archive)
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
}

async function inspect(sessionID: string) {
  const sqlite = await import("bun:sqlite")
  const database = new sqlite.Database(filename, { readonly: true })
  const catalog = database
    .query<{ location: string; revision: number; shard_id: string }, [string]>(
      "SELECT location, revision, shard_id FROM session_archive_catalog WHERE session_id = ?",
    )
    .get(sessionID)
  if (!catalog) return Promise.reject(new Error(`Archive catalog is missing ${sessionID}`))
  const shard = database
    .query<{ path: string; session_count: number }, [string]>(
      "SELECT path, session_count FROM session_archive_shard WHERE id = ?",
    )
    .get(catalog.shard_id)
  if (!shard) return Promise.reject(new Error(`Archive shard is missing ${catalog.shard_id}`))
  const activeSessionCount = database
    .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM session WHERE id = ?")
    .get(sessionID)!.count
  database.close()
  const shardDatabase = new sqlite.Database(shard.path, { readonly: true })
  const archivedMessageCount = shardDatabase
    .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM archive_session_message WHERE session_id = ?")
    .get(sessionID)!.count
  const archivedLegacyMessageCount = shardDatabase
    .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM archive_legacy_message WHERE session_id = ?")
    .get(sessionID)!.count
  shardDatabase.close()
  return {
    location: catalog.location,
    revision: catalog.revision,
    sessionCount: shard.session_count,
    activeSessionCount,
    shardPath: shard.path,
    shardBytes: (await stat(shard.path)).size,
    archivedMessageCount,
    archivedLegacyMessageCount,
  }
}
