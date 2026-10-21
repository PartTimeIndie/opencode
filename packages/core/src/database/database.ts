export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { LayerNode } from "../effect/layer-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults({ transactionTimeoutMs: 4_000 })
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export type LayerOptions = {
  readonly deferStartupRepairs?: boolean
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

function makeLayer(deferStartupRepairs: boolean) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* makeDatabase
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA cache_size = -64000")
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA busy_timeout = 30000")
      yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
      // Legacy event backfill is an explicit maintenance operation. Running it in
      // the server startup fiber can block Bun's event loop while another process
      // owns SQLite's writer lock, so it must never be scheduled automatically.
      yield* DatabaseMigration.apply(db, { deferLegacyEventBackfill: true, deferStartupRepairs })

      return { db }
    }).pipe(Effect.orDie),
  )
}

const deferStartupRepairs = () => process.env.OPENCODE_DEFER_DB_STARTUP_REPAIRS === "1"

export const layer = makeLayer(deferStartupRepairs())

export function layerFromPath(filename: string, options: LayerOptions = {}) {
  const defer = options.deferStartupRepairs ?? deferStartupRepairs()
  // Deferring repairs must not defer registered migrations or disable WAL. The
  // desktop sidecar uses this path while another process may still be writing.
  return makeLayer(defer).pipe(Layer.provide(sqliteLayer({ filename })))
}

export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "opencode.db")
  return join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

export const defaultLayer = Layer.unwrap(
  Effect.gen(function* () {
    return layerFromPath(path())
  }),
).pipe(Layer.provide(Global.defaultLayer))

export const node = LayerNode.make(defaultLayer, [])
