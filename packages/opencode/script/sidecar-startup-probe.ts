/**
 * Temporary startup probe: replicates the desktop sidecar's
 * `import server` + `Server.listen()` path against the production database
 * with the same deferred-startup env profile, timing every step.
 * Not part of the product; delete after diagnosis.
 */
const t0 = Date.now()
const log = (message: string) => console.log(`[${Date.now() - t0}ms] ${message}`)

const hang = setTimeout(() => {
  log("HANG-DETECTED: still not listening after 90s")
  process.exit(42)
}, 90_000)
hang.unref()

log("probe: start")
process.env.OPENCODE_CLIENT = "desktop"
process.env.OPENCODE_DEFER_DB_STARTUP_REPAIRS = "1"
process.env.OPENCODE_DEFER_BACKGROUND_STARTUP = "1"
process.env.OPENCODE_DB = "C:\\Users\\crisc\\.local\\share\\opencode\\opencode.db"
process.env.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY = "true"
process.env.OPENCODE_EXPERIMENTAL_FILEWATCHER = "true"
process.env.XDG_STATE_HOME = process.env.APPDATA + "\\ai.opencode.desktop"
const resources = "C:\\Users\\crisc\\AppData\\Local\\Programs\\@opencode-aidesktop\\resources"
process.env.OPENCODE_PROVIDER_PLUGIN_DIR = resources + "\\plugin-packages\\provider"
process.env.OPENCODE_TUI_PLUGIN_DIR = resources + "\\plugin-packages\\tui"

log("probe: importing server module graph")
const { Server } = await import("../src/server/server")
log("probe: import done")

log("probe: calling Server.listen")
const listener = await Server.listen({ port: 45998, hostname: "127.0.0.1" })
log(`probe: listening at ${listener.url.toString()}`)

await listener.stop(true)
log("probe: stopped cleanly")
process.exit(0)
