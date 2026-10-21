import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { copyPluginPackages } from "../../../script/plugin-package-artifacts"

const electron = createRequire(import.meta.url)("electron") as unknown
if (typeof electron !== "string") throw new Error("Could not resolve the Electron executable")

const root = await mkdtemp(join(tmpdir(), "opencode-electron-smoke-launcher-"))
const workspace = join(root, "workspace")
await mkdir(workspace)
copyPluginPackages(resolve("../provider-plugins"), join(workspace, "plugin-packages", "provider"))
copyPluginPackages(resolve("../tui-plugins"), join(workspace, "plugin-packages", "tui"))
const output = { stdout: "", stderr: "" }
const child = spawn(electron, ["--no-sandbox", "--disable-gpu", `--user-data-dir=${root}`, resolve("scripts/verify-plugin-services-sidecar.mjs"), workspace], {
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", OPENCODE_PLUGIN_SMOKE_WORKSPACE: workspace },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
})
child.stdout.on("data", (chunk: Buffer) => output.stdout = `${output.stdout}${chunk.toString("utf8")}`.slice(-20_000))
child.stderr.on("data", (chunk: Buffer) => output.stderr = `${output.stderr}${chunk.toString("utf8")}`.slice(-20_000))

const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
  child.once("error", reject)
  child.once("exit", (code, signal) => done({ code, signal }))
})
let watchdog: ReturnType<typeof setTimeout> | undefined
const result = await Promise.race([
  exit,
  new Promise<never>((_, reject) => {
    watchdog = setTimeout(
      () => reject(new Error(diagnostics("Electron Plugin Services smoke exceeded the 100000ms hard deadline", output))),
      100_000,
    )
  }),
]).finally(async () => {
  if (watchdog) clearTimeout(watchdog)
  if (child.exitCode === null && child.signalCode === null) await terminateTree(child, exit)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

if (result.code !== 0) {
  throw new Error(diagnostics(`Electron Plugin Services smoke exited with code ${result.code} signal ${result.signal}`, output))
}
console.log(output.stdout.trim())
if (output.stderr.trim()) console.error(output.stderr.trim())

async function terminateTree(process: ChildProcess, exited: Promise<unknown>) {
  if (process.exitCode !== null || process.signalCode !== null || process.pid === undefined) return
  if (globalThis.process.platform === "win32") {
    const taskkill = spawn("taskkill.exe", ["/PID", String(process.pid), "/T", "/F"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    await Promise.race([
      new Promise<void>((done) => taskkill.once("exit", () => done())),
      delay(10_000).then(() => taskkill.kill("SIGKILL")),
    ])
  } else {
    process.kill("SIGKILL")
  }
  await Promise.race([exited, delay(10_000)])
}

function diagnostics(message: string, value: { stdout: string; stderr: string }) {
  return `${message}\n--- stdout ---\n${value.stdout.trim() || "<empty>"}\n--- stderr ---\n${value.stderr.trim() || "<empty>"}`
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
