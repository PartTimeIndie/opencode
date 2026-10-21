export * as StorageWorker from "./storage-worker"

import { readFile } from "node:fs/promises"
import { Effect } from "effect"
import { IsolatedWorker } from "@opencode-ai/core/isolated-worker"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { StorageMigration } from "@opencode-ai/core/storage-migration"
import { CheckpointVerificationTransport } from "@opencode-ai/core/checkpoint-verification-transport"

export async function run(args: ReadonlyArray<string>) {
  if (args[0] !== "storage") throw new Error(`Unsupported isolated worker command: ${args.join(" ")}`)
  if (args[1] === "checkpoint-worker") {
    const input = CheckpointVerificationTransport.decode<SessionProjector.CheckpointVerificationInput>(
      await readFile(requireValue(args[2], "checkpoint input")),
    )
    await Effect.runPromise(SessionProjector.verifyProjectionInFreshRuntime(input))
    return
  }
  if (args[1] === "session-worker") {
    await StorageMigration.runSessionWorker(requireValue(args[2], "session input"))
    return
  }
  if (args[1] !== "migrate") throw new Error(`Unsupported isolated storage worker command: ${args[1] ?? "missing"}`)

  const flags = parseFlags(args.slice(2))
  if (flags.mode !== "dry-run") throw new Error("The desktop storage worker only accepts non-destructive dry-runs")
  if (flags.database !== "production" && flags.database !== "local")
    throw new Error("Storage migration database must be production or local")
  const result = await StorageMigration.run({
    mode: "dry-run",
    databaseKind: flags.database,
    sourceDatabase: requireFlag(flags, "source"),
    stagingDirectory: requireFlag(flags, "staging"),
    dryRunSnapshotDirectory: requireFlag(flags, "snapshot"),
    liveBlobDirectory: requireFlag(flags, "blob-store"),
    liveArchiveDirectory: requireFlag(flags, "archives"),
    sessionWorker: (input) => runChild(["storage", "session-worker", input]),
    onProgress: (progress) => {
      process.stderr.write(`${JSON.stringify(progress)}\n`)
    },
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

function parseFlags(args: ReadonlyArray<string>) {
  const result: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = requireValue(args[index], "flag")
    if (!name.startsWith("--")) throw new Error(`Invalid isolated worker flag: ${name}`)
    result[name.slice(2)] = requireValue(args[index + 1], name)
  }
  return result
}

function requireFlag(flags: Readonly<Record<string, string>>, name: string) {
  return requireValue(flags[name], `--${name}`)
}

function requireValue(value: string | undefined, label: string) {
  if (!value) throw new Error(`Missing isolated worker ${label}`)
  return value
}

async function runChild(args: ReadonlyArray<string>) {
  const child = IsolatedWorker.launch(args)
  child.stdin.end()
  child.stdout.resume()
  const stderr: Buffer[] = []
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve(code ?? 1))
  })
  if (exitCode !== 0)
    throw new Error(Buffer.concat(stderr).toString("utf8").trim() || `Storage session worker exited ${exitCode}`)
}
