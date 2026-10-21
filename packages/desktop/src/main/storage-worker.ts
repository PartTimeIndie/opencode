import { StorageWorker } from "virtual:opencode-server"

StorageWorker.run(process.argv.slice(2)).catch((cause) => {
  process.stderr.write(describe(cause))
  process.exitCode = 1
})

function describe(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause)
  return `${cause.stack ?? cause.message}${cause.cause === undefined ? "" : `\nCaused by: ${describe(cause.cause)}`}`
}
