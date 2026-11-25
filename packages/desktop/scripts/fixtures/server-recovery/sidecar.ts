import { createServer } from "node:http"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { CrashActivity } from "../../../../core/src/observability/crash-activity"
import { layer as sqliteLayer } from "../../../../core/src/database/sqlite.node"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { traceSessionRead } from "../../../../opencode/src/server/routes/instance/httpapi/middleware/session-read-crash-trace"
import { startSidecarDiagnostics } from "../../../src/main/sidecar-diagnostics"

type Command = { type: string; hostname: string; port: number; recovery: { ownerID: string; previousOwners: string[] } }
const port = process.parentPort as { on: (event: string, callback: (event: { data: Command }) => void) => void; postMessage: (message: unknown) => void }
const root = process.env.OPENCODE_RECOVERY_TEST_ROOT
if (!root) throw new Error("Isolated fixture root required")
let server: ReturnType<typeof createServer> | undefined
let stopDiagnostics: (() => void) | undefined
port.on("message", ({ data }) => {
  if (data.type === "stop") {
    stopDiagnostics?.()
    server?.close(() => setTimeout(() => {
      // Prove cleanup survived the former six-second forced-kill deadline.
      writeFileSync(join(root, "graceful-stop.json"), JSON.stringify({ cleaned: true }))
      process.exit(0)
    }, 7_000))
    return
  }
  if (data.type !== "start") return
  stopDiagnostics = startSidecarDiagnostics((sample) => port.postMessage({ type: "diagnostic", sample }))
  const record = join(root, "generations.json")
  const prior: Array<{ ownerID: string; previousOwners: string[] }> = (() => {
    try { return JSON.parse(readFileSync(record, "utf8")) } catch { return [] }
  })()
  prior.push(data.recovery)
  writeFileSync(record, JSON.stringify(prior))
  port.postMessage({ type: "execution-owner", ownerID: data.recovery.ownerID })
  CrashActivity.configure((update) => port.postMessage({ type: "activity", update }))
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost")
    const request = HttpServerRequest.fromWeb(new Request(pathname))
    const crashOnPage = prior.length === 1 && pathname.pathname === "/api/session/ses_fixture/message"
    if (crashOnPage) {
      const page = Effect.gen(function* () {
        const db = yield* SqlClient
        yield* CrashActivity.track(
          { kind: "session-stage", sessionID: "ses_fixture", name: "messages.query" },
          db.unsafe("SELECT 1 AS fixture"),
        )
        yield* Effect.promise(() => CrashActivity.trackPromise(
          { kind: "plugin", pluginID: "@fixture/plugin", name: "server.event", sessionID: "ses_fixture" },
          () => new Promise<never>(() => {
            // Abruptly exit while the callback is active, after IPC can deliver its start.
            setTimeout(() => process.exit(17), 200)
          }),
        ))
      }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })))
      Effect.runFork(traceSessionRead(page).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      ))
      return
    }
    void Effect.runPromise(traceSessionRead(Effect.void).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    )).then(() => { res.writeHead(200); res.end("ok") })
  })
  server.listen(data.port, data.hostname, () => {
    port.postMessage({ type: "ready" })
    if (prior.length === 1) {
      Effect.runFork(Effect.gen(function* () {
        yield* CrashActivity.track({ kind: "tool", sessionID: "ses_fixture", name: "task_wait" }, Effect.void)
        yield* CrashActivity.track({ kind: "provider", sessionID: "ses_fixture", name: "test/model" }, Effect.never)
      }))
    }
  })
})
