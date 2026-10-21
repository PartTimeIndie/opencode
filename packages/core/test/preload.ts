// xdg-basedir reads env vars at import time; keep this preload import-free from core src.
import { afterAll } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { setTimeout as sleep } from "node:timers/promises"

const dir = path.join(os.tmpdir(), "opencode-core-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
process.env["OPENCODE_TEST_HOME"] = path.join(dir, "home")
process.env["OPENCODE_DB"] = ":memory:"

afterAll(async () => {
  const busy = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY"
  const rm = async (left: number): Promise<void> => {
    Bun.gc(true)
    await sleep(100)
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch (error) {
      if (!busy(error)) throw error
      if (left <= 1 && process.platform !== "win32") throw error
      if (left <= 1) return
      await rm(left - 1)
    }
  }

  await rm(30)
})
