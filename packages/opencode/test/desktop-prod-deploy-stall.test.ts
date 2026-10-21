import { describe, expect, test, afterEach } from "bun:test"
import path from "node:path"
import fs from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  DEFAULT_DEPLOY_STALL_THRESHOLD_MS,
  deployStallThresholdMs,
  detectDeployStall,
  readDeployLockPID,
  writeBuildLogHeader,
} from "../script/desktop-prod-deploy"

describe("desktop prod deploy stall detection", () => {
  const savedThreshold = process.env.OPENCODE_DEPLOY_STALL_THRESHOLD_SECONDS
  afterEach(() => {
    if (savedThreshold === undefined) delete process.env.OPENCODE_DEPLOY_STALL_THRESHOLD_SECONDS
    else process.env.OPENCODE_DEPLOY_STALL_THRESHOLD_SECONDS = savedThreshold
  })

  test("frozen transient status snapshot older than the threshold reports stalled with ageSeconds", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "deploy-stall-"))
    try {
      const frozen = new Date(Date.now() - 10 * 60_000).toISOString()
      const statusPath = path.join(dir, "status-20260927T212505Z-9763e658.json")
      await writeFile(
        statusPath,
        JSON.stringify({ status: "fingerprinting-source", buildID: "20260927T212505Z-9763e658", updatedAt: frozen, logPath: "C:\\x\\build.log" }),
      )
      const status = JSON.parse(fs.readFileSync(statusPath, "utf8"))
      const stall = detectDeployStall(status)
      expect(stall?.stalled).toBe(true)
      expect(stall?.ageSeconds).toBeGreaterThanOrEqual(600)
      expect(stall?.ageSeconds).toBeLessThan(700)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("status command annotates a frozen status-<id>.json snapshot without changing it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "deploy-status-cli-"))
    try {
      const buildID = "20260927T212505Z-9763e658"
      const snapshot = JSON.stringify({ status: "fingerprinting-source", buildID, updatedAt: "2026-09-27T21:25:05.823Z" })
      await writeFile(path.join(dir, `status-${buildID}.json`), snapshot)
      await writeFile(path.join(dir, "status.json"), snapshot)
      await writeFile(path.join(dir, "deploy.lock"), JSON.stringify({ pid: 43392 }))
      const result = Bun.spawnSync([process.execPath, "run", "desktop:deploy", "status"], {
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, OPENCODE_DESKTOP_DEPLOY_STATE_DIR: dir },
      })
      expect(result.exitCode).toBe(0)
      const status = JSON.parse(result.stdout.toString())
      expect(status).toMatchObject({ stalled: true, lockPID: 43392 })
      expect(status.ageSeconds).toBeGreaterThan(120)
      expect(fs.readFileSync(path.join(dir, `status-${buildID}.json`), "utf8")).toBe(snapshot)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("reports the PID from deploy.lock alongside the stall", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "deploy-stall-lock-"))
    try {
      const lockPath = path.join(dir, "deploy.lock")
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 43392, startedAt: "2026-09-27T21:25:05.823Z" }))
      const frozen = new Date(Date.now() - 5 * 60_000).toISOString()
      const stall = detectDeployStall({ status: "building", updatedAt: frozen }, { lockPID: readDeployLockPID(lockPath) })
      expect(stall?.stalled).toBe(true)
      expect(stall?.lockPID).toBe(43392)
      expect(stall?.ageSeconds).toBeGreaterThan(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("missing deploy.lock or unreadable lock content still reports stalled without a PID", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "deploy-stall-nolock-"))
    try {
      const frozen = new Date(Date.now() - 5 * 60_000).toISOString()
      const stall = detectDeployStall({ status: "deploying", updatedAt: frozen }, { lockPID: readDeployLockPID(path.join(dir, "absent.lock")) })
      expect(stall?.stalled).toBe(true)
      expect(stall?.lockPID).toBeUndefined()

      const brokenLock = path.join(dir, "deploy.lock")
      fs.writeFileSync(brokenLock, "not json")
      expect(readDeployLockPID(brokenLock)).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fresh transient status does not stall at the 120s default", () => {
    const fresh = new Date(Date.now() - 10_000).toISOString()
    expect(detectDeployStall({ status: "packaging", updatedAt: fresh })).toBeUndefined()
  })

  test.each(["ready", "failed", "completed", "deployed", "discarded"])("terminal status %s never stalls", (phase) => {
    const frozen = new Date(Date.now() - 60 * 60_000).toISOString()
    expect(detectDeployStall({ status: phase, updatedAt: frozen })).toBeUndefined()
  })

  test("status without a parseable updatedAt does not stall", () => {
    expect(detectDeployStall({ status: "building", updatedAt: "not-a-date" })).toBeUndefined()
  })

  test("OPENCODE_DEPLOY_STALL_THRESHOLD_SECONDS overrides the threshold", () => {
    process.env.OPENCODE_DEPLOY_STALL_THRESHOLD_SECONDS = "3600"
    const fiveMinutesOld = new Date(Date.now() - 5 * 60_000).toISOString()
    expect(deployStallThresholdMs()).toBe(3_600_000)
    expect(detectDeployStall({ status: "staging", updatedAt: fiveMinutesOld })).toBeUndefined()

    process.env.OPENCODE_DEPLOY_STALL_THRESHOLD_SECONDS = "60"
    expect(deployStallThresholdMs()).toBe(60_000)
    const stall = detectDeployStall({ status: "staging", updatedAt: fiveMinutesOld })
    expect(stall?.stalled).toBe(true)
  })

  test("default threshold is 120 seconds and invalid overrides fall back to it", () => {
    delete process.env.OPENCODE_DEPLOY_STALL_THRESHOLD_SECONDS
    expect(DEFAULT_DEPLOY_STALL_THRESHOLD_MS).toBe(120_000)
    expect(deployStallThresholdMs()).toBe(120_000)
    process.env.OPENCODE_DEPLOY_STALL_THRESHOLD_SECONDS = "not-a-number"
    expect(deployStallThresholdMs()).toBe(120_000)
    process.env.OPENCODE_DEPLOY_STALL_THRESHOLD_SECONDS = "0"
    expect(deployStallThresholdMs()).toBe(120_000)
  })
})

describe("desktop prod deploy build log header", () => {
  test("creates build-<id>.log with buildID, PID and start time before the first status", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "deploy-log-header-"))
    try {
      const logPath = path.join(dir, "build-20260927T212505Z-9763e658.log")
      writeBuildLogHeader(logPath, "20260927T212505Z-9763e658")
      const header = fs.readFileSync(logPath, "utf8")
      expect(header).toContain(`BUILD   : 20260927T212505Z-9763e658`)
      expect(header).toContain(`PID     : ${process.pid}`)
      expect(header).toMatch(/STARTED : \d{4}-\d{2}-\d{2}T/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("appends without clobbering an existing log", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "deploy-log-append-"))
    try {
      const logPath = path.join(dir, "build-existing.log")
      fs.writeFileSync(logPath, "earlier output\n")
      writeBuildLogHeader(logPath, "build-2")
      const content = fs.readFileSync(logPath, "utf8")
      expect(content.startsWith("earlier output\n")).toBe(true)
      expect(content).toContain("BUILD   : build-2")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
