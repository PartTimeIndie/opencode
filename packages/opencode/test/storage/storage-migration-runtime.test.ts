import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CONTENT_MIGRATION_VERSION } from "@opencode-ai/core/content-migration"
import { STORAGE_MIGRATION_VERSION } from "@opencode-ai/core/storage-migration"
import { StorageMigrationRuntime } from "../../src/storage-migration-runtime"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => remove(root)))
}, 20_000)

describe("storage migration runtime", () => {
  test("reports idle before the first dry-run", async () => {
    const root = await createRoot()
    const runtime = StorageMigrationRuntime.make({ data: root })
    expect(await runtime.status()).toEqual({ state: "idle", databaseKind: "production" })
    expect(await runtime.status("local")).toEqual({ state: "idle", databaseKind: "local" })
  })

  test("supersedes an older failed dry-run with a completed activation receipt", async () => {
    const root = await createRoot()
    await Bun.write(
      path.join(root, "storage-migration-runtime.json"),
      JSON.stringify({
        state: "failed",
        id: "out-of-space-dry-run",
        updatedAt: 100,
        message: "not enough free space",
        resumable: true,
      }),
    )
    const stagingDirectory = await writeCompletedActivation(root, "production", 200)

    expect(await StorageMigrationRuntime.make({ data: root }).status()).toMatchObject({
      state: "completed",
      databaseKind: "production",
      id: "production-activation",
      stagingDirectory,
      updatedAt: 200,
      message: "Storage migration activated successfully",
      report: { savedBytes: 65, archivedSessions: 2, checkpointedSessions: 3 },
      resumable: false,
    })
    expect(JSON.parse(await readFile(path.join(root, "storage-migration-runtime.json"), "utf8"))).toMatchObject({
      state: "completed",
      id: "production-activation",
      updatedAt: 200,
    })
  })

  test("keeps a newer dry-run failure visible after an older activation", async () => {
    const root = await createRoot()
    await writeCompletedActivation(root, "production", 100)
    await Bun.write(
      path.join(root, "storage-migration-runtime.json"),
      JSON.stringify({ state: "failed", id: "new-failure", updatedAt: 200, message: "new failure", resumable: true }),
    )

    expect(await StorageMigrationRuntime.make({ data: root }).status()).toMatchObject({
      state: "failed",
      id: "new-failure",
      updatedAt: 200,
    })
  })

  test("records a completed local activation for future status reads", async () => {
    const root = await createRoot()
    const stagingDirectory = await writeCompletedActivation(root, "local", 300)
    const runtime = StorageMigrationRuntime.make({ data: root })

    expect(await runtime.recordActivation("local", stagingDirectory)).toMatchObject({
      state: "completed",
      databaseKind: "local",
      id: "local-activation",
    })
    expect(await runtime.status("local")).toMatchObject({
      state: "completed",
      databaseKind: "local",
      updatedAt: 300,
    })
  })

  test("records a completed rollback without reporting stale migration savings", async () => {
    const root = await createRoot()
    const stagingDirectory = await writeCompletedActivation(root, "production", 300)
    await Bun.write(
      path.join(stagingDirectory, "storage-rollback-production-activation.json"),
      JSON.stringify({
        kind: "opencode-storage-rollback",
        manifestID: "production-activation",
        events: [{ state: "completed", time: 400 }],
      }),
    )
    const runtime = StorageMigrationRuntime.make({ data: root })

    const status = await runtime.recordRollback("production", stagingDirectory)
    expect(status).toMatchObject({
      state: "completed",
      databaseKind: "production",
      id: "production-activation",
      updatedAt: 400,
      message: "Storage migration rollback completed successfully",
    })
    expect(status.report).toBeUndefined()
    expect(await runtime.status()).toMatchObject({
      state: "completed",
      updatedAt: 400,
      message: "Storage migration rollback completed successfully",
    })
  })

  test("turns a stale running worker into a resumable failure", async () => {
    const root = await createRoot()
    await Bun.write(
      path.join(root, "storage-migration-runtime.json"),
      JSON.stringify({
        state: "running",
        id: "dry-run",
        pid: 999_999_999,
        stagingDirectory: path.join(root, "staging"),
        snapshotDirectory: path.join(root, "snapshot"),
      }),
    )
    expect(await StorageMigrationRuntime.make({ data: root }).status()).toMatchObject({
      state: "failed",
      id: "dry-run",
      resumable: true,
    })
  })

  test("resumes a stale running worker without requiring a status poll", async () => {
    const root = await createRoot()
    const stagingDirectory = path.join(root, "storage-migrations", "interrupted-candidate")
    await mkdir(stagingDirectory, { recursive: true })
    await Promise.all([
      Bun.write(
        path.join(stagingDirectory, "content-migration-manifest.json"),
        JSON.stringify({ engineVersion: CONTENT_MIGRATION_VERSION }),
      ),
      Bun.write(
        path.join(stagingDirectory, "storage-migration-journal.json"),
        JSON.stringify({ version: STORAGE_MIGRATION_VERSION }),
      ),
      Bun.write(
        path.join(root, "storage-migration-runtime.json"),
        JSON.stringify({
          state: "running",
          id: "interrupted-run",
          pid: 999_999_999,
          stagingDirectory,
          snapshotDirectory: path.join(root, "interrupted-snapshot"),
          startedAt: 1,
          resumable: true,
        }),
      ),
    ])
    const runtime = StorageMigrationRuntime.make({
      data: root,
      spawn: () => ({
        pid: process.pid,
        exited: Promise.resolve(0),
        stdout: stream(JSON.stringify({ report: {} })),
        stderr: stream(""),
      }),
    })

    const started = await runtime.startDryRun()
    expect(started).toMatchObject({
      state: "running",
      id: "interrupted-run",
      stagingDirectory,
      snapshotDirectory: path.join(root, "interrupted-snapshot"),
      startedAt: 1,
      message: "Resuming the production storage migration dry-run",
    })
    await eventually(runtime.status, (value) => value.state === "completed")
  })

  test("captures progress and the completed report without activating it", async () => {
    const root = await createRoot()
    const report = {
      sourceBytes: 100,
      activeDatabaseBytes: 20,
      archiveBytes: 10,
      blobBytes: 5,
      candidateBytes: 35,
      savedBytes: 65,
      savedRatio: 0.65,
      checkpointedSessions: 3,
      archivedSessions: 2,
      activeSessions: 1,
      quarantineCount: 0,
      content: {},
    }
    const runtime = StorageMigrationRuntime.make({
      data: root,
      spawn: () => ({
        pid: process.pid,
        exited: Promise.resolve(0),
        stdout: stream(JSON.stringify({ report })),
        stderr: stream(`${JSON.stringify({ message: "Checkpointing sessions" })}\n`),
      }),
    })
    expect((await runtime.startDryRun()).state).toBe("running")
    const completed = await eventually(runtime.status, (value) => value.state === "completed")
    expect(completed).toMatchObject({
      state: "completed",
      report: { savedBytes: 65, archivedSessions: 2, checkpointedSessions: 3 },
      resumable: false,
    })
  })

  test("keeps the actionable beginning and tail of long worker failures", async () => {
    const root = await createRoot()
    const runtime = StorageMigrationRuntime.make({
      data: root,
      spawn: () => ({
        pid: process.pid,
        exited: Promise.resolve(1),
        stdout: stream(""),
        stderr: stream(`ACTIONABLE-START-${"x".repeat(6_000)}-ACTIONABLE-END`),
      }),
    })
    expect((await runtime.startDryRun()).state).toBe("running")
    const failed = await eventually(runtime.status, (value) => value.state === "failed")
    expect(failed.message).toStartWith("ACTIONABLE-START")
    expect(failed.message).toContain("characters omitted")
    expect(failed.message).toEndWith("ACTIONABLE-END")
  })

  test("preserves multiline worker failures after the latest progress event", async () => {
    const root = await createRoot()
    const runtime = StorageMigrationRuntime.make({
      data: root,
      spawn: () => ({
        pid: process.pid,
        exited: Promise.resolve(1),
        stdout: stream(""),
        stderr: stream(
          `${JSON.stringify({ message: "Checkpointing sessions" })}\nStorageMigration.Error: checkpoint mismatch\n    at first.ts:10:2\n    at last.ts:20:4`,
        ),
      }),
    })
    expect((await runtime.startDryRun()).state).toBe("running")
    const failed = await eventually(runtime.status, (value) => value.state === "failed")
    expect(failed.message).toStartWith("StorageMigration.Error: checkpoint mismatch")
    expect(failed.message).toContain("at first.ts:10:2")
    expect(failed.message).toEndWith("at last.ts:20:4")
    expect(failed.message).not.toContain("Checkpointing sessions")
  })

  test("treats an empty progress message as a diagnostic reset", async () => {
    const root = await createRoot()
    const runtime = StorageMigrationRuntime.make({
      data: root,
      spawn: () => ({
        pid: process.pid,
        exited: Promise.resolve(1),
        stdout: stream(""),
        stderr: stream(`old failure\n${JSON.stringify({ message: "" })}\nnew failure`),
      }),
    })
    expect((await runtime.startDryRun()).state).toBe("running")
    const failed = await eventually(runtime.status, (value) => value.state === "failed")
    expect(failed.message).toBe("new failure")
  })

  test("counts omitted characters across long multiline worker failures", async () => {
    const root = await createRoot()
    const first = `ACTIONABLE-START-${"x".repeat(4_200)}`
    const second = "y".repeat(1_000)
    const runtime = StorageMigrationRuntime.make({
      data: root,
      spawn: () => ({
        pid: process.pid,
        exited: Promise.resolve(1),
        stdout: stream(""),
        stderr: stream(`${first}\n${second}\nACTIONABLE-END`),
      }),
    })
    expect((await runtime.startDryRun()).state).toBe("running")
    const failed = await eventually(runtime.status, (value) => value.state === "failed")
    expect(failed.message).toStartWith("ACTIONABLE-START")
    expect(failed.message).toContain("[1233 characters omitted]")
    expect(failed.message).toEndWith("ACTIONABLE-END")
  })

  test("uses the real default resolver and isolated worker invocation", async () => {
    const root = await createRoot()
    const worker = path.join(root, "worker.js")
    await writeFile(
      worker,
      'process.stderr.write("{\\"message\\":\\"isolated\\"}\\n"); process.stdout.write(JSON.stringify({ report: { savedBytes: 7 } }))',
    )
    const runtime = StorageMigrationRuntime.make({
      data: root,
      runtime: {
        execPath: process.execPath,
        argv: process.argv,
        env: { ...process.env, OPENCODE_NODE_WORKER: worker },
        // The worker contract belongs to the Electron sidecar runtime.
        versions: { ...process.versions, electron: "42.0.0" },
      },
    })

    expect((await runtime.startDryRun()).state).toBe("running")
    expect(await runtime.waitForDryRun()).toMatchObject({
      state: "completed",
      report: { savedBytes: 7 },
    })
  })

  test("coalesces concurrent dry-run starts", async () => {
    const root = await createRoot()
    let spawned = 0
    let finish!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
      finish = resolve
    })
    const runtime = StorageMigrationRuntime.make({
      data: root,
      spawn: () => {
        spawned += 1
        return {
          pid: process.pid,
          exited,
          stdout: stream(JSON.stringify({ report: {} })),
          stderr: stream(""),
        }
      },
    })
    const [first, second] = await Promise.all([runtime.startDryRun(), runtime.startDryRun()])
    expect(spawned).toBe(1)
    expect(second.id).toBe(first.id)
    finish(0)
    expect(await runtime.waitForDryRun()).toMatchObject({ state: "completed", report: {} })
  })

  test("starts fresh instead of resuming staging from a different content engine", async () => {
    const root = await createRoot()
    const stagingDirectory = path.join(root, "storage-migrations", "dry-run-production-v6")
    await mkdir(stagingDirectory, { recursive: true })
    await Bun.write(
      path.join(stagingDirectory, "content-migration-manifest.json"),
      JSON.stringify({ engineVersion: CONTENT_MIGRATION_VERSION - 1 }),
    )
    await writeFailedStatus(root, stagingDirectory)
    let finish!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
      finish = resolve
    })
    const invocations: ReadonlyArray<string>[] = []
    const runtime = StorageMigrationRuntime.make({
      data: root,
      spawn: (args) => {
        invocations.push(args)
        return {
          pid: process.pid,
          exited,
          stdout: stream(JSON.stringify({ report: {} })),
          stderr: stream(""),
        }
      },
    })

    const started = await runtime.startDryRun()
    expect(started.id).not.toBe("previous-run")
    expect(started.stagingDirectory).not.toBe(stagingDirectory)
    expect(started.snapshotDirectory).not.toBe(path.join(root, "previous-snapshot"))
    expect(started.startedAt).toBeGreaterThan(1)
    if (!started.stagingDirectory) throw new Error("Fresh dry-run did not publish a staging directory")
    expect(invocations[0]?.[invocations[0]!.indexOf("--staging") + 1]).toBe(started.stagingDirectory)
    finish(0)
    await eventually(runtime.status, (value) => value.state === "completed")
  })

  test("starts fresh instead of resuming staging from an older storage journal", async () => {
    const root = await createRoot()
    const stagingDirectory = path.join(root, "storage-migrations", "storage-v2")
    await mkdir(stagingDirectory, { recursive: true })
    await Promise.all([
      Bun.write(
        path.join(stagingDirectory, "content-migration-manifest.json"),
        JSON.stringify({ engineVersion: CONTENT_MIGRATION_VERSION }),
      ),
      Bun.write(
        path.join(stagingDirectory, "storage-migration-journal.json"),
        JSON.stringify({ version: STORAGE_MIGRATION_VERSION - 1 }),
      ),
    ])
    await writeFailedStatus(root, stagingDirectory)
    const runtime = StorageMigrationRuntime.make({
      data: root,
      spawn: () => ({
        pid: process.pid,
        exited: Promise.resolve(0),
        stdout: stream(JSON.stringify({ report: {} })),
        stderr: stream(""),
      }),
    })

    const started = await runtime.startDryRun()
    expect(started.id).not.toBe("previous-run")
    expect(started.stagingDirectory).not.toBe(stagingDirectory)
    await eventually(runtime.status, (value) => value.state === "completed")
  })

  test("resumes staging created by the current content engine", async () => {
    const root = await createRoot()
    const stagingDirectory = path.join(root, "storage-migrations", "current-candidate")
    await mkdir(stagingDirectory, { recursive: true })
    await Bun.write(
      path.join(stagingDirectory, "content-migration-manifest.json"),
      JSON.stringify({ engineVersion: CONTENT_MIGRATION_VERSION }),
    )
    await Bun.write(
      path.join(stagingDirectory, "storage-migration-journal.json"),
      JSON.stringify({ version: STORAGE_MIGRATION_VERSION }),
    )
    await writeFailedStatus(root, stagingDirectory)
    const runtime = StorageMigrationRuntime.make({
      data: root,
      spawn: () => ({
        pid: process.pid,
        exited: Promise.resolve(0),
        stdout: stream(JSON.stringify({ report: {} })),
        stderr: stream(""),
      }),
    })

    const started = await runtime.startDryRun()
    expect(started.id).toBe("previous-run")
    expect(started.stagingDirectory).toBe(stagingDirectory)
    expect(started.snapshotDirectory).toBe(path.join(root, "previous-snapshot"))
    expect(started.startedAt).toBe(1)
    await eventually(runtime.status, (value) => value.state === "completed")
  })

  test("starts fresh when failed staging was removed", async () => {
    const root = await createRoot()
    const stagingDirectory = path.join(root, "storage-migrations", "removed-candidate")
    await writeFailedStatus(root, stagingDirectory)
    const runtime = StorageMigrationRuntime.make({
      data: root,
      spawn: () => ({
        pid: process.pid,
        exited: Promise.resolve(0),
        stdout: stream(JSON.stringify({ report: {} })),
        stderr: stream(""),
      }),
    })

    const started = await runtime.startDryRun()
    expect(started.id).not.toBe("previous-run")
    expect(started.stagingDirectory).not.toBe(stagingDirectory)
    await eventually(runtime.status, (value) => value.state === "completed")
  })

  test("starts fresh when the content engine manifest is malformed", async () => {
    const root = await createRoot()
    const stagingDirectory = path.join(root, "storage-migrations", "corrupt-candidate")
    await mkdir(stagingDirectory, { recursive: true })
    await Bun.write(path.join(stagingDirectory, "content-migration-manifest.json"), "{not-json")
    await writeFailedStatus(root, stagingDirectory)
    const runtime = StorageMigrationRuntime.make({
      data: root,
      spawn: () => ({
        pid: process.pid,
        exited: Promise.resolve(0),
        stdout: stream(JSON.stringify({ report: {} })),
        stderr: stream(""),
      }),
    })

    const started = await runtime.startDryRun()
    expect(started.id).not.toBe("previous-run")
    expect(started.stagingDirectory).not.toBe(stagingDirectory)
    await eventually(runtime.status, (value) => value.state === "completed")
  })

  test("keeps status JSON atomic while progress writes and status polls overlap", async () => {
    const root = await createRoot()
    const runtime = StorageMigrationRuntime.make({
      data: root,
      spawn: () => ({
        pid: process.pid,
        exited: Promise.resolve(0),
        stdout: stream(JSON.stringify({ report: {} })),
        stderr: pacedStream(
          Array.from({ length: 60 }, (_, index) => `${JSON.stringify({ message: `phase-${index}` })}\n`),
        ),
      }),
    })
    expect((await runtime.startDryRun()).state).toBe("running")
    const filename = path.join(root, "storage-migration-runtime.json")

    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let attempt = 0; attempt < 40; attempt++) {
          const stored = JSON.parse(await readFile(filename, "utf8")) as { readonly state: string }
          expect(["running", "completed"]).toContain(stored.state)
          expect(["running", "completed"]).toContain((await runtime.status()).state)
          await Bun.sleep(1)
        }
      }),
    )
    await eventually(runtime.status, (value) => value.state === "completed")
  })

  test("keeps local and production dry-runs isolated and targets the selected database", async () => {
    const root = await createRoot()
    const invocations: ReadonlyArray<string>[] = []
    const runtime = StorageMigrationRuntime.make({
      data: root,
      spawn: (args) => {
        invocations.push(args)
        return {
          pid: process.pid,
          exited: Promise.resolve(0),
          stdout: stream(JSON.stringify({ report: {} })),
          stderr: stream(""),
        }
      },
    })

    const local = await runtime.startDryRun({ databaseKind: "local" })
    expect(local).toMatchObject({
      state: "running",
      databaseKind: "local",
      sourceDatabase: path.join(root, "opencode-local.db"),
    })
    await eventually(
      () => runtime.status("local"),
      (value) => value.state === "completed",
    )
    expect(await runtime.status()).toEqual({ state: "idle", databaseKind: "production" })
    expect(invocations[0]).toContain("local")
    expect(invocations[0]).toContain(path.join(root, "opencode-local.db"))
    expect(local.stagingDirectory).toContain("dry-run-local-")
  })

  test("rejects a local dry-run when the local database is absent", async () => {
    const root = await createRoot()
    await rm(path.join(root, "opencode-local.db"))
    await expect(StorageMigrationRuntime.make({ data: root }).startDryRun({ databaseKind: "local" })).rejects.toThrow(
      "Local database does not exist",
    )
  })
})

async function createRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-storage-runtime-"))
  await Promise.all([
    Bun.write(path.join(root, "opencode.db"), "fixture"),
    Bun.write(path.join(root, "opencode-local.db"), "fixture"),
  ])
  roots.push(root)
  return root
}

function stream(value: string) {
  return new Response(value).body!
}

function pacedStream(values: ReadonlyArray<string>) {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index === values.length) {
        controller.close()
        return
      }
      await Bun.sleep(1)
      controller.enqueue(encoder.encode(values[index++]!))
    },
  })
}

async function writeFailedStatus(root: string, stagingDirectory: string) {
  await Bun.write(
    path.join(root, "storage-migration-runtime.json"),
    JSON.stringify({
      state: "failed",
      id: "previous-run",
      stagingDirectory,
      snapshotDirectory: path.join(root, "previous-snapshot"),
      startedAt: 1,
      resumable: true,
    }),
  )
}

async function writeCompletedActivation(root: string, databaseKind: "production" | "local", completedAt: number) {
  const stagingDirectory = path.join(root, "storage-migrations", `${databaseKind}-complete`)
  const id = `${databaseKind}-activation`
  await mkdir(stagingDirectory, { recursive: true })
  await Promise.all([
    Bun.write(
      path.join(stagingDirectory, "storage-activation-manifest.json"),
      JSON.stringify({
        kind: "opencode-storage-candidate",
        id,
        databaseKind,
        status: "complete",
        paths: {
          sourceDatabase: path.join(root, databaseKind === "production" ? "opencode.db" : "opencode-local.db"),
        },
      }),
    ),
    Bun.write(
      path.join(stagingDirectory, `storage-activation-${id}.json`),
      JSON.stringify({
        kind: "opencode-storage-activation",
        manifestID: id,
        events: [{ state: "completed", time: completedAt }],
      }),
    ),
    Bun.write(
      path.join(stagingDirectory, "storage-migration-journal.json"),
      JSON.stringify({
        kind: "opencode-storage-migration",
        status: "complete",
        phase: "complete",
        createdAt: completedAt - 50,
        report: {
          sourceBytes: 100,
          activeDatabaseBytes: 20,
          archiveBytes: 10,
          blobBytes: 5,
          candidateBytes: 35,
          savedBytes: 65,
          savedRatio: 0.65,
          checkpointedSessions: 3,
          archivedSessions: 2,
          activeSessions: 1,
          quarantineCount: 0,
          content: {},
        },
      }),
    ),
  ])
  return stagingDirectory
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read()
    if (done(value)) return value
    await Bun.sleep(10)
  }
  throw new Error("Storage migration runtime did not settle")
}

async function remove(directory: string, attempt = 0): Promise<void> {
  return rm(directory, { recursive: true, force: true }).catch(async (cause) => {
    if (
      !(cause instanceof Error) ||
      !("code" in cause) ||
      (cause.code !== "EBUSY" && cause.code !== "EPERM") ||
      attempt >= 20
    )
      throw cause
    await Bun.sleep(50)
    return remove(directory, attempt + 1)
  })
}
