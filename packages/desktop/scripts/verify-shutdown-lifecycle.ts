import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Run in an isolated Electron process; never connect to or close the installed app.
const root = resolve(import.meta.dirname, "..")
const temporary = await mkdtemp(join(tmpdir(), "opencode-shutdown-qa-"))
const baseline = process.argv.includes("--baseline")
const service = resolve(root, "src/main/plugin-desktop-services.ts")
try {
  await Bun.write(
    join(temporary, "renderer/speech-overlay.html"),
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><p>Isolated speech overlay</p>',
  )
  await Bun.write(
    join(temporary, "preload/speech-overlay.js"),
    "// No renderer capabilities needed for lifecycle QA.\n",
  )
  const entry = join(temporary, "entry.ts")
  await Bun.write(
    entry,
    `
import { app, BrowserWindow, globalShortcut } from "electron"
import { createPluginDesktopServices } from ${JSON.stringify(service)}
app.setPath("userData", ${JSON.stringify(join(temporary, "user-data"))})
const deadline = setTimeout(() => { console.error("FAIL: isolated Electron did not exit"); app.exit(1) }, 15000)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await window.loadURL("data:text/html,<title>Isolated shutdown QA</title><p>Shutdown lifecycle test</p>")
  let invoke
  const register = globalShortcut.register.bind(globalShortcut)
  globalShortcut.register = (accelerator, callback) => { invoke = callback; return register(accelerator, callback) }
  const manager = createPluginDesktopServices({ getMainWindow: () => window.isDestroyed() ? null : window, logger: console })
  const registered = await manager.register(window.webContents, { pluginID: "shutdown-qa", serviceID: "speech", accelerator: "Ctrl+Alt+Shift+F12" })
  if (!registered.ok) throw new Error(registered.error)
  const invocation = new Promise(resolve => {
    const send = window.webContents.send.bind(window.webContents)
    window.webContents.send = (channel, ...args) => {
      if (channel === "desktop-service-invoked") resolve(args[0])
      else send(channel, ...args)
    }
  })
  invoke()
  const event = await invocation
  manager.update(window.webContents, registered.registrationID, event.invocation.id, { phase: "recording" })
  const overlay = BrowserWindow.getAllWindows().find(item => item !== window)
  if (!overlay) throw new Error("Overlay was not created")
  // Force the same native hidden-window state as an already-dismissed speech overlay.
  overlay.hide()
  let allClosed = false
  app.on("window-all-closed", () => { allClosed = true })
  window.close()
  setTimeout(() => {
    const result = { allClosed, windows: BrowserWindow.getAllWindows().length, shortcutRegistered: globalShortcut.isRegistered("Ctrl+Alt+Shift+F12") }
    const passed = result.allClosed && result.windows === 0 && !result.shortcutRegistered
    console.log(JSON.stringify({ passed, ...result }))
    manager.dispose()
    clearTimeout(deadline)
    app.exit(passed ? 0 : 1)
  }, 250)
}).catch(error => { console.error(error); app.exit(1) })
`,
  )
  const build = await Bun.build({
    entrypoints: [entry],
    outdir: join(temporary, "main"),
    target: "node",
    format: "cjs",
    external: ["electron"],
    plugins: [
      {
        name: "isolated-shutdown-boundaries",
        setup(builder) {
          if (baseline)
            builder.onLoad({ filter: /plugin-desktop-services\.ts$/ }, () => ({
              contents: execFileSync("git", ["show", "HEAD:packages/desktop/src/main/plugin-desktop-services.ts"], {
                cwd: root,
                encoding: "utf8",
              }),
              loader: "ts",
            }))
          // No host keyboard input or foreground-window access is needed to test native window ownership.
          builder.onLoad({ filter: /windows-foreground-input\.ts$/ }, () => ({
            contents: `export async function captureForegroundWindow() { return { ok: true, target: { processID: 0, application: "qa", bounds: { x: 0, y: 0, width: 400, height: 300 } } } }; export async function insertForegroundText() { throw new Error("Input injection is forbidden in shutdown QA") }`,
            loader: "ts",
          }))
        },
      },
    ],
  })
  if (!build.success) throw new Error(build.logs.join("\n"))
  const electron = (await import("electron")).default as unknown as string
  const child = Bun.spawn([electron, join(temporary, "main/entry.js")], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    stdout: "inherit",
    stderr: "inherit",
  })
  const timer = setTimeout(() => child.kill(), 20_000)
  const code = await child.exited.finally(() => clearTimeout(timer))
  if (code !== 0)
    throw new Error(`Isolated shutdown QA (${baseline ? "baseline" : "current"}) failed with exit ${code}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
