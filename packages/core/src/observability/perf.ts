export * as Perf from "./perf"

import { appendFile, mkdir, rename, rm, stat } from "fs/promises"
import path from "path"
import { Effect, Option } from "effect"
import { Config } from "../config"
import { ConfigLogging } from "../config/logging"
import { Global } from "../global"
import { runID } from "./shared"

export type Feature = keyof ConfigLogging.FeatureSettings
export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue }
export type Event = { readonly kind: string; readonly source?: string } & Record<string, unknown>

const MAX_BYTES = 20 * 1024 * 1024
const ROTATIONS = 3
const queue = { current: Promise.resolve() }

export function record(event: Event, feature: Feature = "performance") {
  return recordBatch([event], feature)
}

export function recordBatch(events: ReadonlyArray<Event>, feature: Feature = "performance") {
  if (events.length === 0) return Effect.void
  return enabled(feature).pipe(
    Effect.flatMap((active) =>
      active
        ? Effect.tryPromise(() => enqueue(() => write(events))).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to write performance log", {
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          )
        : Effect.void,
    ),
  )
}

function enabled(feature: Feature) {
  return Effect.gen(function* () {
    const config = yield* Effect.serviceOption(Config.Service)
    const entries = Option.isSome(config)
      ? yield* config.value.entries().pipe(Effect.catch(() => Effect.succeed([] as Config.Entry[])))
      : []
    const logging = ConfigLogging.resolve(entries)
    return logging.features.performance && logging.features[feature]
  })
}

async function write(events: ReadonlyArray<Event>) {
  await mkdir(Global.Path.log, { recursive: true })
  await rotateIfNeeded(path.join(Global.Path.log, "perf.jsonl"))
  await appendFile(
    path.join(Global.Path.log, "perf.jsonl"),
    events.map((event) => JSON.stringify(enrich(event))).join("\n") + "\n",
    "utf8",
  )
}

function enrich(event: Event) {
  return sanitize({ ts: new Date().toISOString(), run: runID, source: event.source ?? "core", ...event })
}

async function rotateIfNeeded(file: string) {
  const info = await stat(file).catch((error) => {
    if (code(error) === "ENOENT") return undefined
    throw error
  })
  if (!info || info.size < MAX_BYTES) return
  await Array.from({ length: ROTATIONS }, (_, index) => ROTATIONS - index).reduce(async (previous, index) => {
    await previous
    const from = index === 1 ? file : `${file}.${index - 1}`
    const to = `${file}.${index}`
    if (index === ROTATIONS) await rm(to, { force: true })
    await rename(from, to).catch((error) => {
      if (code(error) !== "ENOENT") throw error
    })
  }, Promise.resolve())
}

function enqueue(task: () => Promise<void>) {
  const next = queue.current.then(task, task)
  queue.current = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function sanitize(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen))
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]"
    seen.add(value)
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry) => entry[1] !== undefined && typeof entry[1] !== "function" && typeof entry[1] !== "symbol")
        .map(([key, item]) => [key, sanitize(item, seen)]),
    )
  }
  return String(value)
}

function code(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code
}
