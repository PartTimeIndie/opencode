import { spawn } from "node:child_process"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "../../core/src/database/database"

const electron = createRequire(import.meta.url)("electron") as unknown
if (typeof electron !== "string") throw new Error("Could not resolve the Electron executable")

const root = await mkdtemp(path.join(tmpdir(), "opencode-storage-worker-smoke-"))
const source = path.join(root, "source.db")
const staging = path.join(root, "staging")
const worker = path.resolve("out/main/storage-worker.js")
await Effect.runPromise(
  Effect.gen(function* () {
    yield* Database.Service
  }).pipe(
    Effect.provide(Database.layerFromPath(source, { deferStartupRepairs: false })),
    Effect.scoped,
  ),
)
await mkdir(staging)

const output = { stdout: "", stderr: "" }
const child = spawn(
  electron,
  [
    worker,
    "storage",
    "migrate",
    "--mode",
    "dry-run",
    "--database",
    "production",
    "--source",
    source,
    "--staging",
    staging,
    "--snapshot",
    path.join(root, "snapshot"),
    "--blob-store",
    path.join(root, "content"),
    "--archives",
    path.join(root, "archives"),
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OPENCODE_NODE_WORKER: worker },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  },
)
child.stdout.on(
  "data",
  (chunk: Buffer) => (output.stdout = `${output.stdout}${chunk.toString("utf8")}`.slice(-100_000)),
)
child.stderr.on(
  "data",
  (chunk: Buffer) => (output.stderr = `${output.stderr}${chunk.toString("utf8")}`.slice(-100_000)),
)

const exit = new Promise<number>((resolve, reject) => {
  child.once("error", reject)
  child.once("close", (code) => resolve(code ?? 1))
})
const timeout = setTimeout(() => child.kill(), 60_000)
const exitCode = await exit.finally(async () => {
  clearTimeout(timeout)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch((error: unknown) => {
    if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EBUSY") {
      console.warn(`Deferred locked Windows smoke cleanup until the verifier process exits: ${root}`)
      return
    }
    throw error
  })
})
if (exitCode !== 0)
  throw new Error(
    `Electron storage worker exited ${exitCode}\n--- stdout ---\n${output.stdout.trim() || "<empty>"}\n--- stderr ---\n${output.stderr.trim() || "<empty>"}`,
  )
const manifest = JSON.parse(output.stdout) as { readonly status?: unknown; readonly report?: unknown }
if (manifest.status !== "complete" || !manifest.report)
  throw new Error("Electron storage worker returned no completed report")
console.log("verified isolated Electron storage dry-run worker")
