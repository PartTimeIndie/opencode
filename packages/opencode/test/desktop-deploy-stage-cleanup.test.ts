import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  assertPrepareCanStart,
  cleanOrphanedDeployStages,
  PreparedDeploymentExistsError,
  type StageCleanupResult,
} from "../script/desktop-prod-deploy"

const installName = "@opencode-aidesktop"
const stageTS = "20240101T000000Z"
const roots: string[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
})

function sandbox() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-deploy-stages-"))
  roots.push(parent)
  const installDir = path.join(parent, installName)
  fs.mkdirSync(installDir, { recursive: true })
  fs.writeFileSync(path.join(installDir, "OpenCode.exe"), "installed")
  return { parent, installDir }
}

function stageName(id: string) {
  return `${installName}.deploy-${stageTS}-${id}`
}

function makeStage(parent: string, name: string, target?: string) {
  const candidate = path.join(parent, name)
  if (target) {
    fs.symlinkSync(target, candidate, "junction")
    return candidate
  }
  fs.mkdirSync(candidate, { recursive: true })
  fs.writeFileSync(path.join(candidate, "OpenCode.exe"), "staged")
  return candidate
}

function status(statusValue: string, buildID = `build-${statusValue}`) {
  return { status: statusValue, updatedAt: new Date().toISOString(), buildID }
}

function cleanup(parent: string, installDir: string, statusValue: string): StageCleanupResult {
  return cleanOrphanedDeployStages({
    installPath: installDir,
    readStatusOverride: () => status(statusValue),
  })
}

test("completed deployment cleans multiple stale stages and protects install, backups, failed", () => {
  const { parent, installDir } = sandbox()
  const backups = [0, 1].map((index) => {
    const backup = path.join(parent, `${installName}.backup-${stageTS}-backup${index}`)
    fs.mkdirSync(backup, { recursive: true })
    return backup
  })
  const failed = path.join(parent, `${installName}.failed-${stageTS}-deadbeef`)
  fs.mkdirSync(failed, { recursive: true })
  const stale = ["aaaa1111", "bbbb2222", "cccc3333"].map((id) => makeStage(parent, stageName(id)))

  const result = cleanup(parent, installDir, "completed")

  expect(result.removed.sort()).toEqual(stale.slice().sort())
  expect(result.inFlightStatus).toBeUndefined()
  expect(fs.existsSync(installDir)).toBe(true)
  backups.forEach((backup) => expect(fs.existsSync(backup)).toBe(true))
  expect(fs.existsSync(failed)).toBe(true)
  stale.forEach((directory) => expect(fs.existsSync(directory)).toBe(false))
})

test("only exact stage naming is ever removed", () => {
  const { parent, installDir } = sandbox()
  const kept = [
    makeStage(parent, `${installName}.deploy-`),
    makeStage(parent, `${installName}.deploy-not-a-build-id`),
    makeStage(parent, `${installName}.deploy-${stageTS}-GGH`),
    makeStage(parent, `${installName}.deploy-${stageTS}-abcdef123`),
    makeStage(parent, `${installName}.deploy-${stageTS}-abcdef12-extra`),
    makeStage(parent, `${installName}.deploy-20240101T000000-deadbeef`),
    makeStage(parent, `${installName}.deployx-${stageTS}-deadbeef`),
    makeStage(parent, `other.deploy-${stageTS}-deadbeef`),
  ]
  const file = path.join(parent, `${installName}.deploy-${stageTS}-fileffff`)
  fs.writeFileSync(file, "a file, not a directory")

  const result = cleanup(parent, installDir, "completed")

  expect(result.removed).toEqual([])
  kept.forEach((directory) => expect(fs.existsSync(directory)).toBe(true))
  expect(fs.existsSync(file)).toBe(true)
})

test("junction and symlink stages are never followed or removed", () => {
  const { parent, installDir } = sandbox()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-deploy-outside-"))
  roots.push(outside)
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "keep")
  const junction = makeStage(parent, stageName("deadbeef"), outside)

  const result = cleanup(parent, installDir, "completed")

  expect(result.removed).toEqual([])
  expect(fs.existsSync(junction)).toBe(true)
  expect(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8")).toBe("keep")
})

test("dry-run reports candidates without removing anything", () => {
  const { parent, installDir } = sandbox()
  const stale = makeStage(parent, stageName("deadbeef"))

  const result = cleanOrphanedDeployStages({
    installPath: installDir,
    dryRun: true,
    readStatusOverride: () => status("completed"),
  })

  expect(result.dryRun).toBe(true)
  expect(result.removed).toEqual([stale])
  expect(fs.existsSync(stale)).toBe(true)
})

test("cleanup skips every status that may outlive its deploy lock", () => {
  const { parent, installDir } = sandbox()
  makeStage(parent, stageName("deadbeef"))

  for (const statusValue of [
    "ready",
    "launching-worker",
    "worker-started",
    "closing-app",
    "deploying",
    "restarting",
  ]) {
    const result = cleanup(parent, installDir, statusValue)
    expect(result.inFlightStatus).toBe(statusValue)
    expect(result.removed).toEqual([])
    expect(fs.readdirSync(parent).filter((name) => name.includes(".deploy-")).length).toBeGreaterThan(0)
  }
})

test("crashed prepare phases are stale under an acquired lock and get cleaned", () => {
  const { parent, installDir } = sandbox()
  const hexByStatus = new Map([
    ["fingerprinting-source", "aaaa1111"],
    ["building", "bbbb2222"],
    ["packaging", "cccc3333"],
    ["staging", "dddd4444"],
  ])

  for (const [statusValue, hex] of hexByStatus) {
    const stale = makeStage(parent, stageName(hex))
    const result = cleanup(parent, installDir, statusValue)
    expect(result.inFlightStatus).toBeUndefined()
    expect(result.removed).toEqual([stale])
    expect(fs.existsSync(stale)).toBe(false)
  }
})

test("missing status is a first run and malformed status preserves stages", () => {
  const { parent, installDir } = sandbox()
  const staleA = makeStage(parent, stageName("aaaa1111"))
  const result = cleanOrphanedDeployStages({ installPath: installDir, readStatusOverride: () => undefined })

  expect(result.inFlightStatus).toBeUndefined()
  expect(result.removed).toEqual([staleA])
  expect(fs.existsSync(staleA)).toBe(false)

  const staleB = makeStage(parent, stageName("bbbb2222"))
  expect(() =>
    cleanOrphanedDeployStages({
      installPath: installDir,
      readStatusOverride: () => {
        throw new Error("malformed status")
      },
    }),
  ).toThrow("malformed status")
  expect(fs.existsSync(staleB)).toBe(true)
})

// Each of the seven CLI runs queries the recorded process start time once, so
// the run needs more than the default five-second budget.
test("syntactically valid but wrongly shaped status files fail closed", () => {
  const { parent, installDir, stateDir } = cliSandbox()
  const stale = makeStage(parent, stageName("deadbeef"))

  for (const shape of [
    "null",
    "{}",
    "[]",
    '{"status":7}',
    '{"status":""}',
    '{"status":"completed","buildID":42}',
    '{"status":"completed","stagePath":true}',
    '{"status":"mystery","updatedAt":"2026-10-16T00:00:00.000Z"}',
    '{"status":"completed ","updatedAt":"2026-10-16T00:00:00.000Z"}',
  ]) {
    writeStatusFile(stateDir, shape)
    const result = runCli(["clean-stages"], parent, stateDir)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("fail-closed")
    expect(fs.existsSync(stale)).toBe(true)
  }
}, 20_000)

test("clean-stages fails closed on unknown status names without changing status or stages", () => {
  const { parent, stateDir } = cliSandbox()
  const stale = makeStage(parent, stageName("deadbeef"))
  const stageContents = fs.readFileSync(path.join(stale, "OpenCode.exe"), "utf8")
  const unknownStatus = '{"status":"future-state ","updatedAt":"2026-10-16T00:00:00.000Z"}\n'
  writeStatusFile(stateDir, unknownStatus)

  const result = runCli(["clean-stages"], parent, stateDir)

  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("unknown status")
  expect(fs.readFileSync(path.join(stateDir, "status.json"), "utf8")).toBe(unknownStatus)
  expect(fs.readFileSync(path.join(stale, "OpenCode.exe"), "utf8")).toBe(stageContents)
  expect(fs.existsSync(path.join(stateDir, "deploy.lock"))).toBe(false)
})

test("a ready prepared deployment blocks prepare and keeps its stage", () => {
  const { parent, installDir } = sandbox()
  const stage = makeStage(parent, stageName("deadbeef"))
  const ready = status("ready", `${stageTS}-deadbeef`)

  expect(() => assertPrepareCanStart(ready)).toThrow(PreparedDeploymentExistsError)
  expect(() => assertPrepareCanStart(undefined)).not.toThrow()

  const result = cleanOrphanedDeployStages({
    installPath: installDir,
    readStatusOverride: () => ready,
  })
  expect(result.inFlightStatus).toBe("ready")
  expect(fs.existsSync(stage)).toBe(true)
})

const scriptPath = path.resolve(import.meta.dir, "..", "script", "desktop-prod-deploy.ts")

function runCli(args: string[], parent: string, stateDir: string) {
  return Bun.spawnSync([process.execPath, "run", scriptPath, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      OPENCODE_DESKTOP_INSTALL_DIR: path.join(parent, installName),
      OPENCODE_DESKTOP_DEPLOY_STATE_DIR: stateDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
}

function cliSandbox() {
  const { parent, installDir } = sandbox()
  const stateDir = path.join(parent, "deploy-state")
  fs.mkdirSync(stateDir, { recursive: true })
  return { parent, installDir, stateDir }
}

function writeStatusFile(stateDir: string, value: object | string) {
  fs.writeFileSync(
    path.join(stateDir, "status.json"),
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  )
}

test("clean-stages CLI removes orphaned stages and releases its lock", () => {
  const { parent, installDir, stateDir } = cliSandbox()
  const staleA = makeStage(parent, stageName("aaaa1111"))
  const staleB = makeStage(parent, stageName("bbbb2222"))
  writeStatusFile(stateDir, status("completed"))

  const result = runCli(["clean-stages"], parent, stateDir)

  expect(result.exitCode).toBe(0)
  const stdout = result.stdout.toString()
  expect(stdout).toContain(`REMOVED : ${staleA}`)
  expect(stdout).toContain(`REMOVED : ${staleB}`)
  expect(fs.existsSync(staleA)).toBe(false)
  expect(fs.existsSync(staleB)).toBe(false)
  expect(fs.existsSync(path.join(stateDir, "deploy.lock"))).toBe(false)
})

test("clean-stages --dry-run keeps everything", () => {
  const { parent, installDir, stateDir } = cliSandbox()
  const stale = makeStage(parent, stageName("deadbeef"))
  writeStatusFile(stateDir, status("completed"))

  const result = runCli(["clean-stages", "--dry-run"], parent, stateDir)

  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain(`WOULD REMOVE : ${stale}`)
  expect(fs.existsSync(stale)).toBe(true)
})

test("clean-stages without status.json behaves like a first run, not a failure", () => {
  const { parent, installDir, stateDir } = cliSandbox()
  const stale = makeStage(parent, stageName("deadbeef"))

  const result = runCli(["clean-stages"], parent, stateDir)

  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain(`REMOVED : ${stale}`)
  expect(fs.existsSync(stale)).toBe(false)
})

test("clean-stages fails closed on unreadable status and releases its lock", () => {
  const { parent, installDir, stateDir } = cliSandbox()
  const stale = makeStage(parent, stageName("deadbeef"))
  writeStatusFile(stateDir, "{ definitely not json")

  const result = runCli(["clean-stages"], parent, stateDir)

  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("fail-closed")
  expect(fs.existsSync(stale)).toBe(true)
  expect(fs.existsSync(path.join(stateDir, "deploy.lock"))).toBe(false)
})

test("clean-stages refuses to race a live deploy lock holder", () => {
  const { parent, installDir, stateDir } = cliSandbox()
  const stale = makeStage(parent, stageName("deadbeef"))
  fs.writeFileSync(path.join(stateDir, "deploy.lock"), String(process.pid), { encoding: "utf8", flag: "wx" })

  try {
    const result = runCli(["clean-stages"], parent, stateDir)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("another desktop deploy owns")
    expect(fs.existsSync(stale)).toBe(true)
  } finally {
    fs.rmSync(path.join(stateDir, "deploy.lock"), { force: true })
  }
})

test.each(["launch", "discard"] as const)("%s refuses to mutate a ready build while deploy.lock is held", (command) => {
  const { parent, stateDir } = cliSandbox()
  const stage = makeStage(parent, stageName("deadbeef"))
  const ready = { ...status("ready", `${stageTS}-deadbeef`), stagePath: stage }
  writeStatusFile(stateDir, ready)
  const lockPath = path.join(stateDir, "deploy.lock")
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: "" }), { encoding: "utf8", flag: "wx" })

  const result = runCli(command === "launch" ? ["launch", "--approved-close"] : ["discard"], parent, stateDir)

  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("another desktop deploy owns")
  expect(JSON.parse(fs.readFileSync(path.join(stateDir, "status.json"), "utf8"))).toEqual(ready)
  expect(fs.existsSync(stage)).toBe(true)
  expect(fs.existsSync(lockPath)).toBe(true)
})

test.each(["launch", "discard"] as const)("%s releases deploy.lock when durable status is missing", (command) => {
  const { parent, stateDir } = cliSandbox()

  const result = runCli(command === "launch" ? ["launch", "--approved-close"] : ["discard"], parent, stateDir)

  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("deploy status does not exist")
  expect(fs.existsSync(path.join(stateDir, "deploy.lock"))).toBe(false)
})

test.each(["ready", "automatic-building"]) ("clean-stages skips %s without failing", (statusValue) => {
  const { parent, stateDir } = cliSandbox()
  const stale = makeStage(parent, stageName("deadbeef"))
  writeStatusFile(stateDir, { ...status(statusValue), runID: statusValue === "ready" ? undefined : "auto-cleanup" })

  const result = runCli(["clean-stages"], parent, stateDir)

  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toContain(`deployment status is ${statusValue}`)
  expect(fs.existsSync(stale)).toBe(true)
  expect(fs.existsSync(path.join(stateDir, "deploy.lock"))).toBe(false)
})

test("prepare aborts on a ready build without overwriting its status or stage", () => {
  const { parent, installDir, stateDir } = cliSandbox()
  const stage = makeStage(parent, stageName("deadbeef"))
  const ready = { ...status("ready", `${stageTS}-deadbeef`), stagePath: stage }
  writeStatusFile(stateDir, ready)

  const result = runCli(["prepare"], parent, stateDir)

  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("still ready")
  const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "status.json"), "utf8"))
  expect(persisted).toEqual(ready)
  expect(fs.existsSync(stage)).toBe(true)
  expect(fs.existsSync(path.join(stateDir, "deploy.lock"))).toBe(false)
})

test("prepare with unreadable status fails closed, touches nothing, and releases its lock", () => {
  const { parent, installDir, stateDir } = cliSandbox()
  const stale = makeStage(parent, stageName("deadbeef"))
  writeStatusFile(stateDir, "{ broken")

  const result = runCli(["prepare"], parent, stateDir)

  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("fail-closed")
  expect(fs.existsSync(stale)).toBe(true)
  expect(fs.existsSync(path.join(stateDir, "deploy.lock"))).toBe(false)
})
