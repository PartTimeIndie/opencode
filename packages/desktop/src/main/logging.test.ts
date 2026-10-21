import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let electronRoot = ""
let packaged = false
let consoleLevelAtInitialize: string | boolean | undefined
let consoleWriteFn = (_options?: unknown) => undefined
const consoleTransport = {
  level: "info" as string | boolean,
  writeFn: (options?: unknown) => consoleWriteFn(options),
}

mock.module("electron", () => ({
  app: {
    getName: () => "OpenCode Test",
    getPath: () => electronRoot || tmpdir(),
    getVersion: () => "0.0.0-test",
    get isPackaged() {
      return packaged
    },
    setPath: () => undefined,
  },
  crashReporter: {
    start: () => undefined,
  },
  netLog: {
    currentlyLogging: false,
    startLogging: async () => undefined,
    stopLogging: async () => undefined,
  },
  shell: {
    showItemInFolder: () => undefined,
  },
}))

mock.module("electron-log/main.js", () => {
  const scoped = { error: () => undefined, info: () => undefined, log: () => undefined, warn: () => undefined }
  return {
    default: {
      transports: {
        file: {
          maxSize: 0,
          resolvePathFn: undefined,
          getFile: () => ({ path: join(electronRoot || tmpdir(), "main.log") }),
        },
        console: consoleTransport,
      },
      initialize: () => {
        consoleLevelAtInitialize = consoleTransport.level
      },
      scope: () => scoped,
    },
  }
})

const { initLogging, loggingTest } = await import("./logging")

const roots: string[] = []

describe("desktop logging debug export helpers", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
    electronRoot = ""
    packaged = false
    consoleLevelAtInitialize = undefined
    consoleWriteFn = () => undefined
    consoleTransport.level = "info"
    consoleTransport.writeFn = (options?: unknown) => consoleWriteFn(options)
  })

  test("collect keeps recent files and records skipped entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-logging-"))
    roots.push(root)
    electronRoot = root
    await mkdir(join(root, "nested"))
    await writeFile(join(root, "current.log"), "current\n")
    await writeFile(join(root, "nested", "recent.log"), "recent\n")
    await writeFile(join(root, "old.log"), "old\n")
    await writeFile(join(root, "heap.heapsnapshot"), "{}\n")
    await utimes(join(root, "old.log"), new Date(Date.now() - 25 * 60 * 60 * 1000), new Date(Date.now() - 25 * 60 * 60 * 1000))
    await symlink(root, join(root, "loop"), process.platform === "win32" ? "junction" : "dir").catch(() => undefined)

    const result = loggingTest.collect(root, "desktop")

    expect(result.entries.map((entry) => entry.name).sort()).toEqual([
      "desktop/current.log",
      "desktop/nested/recent.log",
    ])
    expect(result.skipped.map((entry) => entry.reason)).toEqual(
      expect.arrayContaining(["heapsnapshot", "older-than-export-window"]),
    )
  })

  test("debug export filenames are unique zip names", () => {
    const first = loggingTest.debugOutputFilename()
    const second = loggingTest.debugOutputFilename()

    expect(first).toMatch(/^opencode-debug-\d{8}T\d{6}-[a-f0-9]{8}\.zip$/)
    expect(second).toMatch(/^opencode-debug-\d{8}T\d{6}-[a-f0-9]{8}\.zip$/)
    expect(first).not.toBe(second)
  })

  test("disables console transport when stdout pipe is broken", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-logging-"))
    roots.push(root)
    electronRoot = root
    consoleWriteFn = () => {
      throw Object.assign(new Error("broken pipe"), { code: "EPIPE" })
    }

    initLogging()

    expect(() => consoleTransport.writeFn({})).not.toThrow()
    expect(consoleTransport.level).toBe(false)
  })

  test("disables console transport before packaged logger initialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-logging-"))
    roots.push(root)
    electronRoot = root
    packaged = true

    initLogging()

    expect(consoleLevelAtInitialize).toBe(false)
    expect(consoleTransport.level).toBe(false)
  })
})
