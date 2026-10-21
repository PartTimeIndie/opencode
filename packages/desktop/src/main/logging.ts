import type { MainLogger } from "electron-log"
import log from "electron-log/main.js"
import { app, crashReporter, netLog, shell } from "electron"
import { randomUUID } from "node:crypto"
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs"
import { Readable, Writable } from "node:stream"
import { ZipWriter, TextReader } from "@zip.js/zip.js"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

const MAX_LOG_AGE_DAYS = 7
const TAIL_LINES = 1000
const EXPORT_WINDOW = 24 * 60 * 60 * 1000
const MAX_EXPORT_FILE_SIZE = 50 * 1024 * 1024
const NET_LOG_SIZE = 20 * 1024 * 1024

let root = ""
let run = ""
let netLogPath: string | undefined
let exportQueue = Promise.resolve()

let logger: MainLogger
export const getLogger = () => logger

export function initLogging() {
  initRunDirectory()
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.file.resolvePathFn = (_vars, message) =>
    join(
      run,
      `${safeLogName(message?.scope ?? (message?.variables?.processType === "renderer" ? "renderer" : "main"))}.log`,
    )
  if (app.isPackaged) log.transports.console.level = false
  log.initialize({ preload: false, spyRendererConsole: true })
  if (!app.isPackaged) initConsoleTransport()
  cleanup()
  return (logger = log)
}

export function initCrashReporter() {
  const dir = join(app.getPath("userData"), "Crashpad")
  mkdirSync(dir, { recursive: true })
  app.setPath("crashDumps", dir)
  crashReporter.start({ uploadToServer: false, compress: true })
  write("crash", "crash reporter started", { path: dir })
}

export async function startNetLog() {
  if (netLog.currentlyLogging) return
  netLogPath = join(run, "network.netlog")
  await netLog.startLogging(netLogPath, { captureMode: "default", maxFileSize: NET_LOG_SIZE })
  write("network", "net log started", { path: netLogPath })
}

export async function exportDebugLogs() {
  const next = exportQueue.then(() => exportDebugLogsUnlocked(), () => exportDebugLogsUnlocked())
  exportQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

async function exportDebugLogsUnlocked() {
  const restartNetLog = netLog.currentlyLogging
  if (restartNetLog) {
    await netLog.stopLogging().catch((error) => write("network", "failed to stop net log", { error }))
  }

  const output = join(app.getPath("downloads"), debugOutputFilename())
  try {
    const skipped: SkippedEntry[] = []
    const entries = [
      ...collect(root, "desktop", skipped),
      ...serverLogRoots().flatMap((dir, i) => collect(dir, `server-${i + 1}`, skipped)),
      ...collect(app.getPath("crashDumps"), "crashpad", skipped),
    ]
    write("main", "exporting debug logs", { output })
    await writeZip(output, entries, skipped)
    shell.showItemInFolder(output)
    return output
  } finally {
    if (restartNetLog) {
      await startNetLog().catch((error) => {
        write("network", "failed to restart net log", { error })
        throw error
      })
    }
  }
}

export function write(
  name: string,
  message: string,
  extra?: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
) {
  if (!run) return
  const scoped = log.scope(safeLogName(name))
  if (extra !== undefined) {
    scoped[level](message, extra)
    return
  }
  scoped[level](message)
}

export function tail(): string {
  try {
    const path = log.transports.file.getFile().path
    const contents = readFileSync(path, "utf8")
    const lines = contents.split("\n")
    return lines.slice(Math.max(0, lines.length - TAIL_LINES)).join("\n")
  } catch {
    return ""
  }
}

function initRunDirectory() {
  root = join(app.getPath("userData"), "logs")
  run = join(root, stamp())
  mkdirSync(run, { recursive: true })
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
}

function debugOutputFilename() {
  return `opencode-debug-${stamp()}-${randomUUID().slice(0, 8)}.zip`
}

function safeLogName(name: string) {
  return name.replace(/[^a-z0-9_.-]/gi, "_") || "main"
}

function cleanup() {
  const dir = root || dirname(log.transports.file.getFile().path)
  const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000

  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry)
    try {
      const info = statSync(file)
      if (info.mtimeMs < cutoff) rmSync(file, { recursive: true, force: true })
    } catch {
      continue
    }
  }
}

function manifest(skipped: SkippedEntry[]) {
  return {
    generated: new Date().toISOString(),
    version: app.getVersion(),
    name: app.getName(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
    uptime: process.uptime(),
    userData: app.getPath("userData"),
    logs: root,
    currentRun: run,
    crashDumps: app.getPath("crashDumps"),
    serverLogs: serverLogRoots(),
    netLog: netLogPath,
    skipped,
  }
}

function serverLogRoots() {
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const xdgState = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return [
    ...new Set([
      join(xdgData, "opencode", "log"),
      join(xdgState, "opencode", "log"),
      join(app.getPath("userData"), "opencode", "log"),
    ]),
  ]
}

type Entry = { name: string; path: string }
type SkippedEntry = { name: string; path: string; reason: string }

function collect(dir: string, prefix: string, skipped: SkippedEntry[]): Entry[] {
  if (!existsSync(dir)) return []
  const cutoff = Date.now() - EXPORT_WINDOW
  const result: Entry[] = []
  const seen = new Set<string>()
  const skip = (name: string, file: string, reason: string) => skipped.push({ name, path: file, reason })
  const walk = (current: string, relative = "") => {
    const currentName = join(prefix, relative).replace(/\\/g, "/")
    let real = ""
    try {
      real = realpathSync(current)
    } catch {
      skip(currentName, current, "realpath-failed")
      return
    }
    if (seen.has(real)) {
      skip(currentName, current, "cycle")
      return
    }
    seen.add(real)

    for (const entry of safeReadDir(current, currentName, skipped)) {
      const file = join(current, entry)
      const name = join(prefix, relative, entry).replace(/\\/g, "/")
      const info = safeLstat(file, name, skipped)
      if (!info) continue
      if (info.isSymbolicLink()) {
        skip(name, file, "symlink")
        continue
      }
      if (info.isDirectory()) {
        walk(file, join(relative, entry))
        continue
      }
      if (info.mtimeMs < cutoff) {
        skip(name, file, "older-than-export-window")
        continue
      }
      if (info.size > MAX_EXPORT_FILE_SIZE) {
        skip(name, file, "larger-than-export-limit")
        continue
      }
      if (file.endsWith(".heapsnapshot")) {
        skip(name, file, "heapsnapshot")
        continue
      }
      result.push({ name, path: file })
    }
  }
  walk(dir)
  return result
}

async function writeZip(output: string, entries: Entry[], skipped: SkippedEntry[]) {
  const stream = createWriteStream(output)
  const writer = new ZipWriter<void>(Writable.toWeb(stream) as WritableStream<Uint8Array>)
  for (const entry of entries) {
    try {
      await writer.add(entry.name, Readable.toWeb(createReadStream(entry.path)) as ReadableStream<Uint8Array>)
    } catch (error) {
      skipped.push({ name: entry.name, path: entry.path, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  await writer.add("manifest.json", new TextReader(JSON.stringify(manifest(skipped), null, 2)))
  await writer.close()
}

function safeReadDir(dir: string, name: string, skipped: SkippedEntry[]) {
  try {
    return readdirSync(dir)
  } catch (error) {
    skipped.push({ name, path: dir, reason: error instanceof Error ? error.message : "readdir-failed" })
    return []
  }
}

function safeLstat(file: string, name: string, skipped: SkippedEntry[]) {
  try {
    return lstatSync(file)
  } catch (error) {
    skipped.push({ name, path: file, reason: error instanceof Error ? error.message : "stat-failed" })
    return undefined
  }
}

function initConsoleTransport() {
  const write = log.transports.console.writeFn.bind(log.transports.console)
  log.transports.console.writeFn = (options) => {
    try {
      write(options)
    } catch (err) {
      if (!isBrokenPipe(err)) throw err
      log.transports.console.level = false
    }
  }
}

function isBrokenPipe(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EPIPE"
}

/** @internal Exported for testing. */
export const loggingTest = {
  collect(dir: string, prefix: string) {
    const skipped: SkippedEntry[] = []
    return { entries: collect(dir, prefix, skipped), skipped }
  },
  debugOutputFilename,
  manifest,
}
