import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  acquireDeployLockAt,
  assertFreeMemoryForBuild,
  assertNoCompetingWriters,
  assertUnchangedFingerprint,
  currentProcessStartedAt,
  evaluateDeployLock,
  filterCompetingWriters,
  MIN_BUILD_FREE_MEMORY_BYTES,
  minBuildFreeMemoryBytes,
  ownedViteDevServer,
  viteDevServerLaunch,
  parseDeployLock,
  type ProcessEntry,
} from "../script/desktop-prod-deploy"

const GiB = 1024 * 1024 * 1024
const orphanPID = 999999 // Windows PIDs are multiples of four, so this never exists.

describe("desktop deploy lock", () => {
  test("parses current JSON locks and legacy bare-PID locks", () => {
    expect(parseDeployLock(JSON.stringify({ pid: 1234, startedAt: "2026-09-08T10:00:00.000Z" }))).toEqual({
      pid: 1234,
      startedAt: "2026-09-08T10:00:00.000Z",
    })
    expect(parseDeployLock("4567")).toEqual({ pid: 4567, startedAt: "" })
    expect(parseDeployLock("")).toBeUndefined()
    expect(parseDeployLock("garbage")).toBeUndefined()
  })

  test("keeps a lock active only for the same living process", () => {
    const lock = { pid: 100, startedAt: "2026-09-08T10:00:00.000Z" }
    expect(evaluateDeployLock(lock, true, lock.startedAt).active).toBe(true)
    expect(evaluateDeployLock(lock, true, null).active).toBe(true)
    expect(evaluateDeployLock({ pid: 100, startedAt: "" }, true, "2026-09-08T10:00:00.000Z").active).toBe(true)
  })

  test("adopts orphaned locks after a confirmed missing PID or PID reuse", () => {
    const lock = { pid: 100, startedAt: "2026-09-08T10:00:00.000Z" }
    const gone = evaluateDeployLock(lock, false, null)
    expect(gone.active).toBe(false)
    expect(gone.reason).toContain("no longer running")
    const reused = evaluateDeployLock(lock, true, "2020-01-01T00:00:00.000Z")
    expect(reused.active).toBe(false)
    expect(reused.reason).toContain("reused")
  })

  test("acquires through a real lock file and adopts orphaned and legacy locks", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-deploy-lock-"))
    try {
      const lockPath = path.join(directory, "deploy.lock")
      const own = { pid: process.pid, startedAt: currentProcessStartedAt(process.pid) ?? "" }

      fs.writeFileSync(lockPath, JSON.stringify({ pid: orphanPID, startedAt: "2026-01-01T00:00:00.000Z" }))
      const releaseOne = acquireDeployLockAt(lockPath, own, () => null)
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(own)
      releaseOne()
      expect(fs.existsSync(lockPath)).toBe(false)

      fs.writeFileSync(lockPath, String(orphanPID))
      const releaseTwo = acquireDeployLockAt(lockPath, own, () => null)
      releaseTwo()

      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" }))
      expect(() => acquireDeployLockAt(lockPath, own, () => "2026-01-01T00:00:00.000Z")).toThrow(
        new RegExp(`another desktop deploy owns .*PID ${process.pid}`),
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("adopts a lock whose PID was reused by a different process", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-deploy-lock-"))
    try {
      const lockPath = path.join(directory, "deploy.lock")
      // This process is alive, but the recorded start time predates it: the
      // original owner is confirmed gone despite the PID responding.
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z" }))
      const own = { pid: process.pid, startedAt: "2026-09-08T10:00:00.000Z" }
      const release = acquireDeployLockAt(lockPath, own, () => "2026-09-08T10:00:00.000Z")
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(own)
      release()
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("desktop build prerequisites", () => {
  test("blocks the build on simulated memory shortage with an understandable message", () => {
    expect(() => assertFreeMemoryForBuild(2 * GiB, 4 * GiB)).toThrow(/build blocked: only 2\.0 GiB .* 4\.0 GiB/)
    expect(() => assertFreeMemoryForBuild(4 * GiB, 4 * GiB)).not.toThrow()
    expect(() => assertFreeMemoryForBuild(6.5 * GiB, 4 * GiB)).not.toThrow()
  })

  test("uses a 1.5-GiB default with an environment override", () => {
    const previous = process.env.OPENCODE_DEPLOY_MIN_FREE_MEMORY_MB
    try {
      delete process.env.OPENCODE_DEPLOY_MIN_FREE_MEMORY_MB
      expect(MIN_BUILD_FREE_MEMORY_BYTES).toBe(1.5 * GiB)
      expect(minBuildFreeMemoryBytes()).toBe(1.5 * GiB)
      expect(() => assertFreeMemoryForBuild(1.4 * GiB)).toThrow(/build blocked: only 1\.4 GiB .* 1\.5 GiB/)
      expect(() => assertFreeMemoryForBuild(1.5 * GiB)).not.toThrow()
      process.env.OPENCODE_DEPLOY_MIN_FREE_MEMORY_MB = "2048"
      expect(minBuildFreeMemoryBytes()).toBe(2 * GiB)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_DEPLOY_MIN_FREE_MEMORY_MB
      else process.env.OPENCODE_DEPLOY_MIN_FREE_MEMORY_MB = previous
    }
  })

  test("flags only foreign build-tool processes working in the source tree", () => {
    const root = "C:\\GitRepros\\opencode"
    const entries: ProcessEntry[] = [
      { pid: 4321, name: "bun.exe", commandLine: `${root}\\packages\\opencode bun test` },
      { pid: 4322, name: "git.exe", commandLine: `git -C ${root} status` },
      { pid: 4323, name: "explorer.exe", commandLine: `${root} file explorer` },
      { pid: 4324, name: "bun.exe", commandLine: "bun test C:\\other\\project" },
      { pid: process.pid, name: "bun.exe", commandLine: `${root} desktop-prod-deploy prepare` },
      { pid: 4325, name: "bun.exe", commandLine: `${root}\\packages\\opencode desktop-prod-deploy worker` },
    ]
    const competing = filterCompetingWriters(entries, root, process.pid)
    expect(competing.map((entry) => entry.pid)).toEqual([4321, 4322])
    expect(() => assertNoCompetingWriters([], root, process.pid)).not.toThrow()
    expect(() => assertNoCompetingWriters(entries, root, process.pid)).toThrow(
      /build blocked: 2 competing process\(es\).*PID 4321 bun\.exe/,
    )
  })

  test("pauses only this checkout's exact Vite dev process tree", () => {
    const root = "E:\\GitRepros\\opencode"
    const entries: ProcessEntry[] = [
      { pid: 10, name: "bun.exe", commandLine: "bun  run dev ", parentPid: 1 },
      { pid: 11, name: "vite.exe", commandLine: `${root}\\packages\\app\\node_modules\\.bin\\vite.exe`, parentPid: 10 },
      { pid: 12, name: "node.exe", commandLine: `node "${root}\\packages\\app\\node_modules\\vite\\bin\\vite.js"`, parentPid: 11 },
      { pid: 14, name: "conhost.exe", commandLine: "\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4", parentPid: 11 },
    ]
    expect(ownedViteDevServer(entries, root)?.pid).toBe(10)
    expect(ownedViteDevServer(entries.map((entry) => entry.pid === 10 ? { ...entry, commandLine: 'C:\\Users\\crisc\\.bun\\bin\\bun.exe run dev' } : entry), root)?.pid).toBe(10)
    expect(ownedViteDevServer(entries, "C:\\GitRepros\\opencode")).toBeUndefined()
    expect(ownedViteDevServer([...entries, { pid: 13, parentPid: 11, name: "python.exe", commandLine: "python writer.py" }], root)).toBeUndefined()
    expect(ownedViteDevServer(entries.map((entry) => entry.pid === 10 ? { ...entry, commandLine: "bun run test" } : entry), root)).toBeUndefined()
    expect(viteDevServerLaunch(root)).toEqual({ command: [process.execPath, "run", "dev"], cwd: path.join(root, "packages", "app") })
    const options = "--host 127.0.0.1 --port 5192 --strictPort"
    const configured = entries.map((entry) => ({
      ...entry,
      commandLine: entry.pid === 10 ? `"C:\\Users\\crisc\\.bun\\bin\\bun.exe" run dev ${options}` :
        entry.pid === 11 || entry.pid === 12 ? `${entry.commandLine} ${options}` : entry.commandLine,
    }))
    const owned = ownedViteDevServer(configured, root)
    expect(owned?.pid).toBe(10)
    expect(viteDevServerLaunch(root, owned).command).toEqual([process.execPath, "run", "dev", "--host", "127.0.0.1", "--port", "5192", "--strictPort"])
    expect(ownedViteDevServer(configured.map((entry) => entry.pid === 12 ? { ...entry, commandLine: "node other.js" } : entry), root)).toBeUndefined()
  })

  test("detects source changes for both guarded build phases", () => {
    expect(() => assertUnchangedFingerprint("abc123", "abc123", "while the build was running")).not.toThrow()
    expect(() => assertUnchangedFingerprint("abc123", "def456", "while the web frontend was building")).toThrow(
      /deployable source changed while the web frontend was building/,
    )
  })

  test("reads the current process start time consistently", () => {
    const startedAt = currentProcessStartedAt(process.pid)
    if (startedAt === null) return
    expect(currentProcessStartedAt(process.pid)).toBe(startedAt)
    expect(startedAt.length).toBeGreaterThan(0)
  })
})

describe("desktop deploy prepare smoke under simulated memory shortage", () => {
  const smokeScriptPath = path.resolve(import.meta.dir, "..", "script", "desktop-prod-deploy.ts")

  test("ends before packaging, installation, or ASAR swap with a clear blocker", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-deploy-memory-smoke-"))
    try {
      const installDir = path.join(parent, "@opencode-aidesktop")
      fs.mkdirSync(path.join(installDir, "resources"), { recursive: true })
      fs.writeFileSync(path.join(installDir, "OpenCode.exe"), "installed")
      fs.writeFileSync(path.join(installDir, "resources", "app.asar"), "installed asar")
      const stateDir = path.join(parent, "deploy-state")
      fs.mkdirSync(stateDir, { recursive: true })

      // 1,048,576 MiB (1 TiB) can never be free, so the memory guard fires
      // deterministically before the web frontend build starts.
      const result = Bun.spawnSync([process.execPath, "run", smokeScriptPath, "prepare"], {
        cwd: path.resolve(import.meta.dir, ".."),
        env: {
          ...process.env,
          OPENCODE_DESKTOP_INSTALL_DIR: installDir,
          OPENCODE_DESKTOP_DEPLOY_STATE_DIR: stateDir,
          OPENCODE_DEPLOY_MIN_FREE_MEMORY_MB: "1048576",
        },
        stdout: "pipe",
        stderr: "pipe",
      })

      expect(result.exitCode).not.toBe(0)
      const stderr = result.stderr.toString()
      expect(stderr).toMatch(
        /FAILED: build blocked: only \d+\.\d GiB of memory is free, but the desktop build needs at least 1024\.0 GiB\./,
      )
      expect(stderr).toContain("Close applications to free memory and retry")

      const status = JSON.parse(fs.readFileSync(path.join(stateDir, "status.json"), "utf8"))
      expect(status.status).toBe("failed")
      expect(status.error).toContain("build blocked: only")
      expect(status.error).toContain("at least 1024.0 GiB")

      // The run died before packaging, staging, installation, or any ASAR swap:
      // no stage/backup/failed directory exists and the installed bytes are untouched.
      expect(
        fs.readdirSync(parent).filter((name) => name.includes("@opencode-aidesktop.")),
      ).toEqual([])
      expect(fs.readFileSync(path.join(installDir, "OpenCode.exe"), "utf8")).toBe("installed")
      expect(fs.readFileSync(path.join(installDir, "resources", "app.asar"), "utf8")).toBe("installed asar")

      // The exclusive lock is documented with PID plus start time and released again.
      expect(fs.existsSync(path.join(stateDir, "deploy.lock"))).toBe(false)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  }, 120_000)
})
