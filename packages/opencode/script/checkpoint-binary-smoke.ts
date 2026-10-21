#!/usr/bin/env bun

import { Database as Sqlite } from "bun:sqlite"
import { Effect, Layer } from "effect"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"

const requestedBinary = process.argv[2]
if (!requestedBinary) throw new Error("checkpoint binary smoke requires the compiled OpenCode binary path")
const binary = (await Bun.file(path.resolve(requestedBinary)).exists())
  ? path.resolve(requestedBinary)
  : path.resolve(`${requestedBinary}.exe`)
if (!(await Bun.file(binary).exists())) throw new Error(`compiled OpenCode binary does not exist: ${binary}`)

const root = await mkdtemp(path.join(tmpdir(), "opencode-checkpoint-binary-smoke-"))
const databasePath = path.join(root, "candidate.db")
const archiveDirectory = path.join(root, "archives")
const progressPath = path.join(root, "progress.json")
const inputPath = path.join(root, "worker.json")
const sessionID = SessionSchema.ID.make("ses_checkpoint_binary_smoke")

await mkdir(archiveDirectory, { recursive: true })

try {
  const database = Database.layerFromPath(databasePath)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const service = yield* EventV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make(root), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* service.publish(SessionV1.Event.Created, {
        sessionID,
        info: {
          id: sessionID,
          slug: sessionID,
          projectID: ProjectV2.ID.global,
          directory: root,
          title: "compiled checkpoint smoke",
          version: "test",
          time: { created: Date.now(), updated: Date.now() },
        },
      })
    }).pipe(Effect.provide(Layer.mergeAll(database, events, projector)), Effect.scoped),
  )

  await Bun.write(
    inputPath,
    JSON.stringify({
      input: {
        mode: "prepare",
        databaseKind: "production",
        paths: {
          sourceDatabase: databasePath,
          migrationSourceDatabase: databasePath,
          stagingDirectory: root,
          candidateDatabase: databasePath,
          candidateBlobDirectory: path.join(root, "content"),
          candidateArchiveDirectory: archiveDirectory,
          liveBlobDirectory: path.join(root, "live-content"),
          liveArchiveDirectory: path.join(root, "live-archives"),
          journalPath: path.join(root, "journal.json"),
          activationManifestPath: path.join(root, "activation.json"),
          quarantineRequirementPath: path.join(root, "quarantine.json"),
        },
        config: { inactiveMs: Number.MAX_SAFE_INTEGER, maxShardBytes: 2_000_000_000 },
      },
      checkpointedSessions: 0,
      archivedSessions: 0,
      progressPath,
    }),
  )

  const child = Bun.spawn([binary, "storage", "session-worker", inputPath], {
    stdout: "ignore",
    stderr: "pipe",
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(stderr.trim() || `compiled checkpoint smoke exited ${exitCode}`)

  const sqlite = new Sqlite(databasePath, { readonly: true, strict: true })
  const checkpoint = sqlite
    .query<
      { readonly seq: number; readonly version: number; readonly data: string },
      [string]
    >("SELECT seq, version, data FROM event_checkpoint WHERE aggregate_id = ?")
    .get(sessionID)
  const remaining = sqlite
    .query<{ readonly count: number }, [string]>("SELECT count(*) AS count FROM event WHERE aggregate_id = ?")
    .get(sessionID)?.count
  sqlite.close()
  if (!checkpoint) throw new Error("compiled checkpoint smoke did not create a baseline")
  if (checkpoint.version !== EventV2.CheckpointVersion)
    throw new Error("compiled checkpoint smoke used the wrong version")
  const data = JSON.parse(checkpoint.data) as { readonly baseline?: { readonly adapter?: string } }
  if (data.baseline?.adapter !== "session-v2-projection")
    throw new Error("compiled checkpoint smoke did not persist the SessionV2 projection baseline")
  if (remaining !== 0) throw new Error(`compiled checkpoint smoke retained ${remaining} compacted event rows`)
  const progress = (await Bun.file(progressPath).json()) as {
    readonly checkpointedSessions: number
    readonly archivedSessions: number
  }
  if (progress.checkpointedSessions !== 1 || progress.archivedSessions !== 0)
    throw new Error(`compiled checkpoint smoke reported unexpected progress: ${JSON.stringify(progress)}`)
  process.stdout.write(`${JSON.stringify({ checkpoint: checkpoint.seq, deletedPrefix: true })}\n`)
} finally {
  await remove(root)
}

async function remove(directory: string, attempt = 0): Promise<void> {
  return rm(directory, { recursive: true, force: true }).catch(async (cause) => {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EBUSY" || attempt >= 20) throw cause
    await Bun.sleep(100)
    return remove(directory, attempt + 1)
  })
}
