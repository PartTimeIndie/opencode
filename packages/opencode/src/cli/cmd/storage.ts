import path from "node:path"
import { open } from "node:fs/promises"
import type { Argv } from "yargs"
import { Effect } from "effect"
import { ContentGC } from "@opencode-ai/core/content-gc"
import { StorageActivation } from "@opencode-ai/core/storage-activation"
import { StorageMigration } from "@opencode-ai/core/storage-migration"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CheckpointVerificationTransport } from "@opencode-ai/core/checkpoint-verification-transport"
import { StorageMigrationRuntime } from "@/storage-migration-runtime"
import { cmd } from "./cmd"
import { run } from "../self"

type MigrateArgs = {
  mode: "dry-run" | "prepare" | "activate" | "rollback"
  database: "production" | "local"
  source: string
  staging: string
  snapshot?: string
  blobStore: string
  archives: string
  confirm?: string
  expectedSavedBytes?: number
  minimumSavingsBytes?: number
  quarantineApproval?: string
  offline?: boolean
}

type StorageGCArgs = {
  store: string
  journal: string
  inventory: string
  database?: string[]
  archive?: string[]
  rollbackManifest?: string[]
}

type StorageGCSources = Omit<StorageGCArgs, "inventory">

type StorageGCInventoryArgs = StorageGCSources & {
  output: string
  complete?: boolean
  backupRoot?: string[]
  archiveRoot?: string[]
  rollbackManifestRoot?: string[]
  noBackups?: boolean
  noArchives?: boolean
  noRollbackManifests?: boolean
  noActiveDatabase?: boolean
  noLocalDatabase?: boolean
}

type StorageGCCollectArgs = StorageGCArgs & {
  digest: string
  offline?: boolean
}

const SHA256 = /^[0-9a-f]{64}$/

const MigrateCommand = cmd({
  command: "migrate",
  describe: "stage or activate the offline storage migration",
  builder: (yargs: Argv) =>
    yargs
      .option("mode", { choices: ["dry-run", "prepare", "activate", "rollback"] as const, demandOption: true })
      .option("database", { choices: ["production", "local"] as const, demandOption: true })
      .option("source", { type: "string", demandOption: true })
      .option("staging", { type: "string", demandOption: true })
      .option("snapshot", { type: "string" })
      .option("blob-store", { type: "string", demandOption: true })
      .option("archives", { type: "string", demandOption: true })
      .option("confirm", { type: "string" })
      .option("expected-saved-bytes", { type: "number" })
      .option("minimum-savings-bytes", { type: "number" })
      .option("quarantine-approval", { type: "string" })
      .option("offline", {
        type: "boolean",
        describe: "confirm every OpenCode and external database writer is stopped for prepare or activate",
      }),
  handler: async (args) => {
    const input = args as unknown as MigrateArgs
    requireOfflineStorageMigration(input)
    if (input.mode === "rollback") {
      const manifestPath = path.join(input.staging, "storage-activation-manifest.json")
      const manifest = (await Bun.file(manifestPath).json()) as StorageActivation.Manifest
      if (manifest.id !== input.confirm) throw new Error(`Rollback requires --confirm ${manifest.id}`)
      if (manifest.databaseKind !== input.database)
        throw new Error(`Rollback manifest belongs to ${manifest.databaseKind}, not ${input.database}`)
      const options = {
        databaseKind: input.database,
        sourceDatabase: input.source,
        candidateDatabase: path.join(input.staging, "candidate.db"),
        candidateBlobDirectory: path.join(input.staging, "content"),
        liveBlobDirectory: input.blobStore,
        candidateArchiveDirectory: path.join(input.staging, "archives"),
        liveArchiveDirectory: input.archives,
        stagingDirectory: input.staging,
        manifestPath,
        confirm: manifest.id,
        onProgress: (progress: StorageActivation.RollbackProgress) => {
          process.stderr.write(`${JSON.stringify({ progress })}\n`)
        },
      }
      const result =
        input.database === "production"
          ? await StorageActivation.rollback({ ...options, databaseKind: "production" })
          : await StorageActivation.rollbackLocal({ ...options, databaseKind: "local" })
      await StorageMigrationRuntime.make({ data: path.dirname(input.source) }).recordRollback(
        input.database,
        input.staging,
      )
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }
    if (input.mode !== "activate") {
      const result = await StorageMigration.run({
        mode: input.mode,
        databaseKind: input.database,
        sourceDatabase: input.source,
        stagingDirectory: input.staging,
        ...(input.snapshot ? { dryRunSnapshotDirectory: input.snapshot } : {}),
        liveBlobDirectory: input.blobStore,
        liveArchiveDirectory: input.archives,
        ...(input.quarantineApproval
          ? {
              quarantineApproval: (await Bun.file(
                input.quarantineApproval,
              ).json()) as StorageMigration.QuarantineApproval,
            }
          : {}),
        ...(input.expectedSavedBytes === undefined ? {} : { expectedDryRun: { savedBytes: input.expectedSavedBytes } }),
        ...(input.minimumSavingsBytes === undefined ? {} : { minimumSavingsBytes: input.minimumSavingsBytes }),
        sessionWorker: (filename) => run(["storage", "session-worker", filename]),
        onProgress: (progress) => {
          process.stderr.write(`${JSON.stringify(progress)}\n`)
        },
      })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }

    const manifestPath = path.join(input.staging, "storage-activation-manifest.json")
    const manifest = (await Bun.file(manifestPath).json()) as StorageActivation.Manifest
    if (manifest.id !== input.confirm) throw new Error(`Activation requires --confirm ${manifest.id}`)
    if (manifest.databaseKind !== input.database)
      throw new Error(`Activation manifest belongs to ${manifest.databaseKind}, not ${input.database}`)
    const options = {
      databaseKind: input.database,
      sourceDatabase: input.source,
      candidateDatabase: path.join(input.staging, "candidate.db"),
      candidateBlobDirectory: path.join(input.staging, "content"),
      liveBlobDirectory: input.blobStore,
      candidateArchiveDirectory: path.join(input.staging, "archives"),
      liveArchiveDirectory: input.archives,
      stagingDirectory: input.staging,
      manifestPath,
      onProgress: (progress: StorageActivation.Progress) => {
        process.stderr.write(`${JSON.stringify({ progress })}\n`)
      },
    }
    const result =
      input.database === "production"
        ? await StorageActivation.activate({ ...options, databaseKind: "production" })
        : await StorageActivation.activateLocal({ ...options, databaseKind: "local" })
    await StorageMigrationRuntime.make({ data: path.dirname(input.source) }).recordActivation(input.database, input.staging)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  },
})

const StorageGCPlanCommand = cmd({
  command: "plan",
  describe: "print a non-destructive content collection plan as JSON",
  builder: storageGCExecutionBuilder,
  handler: async (args) => {
    const result = await planStorageGC(args)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  },
})

const StorageGCCollectCommand = cmd({
  command: "collect",
  describe: "collect the exact confirmed plan while every source writer is offline",
  builder: (yargs: Argv) =>
    storageGCExecutionBuilder(yargs)
      .option("digest", {
        type: "string",
        demandOption: true,
        describe: "exact lowercase SHA-256 digest printed by storage gc plan",
      })
      .option("offline", {
        type: "boolean",
        demandOption: true,
        describe: "confirm that every OpenCode and external source writer is stopped",
      }),
  handler: async (args) => {
    const result = await collectStorageGC(args, (progress) => {
      process.stderr.write(`${JSON.stringify({ progress })}\n`)
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  },
})

const StorageGCInventoryCommand = cmd({
  command: "inventory",
  describe: "write an immutable explicit inventory after confirming every source category is complete",
  builder: (yargs: Argv) =>
    storageGCBuilder(yargs)
      .option("output", { type: "string", demandOption: true, describe: "new inventory manifest path" })
      .option("complete", {
        type: "boolean",
        demandOption: true,
        describe: "attest that active, local, backup, archive, and rollback source lists are complete",
      })
      .option("backup-root", { type: "string", array: true, describe: "authoritative backup directory" })
      .option("archive-root", { type: "string", array: true, describe: "authoritative archive directory" })
      .option("rollback-manifest-root", {
        type: "string",
        array: true,
        describe: "authoritative rollback-manifest directory",
      })
      .option("no-backups", { type: "boolean", describe: "explicitly confirm that no backups exist" })
      .option("no-active-database", {
        type: "boolean",
        describe: "explicitly confirm that no active database exists for this content store",
      })
      .option("no-local-database", {
        type: "boolean",
        describe: "explicitly confirm that no local database exists for this content store",
      })
      .option("no-archives", { type: "boolean", describe: "explicitly confirm that no archive shards exist" })
      .option("no-rollback-manifests", {
        type: "boolean",
        describe: "explicitly confirm that no rollback manifests exist",
      }),
  handler: async (args) => {
    const inventory = await createStorageGCInventory(args as unknown as StorageGCInventoryArgs)
    const handle = await open(String(args.output), "wx")
    try {
      await handle.writeFile(`${JSON.stringify(inventory, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`)
  },
})

const StorageGCCommand = cmd({
  command: "gc",
  describe: "plan or perform explicit content-addressed blob collection",
  builder: (yargs: Argv) =>
    yargs
      .command(StorageGCInventoryCommand)
      .command(StorageGCPlanCommand)
      .command(StorageGCCollectCommand)
      .demandCommand(),
  handler: async () => {},
})

const SessionWorkerCommand = cmd({
  command: "session-worker <input>",
  describe: false,
  builder: (yargs: Argv) => yargs.positional("input", { type: "string", demandOption: true }),
  handler: async (args) => {
    await StorageMigration.runSessionWorker(String(args.input))
  },
})

const CheckpointWorkerCommand = cmd({
  command: "checkpoint-worker <input>",
  describe: false,
  builder: (yargs: Argv) => yargs.positional("input", { type: "string", demandOption: true }),
  handler: async (args) => {
    const input = CheckpointVerificationTransport.decode<SessionProjector.CheckpointVerificationInput>(
      await Bun.file(String(args.input)).bytes(),
    )
    await Effect.runPromise(SessionProjector.verifyProjectionInFreshRuntime(input))
  },
})

export const StorageCommand = cmd({
  command: "storage",
  describe: "storage migration tools",
  builder: (yargs: Argv) =>
    yargs
      .command(MigrateCommand)
      .command(StorageGCCommand)
      .command(SessionWorkerCommand)
      .command(CheckpointWorkerCommand)
      .demandCommand(),
  handler: async () => {},
})

export async function planStorageGC(input: StorageGCArgs) {
  return ContentGC.plan(storageGCInput(input), { inventory: input.inventory })
}

export async function createStorageGCInventory(input: StorageGCInventoryArgs) {
  if (input.complete !== true)
    throw new Error(
      "Content GC inventory requires --complete after active, local, backup, archive, and rollback sources are fully enumerated",
    )
  return ContentGC.createSourceInventory(storageGCInput(input), {
    backupDirectories: input.backupRoot ?? [],
    archiveDirectories: input.archiveRoot ?? [],
    rollbackManifestDirectories: input.rollbackManifestRoot ?? [],
    confirmNoBackups: input.noBackups === true,
    confirmNoArchives: input.noArchives === true,
    confirmNoRollbackManifests: input.noRollbackManifests === true,
    confirmNoActiveDatabase: input.noActiveDatabase === true,
    confirmNoLocalDatabase: input.noLocalDatabase === true,
  })
}

export async function collectStorageGC(
  input: StorageGCCollectArgs,
  onProgress?: (progress: ContentGC.Progress) => void | Promise<void>,
) {
  if (!SHA256.test(input.digest))
    throw new Error("Content collection requires the exact 64-character lowercase SHA-256 digest from storage gc plan")
  if (input.offline !== true)
    throw new Error("Content collection requires --offline after every OpenCode and external source writer is stopped")
  return ContentGC.collect(storageGCInput(input), input.digest, {
    offline: true,
    inventory: input.inventory,
    ...(onProgress ? { onProgress } : {}),
  })
}

export function requireOfflineStorageMigration(input: Pick<MigrateArgs, "mode" | "offline">) {
  if (input.mode === "dry-run" || input.offline === true) return
  throw new Error(
    `Storage migration ${input.mode} requires --offline after every OpenCode and external database writer is stopped`,
  )
}

function storageGCExecutionBuilder(yargs: Argv) {
  return storageGCBuilder(yargs).option("inventory", {
    type: "string",
    demandOption: true,
    describe: "explicit complete source-inventory manifest created by storage gc inventory",
  })
}

function storageGCBuilder(yargs: Argv) {
  return yargs
    .option("store", {
      type: "string",
      demandOption: true,
      describe: "explicit managed content-store directory",
    })
    .option("journal", {
      type: "string",
      demandOption: true,
      describe: "explicit collection-journal directory",
    })
    .option("database", {
      type: "string",
      array: true,
      describe: "repeatable reachability database as active:path, local:path, or backup:path",
    })
    .option("archive", {
      type: "string",
      array: true,
      describe: "repeatable explicit archive-shard path",
    })
    .option("rollback-manifest", {
      type: "string",
      array: true,
      describe: "repeatable explicit rollback-retention manifest path",
    })
}

function storageGCInput(input: StorageGCSources): ContentGC.Input {
  const databases = (input.database ?? []).map(storageGCDatabase)
  const archiveShards = input.archive ?? []
  const rollbackManifests = input.rollbackManifest ?? []
  if (databases.length + archiveShards.length + rollbackManifests.length === 0)
    throw new Error(
      "Content collection requires at least one explicit --database, --archive, or --rollback-manifest source",
    )
  return {
    storeDirectory: input.store,
    journalDirectory: input.journal,
    databases,
    archiveShards,
    rollbackManifests,
  }
}

function storageGCDatabase(input: string): ContentGC.DatabaseSource {
  const separator = input.indexOf(":")
  if (separator < 1 || input.slice(separator + 1).trim().length === 0)
    throw new Error(`Invalid --database ${JSON.stringify(input)}; expected kind:path`)
  const kind = storageGCDatabaseKind(input.slice(0, separator))
  return { kind, path: input.slice(separator + 1).trim() }
}

function storageGCDatabaseKind(input: string): ContentGC.DatabaseKind {
  if (input === "active" || input === "local" || input === "backup") return input
  throw new Error(`Invalid --database kind ${JSON.stringify(input)}; expected active, local, or backup`)
}
