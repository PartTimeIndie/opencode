import { app, BrowserWindow } from "electron"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createServer } from "node:net"
import { setTimeout } from "node:timers/promises"
import { spawnLocalServer, type SidecarExit, type SidecarListener } from "../../../src/main/server"
import { applyCloseToTray, createTray } from "../../../src/main/tray"
import { showFromTray } from "../../../src/main/tray-lifecycle"
import { markAppQuitting } from "../../../src/main/app-state"

const root = process.env.OPENCODE_RECOVERY_TEST_ROOT
if (!root) throw new Error("Isolated fixture root required")
app.setPath("userData", join(root, "user-data"))
app.on("window-all-closed", () => {})
let listener: SidecarListener | undefined
let tray: ReturnType<typeof createTray>
const deadline = globalThis.setTimeout(() => { void listener?.stop().finally(() => app.exit(1)) }, 25_000)
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message) }
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 320, height: 200, webPreferences: { sandbox: true } })
  await window.loadURL("data:text/html,<title>Isolated recovery fixture</title>")
  const icon = process.env.OPENCODE_RECOVERY_TEST_ICON
  if (!icon) throw new Error("Fixture icon required")
  tray = createTray(icon, [], { onShow: () => showFromTray(window), onQuit: () => app.quit() })
  assert(tray, "tray must have a packaged icon")
  applyCloseToTray(window, () => Boolean(tray))
  window.show()
  window.close()
  assert(!window.isDestroyed() && !window.isVisible(), "X must hide rather than destroy")
  showFromTray(window)
  assert(window.isVisible(), "tray reopen must show window")
  window.hide()
  const port = await new Promise<number>((resolve, reject) => {
    const socket = createServer()
    socket.on("error", reject)
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address()
      if (!address || typeof address === "string") return reject(new Error("fixture port unavailable"))
      socket.close(() => resolve(address.port))
    })
  })
  let healthy = 0
  const spawned: number[] = []
  const diagnostics: Array<{ pid: number | undefined; rssBytes: number }> = []
  const exits: SidecarExit[] = []
  const started = await spawnLocalServer("127.0.0.1", port, "fixture-only", {
    userDataPath: root,
    onState: (state) => { if (state.phase === "healthy") healthy++ },
    onSpawn: (pid) => { if (pid !== undefined) spawned.push(pid) },
    onDiagnostic: (sample) => diagnostics.push(sample),
    onExit: (_code, detail) => exits.push(detail),
  })
  listener = started.listener
  await started.health.wait
  const fixtureUrl = `http://127.0.0.1:${port}`
  assert((await fetch(`${fixtureUrl}/session/ses_fixture/exists`)).ok, "the existence check must complete first")
  await fetch(`${fixtureUrl}/api/session/ses_fixture/message`).then(
    () => { throw new Error("the interrupted page must not return a response") },
    () => {},
  )
  for (let i = 0; i < 150 && healthy < 2; i++) await setTimeout(100)
  assert(healthy === 2, "replacement must pass real HTTP health check")
  const generations = JSON.parse(readFileSync(join(root, "generations.json"), "utf8"))
  assert(generations.length === 2, "one crash must create exactly one replacement")
  assert(generations[1].previousOwners[0] === generations[0].ownerID, "private predecessor acknowledgement must survive exit")
  assert(spawned.length === 2 && spawned[0] !== spawned[1], "each generation must have a distinct logged PID")
  assert(diagnostics.length >= 2 && diagnostics.some((sample) => sample.pid === spawned[0]) &&
    diagnostics.some((sample) => sample.pid === spawned[1]) && diagnostics.every((sample) => sample.rssBytes > 0),
  "each generation must report process metrics with its PID")
  assert(exits.length === 1 && exits[0].pid === spawned[0] && exits[0].uptimeMs > 0,
    "crashed generation must log PID and lifetime")
  assert(exits[0].activity?.active.length === 3 &&
    exits[0].activity.active.some((operation) => operation.name === "test/model") &&
    exits[0].activity.active.some((operation) => operation.name === "v2.session.messages") &&
    exits[0].activity.active.some((operation) => operation.pluginID === "@fixture/plugin" && operation.name === "server.event"),
    "crashed generation must retain the unfinished provider request, session page and plugin callback")
  assert(exits[0].activity?.recentStages.sqlite.some((operation) => operation.name === "all.rows" && operation.outcome === "success") &&
    exits[0].activity.recentStages["session-stage"].some((operation) => operation.name === "messages.query" && operation.outcome === "success"),
    "crashed generation must retain the completed native query and its enclosing session stage")
  assert(exits[0].activity?.recentSessionReads.length === 1 && exits[0].activity.recentSessionReads[0].name === "session.exists",
    "crashed generation must retain the earlier completed existence check")
  assert(exits[0].activity?.recent.length === 1 && exits[0].activity.recent[0].name === "task_wait" && exits[0].lastSample,
    "crashed generation must retain the finished tool and last memory sample")
  await listener.stop()
  assert(JSON.parse(readFileSync(join(root, "graceful-stop.json"), "utf8")).cleaned === true, "slow graceful cleanup must finish without forced utility exit")
  await setTimeout(1200)
  assert(JSON.parse(readFileSync(join(root, "generations.json"), "utf8")).length === 2, "explicit stop must not restart")
  markAppQuitting()
  const closed = new Promise<void>((resolve) => window.once("closed", () => resolve()))
  window.close()
  await closed
  assert(window.isDestroyed(), "explicit quit must bypass hide-on-close")
  tray?.destroy()
  clearTimeout(deadline)
  console.log("RECOVERY_FIXTURE_OK tray close/open/quit; real sidecar crash/restart; activity at exit; private owner handoff; slow graceful stop beyond six seconds")
  app.exit(0)
}).catch(async (error) => {
  console.error(error)
  await listener?.stop().catch(() => {})
  tray?.destroy()
  clearTimeout(deadline)
  app.exit(1)
})
