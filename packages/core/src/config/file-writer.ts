export * as ConfigFileWriter from "./file-writer"

import { createHash, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { EffectFlock } from "../util/effect-flock"

export type Snapshot = { readonly file: string; readonly text: string | undefined; readonly version: string; readonly mode: number | undefined }
export class Conflict extends Schema.TaggedErrorClass<Conflict>()("ConfigFileWriter.Conflict", {
  file: Schema.String,
  reason: Schema.Literals(["version", "placement", "readback"]),
}) {
  override get message() { return `Configuration changed (${this.reason}); read it again before saving` }
}
export class IO extends Schema.TaggedErrorClass<IO>()("ConfigFileWriter.IO", { file: Schema.String }) {
  override get message() { return "Configuration could not be read or saved" }
}
export type Error = Conflict | IO | EffectFlock.LockError

export interface Interface {
  readonly read: (file: string) => Effect.Effect<Snapshot, IO>
  readonly update: <A, E, R>(input: { readonly file: string; readonly expectedVersion?: string },
    prepare: (current: Snapshot) => Effect.Effect<{ readonly text: string; readonly value: A }, E, R>) =>
    Effect.Effect<{ readonly value: A; readonly snapshot: Snapshot; readonly changed: boolean }, E | Error, R>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/ConfigFileWriter") {}

const io = <A>(file: string, operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: () => new IO({ file }) })

// Resolve existing ancestors without conflating Windows case-sensitive paths.
// This is the same native spelling boundary used by LocationMutation.
async function canonical(file: string): Promise<string> {
  const absolute = path.resolve(file)
  const missing: string[] = []
  for (let current = absolute; ; current = path.dirname(current)) {
    const existing = await fs.realpath(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (existing !== undefined) {
      const physical = process.platform === "win32" ? realpathSync.native(existing) : existing
      return path.join(physical, ...missing.reverse())
    }
    const parent = path.dirname(current)
    if (parent === current) throw new Error("No physical configuration ancestor")
    missing.push(path.basename(current))
  }
}

async function snapshot(file: string): Promise<Snapshot> {
  const bytes = await fs.readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  const mode = bytes === undefined ? undefined : (await fs.stat(file)).mode & 0o777
  return { file, text: bytes?.toString("utf8"), mode,
    version: createHash("sha256").update(bytes === undefined ? "missing:" : `present:${mode}:`).update(bytes ?? "").digest("hex") }
}

/** Shared by settings and scoped language edits. The lock covers read, prepare,
 * compare, publish and readback across processes. It is not a permission grant
 * or a lock against arbitrary external editors. No retry after uncertain IO. */
export const layer = Layer.effect(Service, Effect.gen(function* () {
  const flock = yield* EffectFlock.Service
  const read: Interface["read"] = (file) => io(file, async () => snapshot(await canonical(file)))
  const update: Interface["update"] = (request, prepare) => Effect.gen(function* () {
    const input = { ...request }
    const file = yield* io(input.file, () => canonical(input.file))
    return yield* flock.withLock(Effect.gen(function* () {
      if ((yield* io(input.file, () => canonical(input.file))) !== file)
        return yield* new Conflict({ file, reason: "placement" })
      const before = Object.freeze(yield* io(file, () => snapshot(file)))
      if (input.expectedVersion !== undefined && before.version !== input.expectedVersion)
        return yield* new Conflict({ file, reason: "version" })
      const prepared = { ...yield* prepare(before) }
      // Preparation may await validation. An outside editor does not obey our
      // lock, so recheck both placement and bytes before publishing anything.
      if ((yield* io(input.file, () => canonical(input.file))) !== file)
        return yield* new Conflict({ file, reason: "placement" })
      if ((yield* io(file, () => snapshot(file))).version !== before.version)
        return yield* new Conflict({ file, reason: "version" })
      if (prepared.text === before.text) return { value: prepared.value, snapshot: before, changed: false }
      yield* Effect.uninterruptible(io(file, async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        const temporary = `${file}.opencode-config-${randomUUID()}`
        try {
          await fs.writeFile(temporary, prepared.text, { flag: "wx", mode: before.mode ?? 0o600 })
          if (before.mode !== undefined) await fs.chmod(temporary, before.mode)
          await fs.rename(temporary, file)
        } finally {
          await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
          })
        }
      }))
      const after = yield* io(file, () => snapshot(file))
      if (after.text !== prepared.text || (before.mode !== undefined && after.mode !== before.mode))
        return yield* new Conflict({ file, reason: "readback" })
      return { value: prepared.value, snapshot: after, changed: true }
    }), `config-file:${file}`)
  })
  return Service.of({ read, update })
}))
