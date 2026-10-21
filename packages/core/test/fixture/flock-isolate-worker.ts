import { parentPort, workerData } from "worker_threads"
import { Flock } from "@opencode-ai/core/util/flock"

const input = workerData as {
  key: string
  dir: string
  staleMs: number
  timeoutMs: number
}

const result = await Flock.withProcessLock(input.key, async () => "acquired", {
  dir: input.dir,
  staleMs: input.staleMs,
  timeoutMs: input.timeoutMs,
  baseDelayMs: 10,
  maxDelayMs: 25,
}).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))

parentPort?.postMessage(result)
