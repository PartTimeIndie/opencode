import path from "node:path"
import { StorageActivation } from "../src/storage-activation"
import { StorageMigration } from "../src/storage-migration"

if (import.meta.main) {
  const mode = argument("--mode")
  const databaseKind = argument("--database")
  const sourceDatabase = argument("--source")
  const stagingDirectory = argument("--staging")
  const dryRunSnapshotDirectory = argument("--snapshot")
  const liveBlobDirectory = argument("--blob-store")
  const liveArchiveDirectory = argument("--archives")
  if (
    (mode !== "dry-run" && mode !== "prepare" && mode !== "activate") ||
    (databaseKind !== "production" && databaseKind !== "local") ||
    !sourceDatabase ||
    !stagingDirectory ||
    !liveBlobDirectory ||
    !liveArchiveDirectory
  )
    throw new Error(
      "Usage: bun run migrate:storage --mode <dry-run|prepare|activate> --database <production|local> --source <absolute-db> --staging <absolute-dir> [--snapshot <absolute-dir>] --blob-store <absolute-dir> --archives <absolute-dir>",
    )

  if (mode !== "activate") {
    const quarantineApproval = argument("--quarantine-approval")
    const expectedSavedBytes = numberArgument("--expected-saved-bytes")
    const minimumSavingsBytes = numberArgument("--minimum-savings-bytes")
    const manifest = await StorageMigration.run({
      mode,
      databaseKind,
      sourceDatabase,
      stagingDirectory,
      ...(dryRunSnapshotDirectory ? { dryRunSnapshotDirectory } : {}),
      liveBlobDirectory,
      liveArchiveDirectory,
      ...(quarantineApproval
        ? { quarantineApproval: await Bun.file(quarantineApproval).json() as StorageMigration.QuarantineApproval }
        : {}),
      ...(expectedSavedBytes === undefined ? {} : { expectedDryRun: { savedBytes: expectedSavedBytes } }),
      ...(minimumSavingsBytes === undefined ? {} : { minimumSavingsBytes }),
      onProgress: (progress) => {
        process.stderr.write(`${JSON.stringify(progress)}\n`)
      },
    })
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
    process.exit(0)
  }

  const manifestPath = path.join(stagingDirectory, "storage-activation-manifest.json")
  const manifest = await Bun.file(manifestPath).json() as StorageActivation.Manifest
  const confirmation = argument("--confirm")
  if (manifest.id !== confirmation)
    throw new Error(`Activation requires --confirm ${manifest.id}`)
  if (manifest.databaseKind !== databaseKind)
    throw new Error(`Activation manifest belongs to ${manifest.databaseKind}, not ${databaseKind}`)
  const options = {
    databaseKind,
    sourceDatabase,
    candidateDatabase: path.join(stagingDirectory, "candidate.db"),
    candidateBlobDirectory: path.join(stagingDirectory, "content"),
    liveBlobDirectory,
    candidateArchiveDirectory: path.join(stagingDirectory, "archives"),
    liveArchiveDirectory,
    stagingDirectory,
    manifestPath,
    onProgress: (progress: StorageActivation.Progress) => {
      process.stderr.write(`${JSON.stringify({ progress })}\n`)
    },
  }
  const result = databaseKind === "production"
    ? await StorageActivation.activate({ ...options, databaseKind: "production" })
    : await StorageActivation.activateLocal({ ...options, databaseKind: "local" })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

function argument(name: string) {
  const index = Bun.argv.indexOf(name)
  return index === -1 ? undefined : Bun.argv[index + 1]
}

function numberArgument(name: string) {
  const value = argument(name)
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return number
}
