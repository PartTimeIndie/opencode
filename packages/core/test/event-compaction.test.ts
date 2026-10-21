import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { copyFile, rename, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  compactEventDatabase,
  eventCompactionLockKey,
  requiredCompactionBytes,
  resetEventCompaction,
} from "../src/event-compaction"
import { decodeStoredEventData } from "../src/event"

const files: string[] = []

afterEach(async () => {
  await Promise.all(files.splice(0).map((file) => rm(file, { force: true })))
})

describe("event database compaction", () => {
  test("compresses historical event payloads, validates them, and retains a rollback database", async () => {
    const filename = join(tmpdir(), `opencode-event-compaction-${crypto.randomUUID()}.db`)
    files.push(filename)
    const payload = await createSampleDatabase(filename)
    // Any freshly written copy would carry a newer timestamp than the original.
    const originalStat = await stat(filename)
    await new Promise((resolve) => setTimeout(resolve, 25))

    const acquired: string[] = []
    const result = await compactEventDatabase(filename, {
      withLock: async (key, body) => {
        acquired.push(key)
        return body()
      },
    })
    files.push(result.backup)

    expect(acquired).toEqual([eventCompactionLockKey(filename)])
    expect(result.changed).toBe(1)
    expect(result.after.events).toBe(2)
    expect(result.after.dataBytes).toBeLessThan(result.before.dataBytes)
    expect(result.after.fileBytes).toBeLessThan(result.before.fileBytes)
    const compacted = new Database(filename, { readonly: true })
    const row = compacted.query<{ readonly data: string }, []>("SELECT data FROM event WHERE id = 'evt_large'").get()
    compacted.close()
    expect(row).toBeDefined()
    expect(decodeStoredEventData(JSON.parse(row!.data))).toEqual(payload)
    const rollback = new Database(result.backup, { readonly: true })
    const original = rollback.query<{ readonly data: string }, []>("SELECT data FROM event WHERE id = 'evt_large'").get()
    rollback.close()
    expect(JSON.parse(original!.data)).toEqual(payload)
    // The rollback is the renamed original, not a second full copy of it.
    expect((await stat(result.backup)).mtimeMs).toBe(originalStat.mtimeMs)
    expect(await Bun.file(`${filename}.event-compaction.json`).exists()).toBe(false)
  })

  test("completes a swap that crashed between its two renames", async () => {
    const source = join(tmpdir(), `opencode-event-compaction-${crypto.randomUUID()}.db`)
    const candidate = `${source}.event-compaction-crash.db`
    const output = `${source}.event-compaction-crash.final.db`
    const backup = `${source}.bak-event-compaction-crash`
    const checkpointPath = `${source}.event-compaction.json`
    files.push(source, candidate, output, backup, checkpointPath)
    const payload = await createSampleDatabase(source)
    // Crash state after the first rename: the original is parked at backup and
    // the validated output is still waiting to go live.
    await rename(source, backup)
    await copyFile(backup, output)
    await Bun.write(candidate, "stale candidate")
    await Bun.write(checkpointPath, JSON.stringify({ version: 1, source, candidate, output, backup, phase: "switch" }))

    const result = await compactEventDatabase(source)

    expect(result.before.events).toBe(2)
    expect(result.after.events).toBe(2)
    expectEventPayload(source, payload)
    expect(await Bun.file(backup).exists()).toBe(true)
    expect(await Bun.file(candidate).exists()).toBe(false)
    expect(await Bun.file(checkpointPath).exists()).toBe(false)
  })

  test("restores the original when the second swap rename fails", async () => {
    const source = join(tmpdir(), `opencode-event-compaction-${crypto.randomUUID()}.db`)
    const checkpoint = {
      version: 1 as const,
      source,
      candidate: `${source}.event-compaction-restore.db`,
      output: `${source}.event-compaction-restore.final.db`,
      backup: `${source}.bak-event-compaction-restore`,
      phase: "switch" as const,
    }
    const checkpointPath = `${source}.event-compaction.json`
    files.push(source, checkpoint.candidate, checkpoint.output, checkpoint.backup, checkpointPath)
    const payload = await createSampleDatabase(source)
    // The output intentionally does not exist, so activating it fails with a
    // permanent ENOENT right after the original moved to backup.
    await Bun.write(checkpointPath, JSON.stringify(checkpoint))

    await expect(compactEventDatabase(source)).rejects.toThrow("restored from")

    expectEventPayload(source, payload)
    expect(await Bun.file(checkpoint.backup).exists()).toBe(false)
    expect(await Bun.file(checkpointPath).exists()).toBe(true)

    // The retained checkpoint lets a retry finish the swap once output exists.
    await copyFile(source, checkpoint.output)
    const result = await compactEventDatabase(source)
    expect(result.after.events).toBe(2)
    expect(await Bun.file(checkpoint.backup).exists()).toBe(true)
    expect(await Bun.file(checkpointPath).exists()).toBe(false)
    expectEventPayload(checkpoint.backup, payload)
  })

  test("reset puts a parked original back before deleting staging files", async () => {
    const source = join(tmpdir(), `opencode-event-compaction-${crypto.randomUUID()}.db`)
    const candidate = `${source}.event-compaction-reset.db`
    const output = `${source}.event-compaction-reset.final.db`
    const backup = `${source}.bak-event-compaction-reset`
    const checkpointPath = `${source}.event-compaction.json`
    files.push(source, candidate, output, backup, checkpointPath)
    const payload = await createSampleDatabase(source)
    await rename(source, backup)
    await copyFile(backup, output)
    await Bun.write(candidate, "stale candidate")
    await Bun.write(checkpointPath, JSON.stringify({ version: 1, source, candidate, output, backup, phase: "switch" }))

    await resetEventCompaction(source)

    expectEventPayload(source, payload)
    expect(await Bun.file(backup).exists()).toBe(false)
    expect(await Bun.file(candidate).exists()).toBe(false)
    expect(await Bun.file(output).exists()).toBe(false)
    expect(await Bun.file(checkpointPath).exists()).toBe(false)
  })
})

describe("requiredCompactionBytes", () => {
  const HEADROOM = 64 * 1024 * 1024
  // Production shape: a 4.72 GiB database whose freelist holds 65.3% of its
  // pages, on a volume with only ~4.88 GiB free.
  const production = { liveBytes: Math.round(4.72 * 2 ** 30 * 0.347), batchBytes: 250 * 512 * 1024, batchRows: 250, pageSize: 4096 }
  const journal = (batchBytes: number, batchRows: number, pageSize: number) => batchBytes + batchRows * 2 * pageSize

  test("fits a fresh production-sized run that the old source*3+2GiB check rejected", () => {
    const required = requiredCompactionBytes({ phase: "copy", candidateExists: false, outputExists: false, ...production })
    expect(required).toBe(production.liveBytes * 2 + journal(production.batchBytes, production.batchRows, production.pageSize))
    expect(required).toBeGreaterThan(production.liveBytes * 2)
    expect(required).toBeLessThan(4.88 * 2 ** 30)
  })

  test("bounds a resumed run by the one artifact still missing", () => {
    const compressing = requiredCompactionBytes({ phase: "compress", candidateExists: true, outputExists: false, ...production })
    expect(compressing).toBe(production.liveBytes + journal(production.batchBytes, production.batchRows, production.pageSize))
    const validating = requiredCompactionBytes({ phase: "validate", candidateExists: true, outputExists: false, ...production })
    expect(validating).toBe(production.liveBytes + HEADROOM)
  })

  test("needs no artifact space once the validated output exists", () => {
    expect(requiredCompactionBytes({ phase: "switch", candidateExists: true, outputExists: true, liveBytes: production.liveBytes })).toBe(HEADROOM)
  })

  test("reserves journal room for a batch of the largest event rows", () => {
    const hugeRows = requiredCompactionBytes({
      phase: "copy",
      candidateExists: false,
      outputExists: false,
      liveBytes: 2 ** 30,
      batchBytes: 64 * 1024 * 1024,
      batchRows: 1,
      pageSize: 4096,
    })
    expect(hugeRows).toBe(2 ** 30 * 2 + journal(64 * 1024 * 1024, 1, 4096))
    const tinyRows = requiredCompactionBytes({ phase: "copy", candidateExists: false, outputExists: false, liveBytes: 4096, batchBytes: 0, batchRows: 0, pageSize: 4096 })
    expect(tinyRows).toBe(4096 * 2 + HEADROOM)
  })
})

async function createSampleDatabase(filename: string) {
  const payload = { text: "repeatable historical event ".repeat(20_000) }
  const database = new Database(filename)
  database.exec("CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL)")
  database.exec("CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id), seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)")
  database.run("INSERT INTO event_sequence VALUES (?, ?)", ["session:one", 1])
  database.run("INSERT INTO event VALUES (?, ?, ?, ?, ?)", ["evt_large", "session:one", 0, "message.part.updated.1", JSON.stringify(payload)])
  database.run("INSERT INTO event VALUES (?, ?, ?, ?, ?)", ["evt_small", "session:one", 1, "message.part.updated.1", JSON.stringify({ text: "small" })])
  database.close()
  return payload
}

function expectEventPayload(filename: string, payload: { readonly text: string }) {
  const database = new Database(filename, { readonly: true })
  try {
    const row = database.query<{ readonly data: string }, []>("SELECT data FROM event WHERE id = 'evt_large'").get()
    expect(row).toBeDefined()
    expect(JSON.parse(row!.data)).toEqual(payload)
  } finally {
    database.close()
  }
}
