import { Duration, Effect, Formatter, Logger, type LogLevel } from "effect"
import { appendFile, copyFile, mkdir, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises"
import path from "path"
import { Global } from "../global"
import { runID } from "./shared"
import { GrowthBudgets } from "../maintenance/growth-budgets"

const logGenerations = 3
const lockStaleMilliseconds = 30_000
const lockWaitMilliseconds = 2_000

export interface FileLoggerOptions {
  readonly maxBytes?: number
  readonly generations?: number
  readonly batchWindow?: Duration.Input
  readonly lockStaleMilliseconds?: number
  readonly lockWaitMilliseconds?: number
}

function formatter(id: string = runID) {
  return Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]
    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", id],
      ...messages.flatMap((value) => (plain(value) ? flatten(value) : [["message", value] as const])),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ")
  })
}

function flatten(
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]]
  seen.add(input)
  const entries = Object.entries(input)
  if (entries.length === 0 && prefix) return [[prefix, input]]
  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return plain(value) ? flatten(value, path, seen) : [[path, value] as const]
  })
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function format(input: unknown) {
  const value = typeof input === "string" ? input : Formatter.format(input)
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

export async function rotateLogFile(file: string, maxBytes = GrowthBudgets.runtimeLogMaxBytes(), generations = logGenerations) {
  if (generations < 1) return
  const current = await stat(file).catch(() => undefined)
  if (!current || current.size < maxBytes) return

  // Keep the active pathname in place. Copying and then truncating means even an
  // older OpenCode process with an inherited open handle keeps writing to the
  // visible, bounded file instead of an unlinked generation on Windows.
  const staging = `${file}.rotation-${process.pid}-${crypto.randomUUID()}`
  await copyFile(file, staging)
  try {
    await rm(`${file}.${generations}`, { force: true })
    for (const generation of Array.from({ length: generations - 1 }, (_, index) => generations - 1 - index)) {
      await rename(`${file}.${generation}`, `${file}.${generation + 1}`).catch(() => undefined)
    }
    await rename(staging, `${file}.1`)
    await truncate(file, 0)
  } finally {
    await rm(staging, { force: true }).catch(() => undefined)
  }
}

export function fileLogger(
  file = path.join(Global.Path.log, "opencode.log"),
  id: string = runID,
  options: FileLoggerOptions = {},
) {
  const config: Required<FileLoggerOptions> = {
    maxBytes: Math.max(1, options.maxBytes ?? GrowthBudgets.runtimeLogMaxBytes()),
    generations: Math.max(1, options.generations ?? logGenerations),
    batchWindow: options.batchWindow ?? Duration.seconds(1),
    lockStaleMilliseconds: options.lockStaleMilliseconds ?? lockStaleMilliseconds,
    lockWaitMilliseconds: options.lockWaitMilliseconds ?? lockWaitMilliseconds,
  }
  return Logger.batched(formatter(id), {
    window: config.batchWindow,
    flush: (messages) =>
      Effect.promise(() =>
        withLogLock(file, config, async () => {
          await appendBounded(file, Buffer.from(`${messages.join("\n")}\n`), config)
        }).catch(() => undefined),
      ),
  })
}

async function appendBounded(file: string, output: Buffer, options: Required<FileLoggerOptions>): Promise<void> {
  await rotateLogFile(file, options.maxBytes, options.generations)
  const current = await stat(file).catch(() => undefined)
  const available = options.maxBytes - (current?.size ?? 0)
  if (output.length <= options.maxBytes && output.length > available && current) {
    await rotateLogFile(file, current.size, options.generations)
    await appendFile(file, output)
    return
  }
  const chunk = output.subarray(0, available)
  await appendFile(file, chunk)
  if (chunk.length === output.length) return
  await appendBounded(file, output.subarray(chunk.length), options)
}

async function withLogLock(file: string, options: Required<FileLoggerOptions>, use: () => Promise<void>) {
  const lock = `${file}.lock`
  const deadline = Date.now() + options.lockWaitMilliseconds
  while (true) {
    try {
      await mkdir(lock)
      try {
        await writeFile(path.join(lock, "owner"), `${process.pid}\n${Date.now()}\n`, "utf8")
        await use()
      } finally {
        await rm(lock, { recursive: true, force: true }).catch(() => undefined)
      }
      return
    } catch (error) {
      if (errorCode(error) !== "EEXIST" || Date.now() >= deadline) return
      await recoverStaleLock(lock, options.lockStaleMilliseconds)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

async function recoverStaleLock(lock: string, staleMilliseconds: number) {
  const metadata = await stat(lock).catch(() => undefined)
  if (!metadata || Date.now() - metadata.mtimeMs < staleMilliseconds) return
  const owner = await readFile(path.join(lock, "owner"), "utf8").catch(() => "")
  const pid = Number.parseInt(owner.split("\n")[0] ?? "", 10)
  if (Number.isInteger(pid) && processAlive(pid)) return
  const stale = `${lock}.stale-${process.pid}-${crypto.randomUUID()}`
  await rename(lock, stale).catch(() => undefined)
  await rm(stale, { recursive: true, force: true }).catch(() => undefined)
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === "EPERM"
  }
}

function errorCode(input: unknown) {
  if (!(input instanceof Error) || !("code" in input) || typeof input.code !== "string") return
  return input.code
}

const stderrLogger = Logger.make((options) => process.stderr.write(formatter().log(options) + "\n"))

export function minimumLogLevel() {
  const value = process.env.OPENCODE_LOG_LEVEL?.toUpperCase()
  const levels = {
    TRACE: "Trace",
    DEBUG: "Debug",
    INFO: "Info",
    WARN: "Warn",
    ERROR: "Error",
  } as const satisfies Record<string, LogLevel.LogLevel>
  return value && value in levels ? levels[value as keyof typeof levels] : levels.INFO
}

export function loggers() {
  return process.env.OPENCODE_PRINT_LOGS === "1" ? [fileLogger(), stderrLogger] : [fileLogger()]
}

export * as Logging from "./logging"
