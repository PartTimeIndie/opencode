#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { prepareReleaseFiles, parseReleaseFiles, parseReleaseFilesReceipt, verifyReleaseFiles, installReleaseFiles, rollbackReleaseFiles } from "./desktop-release-files"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const opencodeDir = path.join(repoRoot, "packages", "opencode")
const desktopDir = path.join(repoRoot, "packages", "desktop")
const installDir =
  process.env.OPENCODE_DESKTOP_INSTALL_DIR ?? "C:\\Users\\crisc\\AppData\\Local\\Programs\\@opencode-aidesktop"
const stateRoot =
  process.env.OPENCODE_DESKTOP_DEPLOY_STATE_DIR ??
  path.join(
    process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? repoRoot, "AppData", "Local"),
    "OpenCodeDeploy",
  )
const statusPath = path.join(stateRoot, "status.json")
const manifestName = ".opencode-build-manifest.json"
const backupRetention = 2
const deadlineExpired = Symbol("deadline-expired")

export type BuildManifest = {
  version: 1
  buildID: string
  channel: "prod"
  sourceFingerprint: string
  createdAt: string
  artifactSha256: string
  files: Array<{ path: string; size: number; sha256: string }>
}

type DeployStatus = {
  status: string
  buildID?: string
  updatedAt: string
  sourceFingerprint?: string
  artifactSha256?: string
  stagePath?: string
  prodMarker?: string
  backupPath?: string
  logPath?: string
  error?: string
  restart?: boolean
  forceCloseApproved?: boolean
  launchToken?: string
  runID?: string
  phase?: string
  recovery?: string
  externalManifestPath?: string
  externalManifestSha256?: string
  // Annotation-only fields reported by the status command; writeStatus never persists them.
  stalled?: boolean
  ageSeconds?: number
  lockPID?: number
}

export class InstallationReplacementError extends Error {
  readonly backupPath: string

  constructor(message: string, backupPath: string, cause: unknown) {
    super(message, { cause })
    this.name = "InstallationReplacementError"
    this.backupPath = backupPath
  }
}

export type RunDescriptor = {
  version: 1
  runID: string
  repoRoot: string
  installDir: string
  createdAt: string
  pid: number
  startedAt: string
  approvedClose: boolean
  forceCloseApproved: boolean
  restart: boolean
  agentRetry?: boolean
  pinnedBuildID?: string
  phase: string
  launchToken?: string
  consumed?: boolean
}

export const automaticCommandName = "automatic"
export const automaticWorkerCommandName = "automatic-worker"
const runDescriptorPrefix = "automatic-run-"
const runDescriptorSuffix = ".json"
const automaticRunIDPattern = /^[A-Za-z0-9-]{1,64}$/
const inFlightAutomaticStatuses = new Set([
  "automatic-reserved",
  "automatic-handoff",
  "automatic-worker-started",
  "automatic-closing-app",
  "automatic-building",
  "automatic-deploying",
  "automatic-restarting",
  "automatic-recovering",
])
const automaticPhases = new Set([
  ...inFlightAutomaticStatuses,
  "automatic-completed",
  "automatic-failed",
  "automatic-cancelled",
])

export function automaticDescriptorPath(runID: string, root = stateRoot) {
  assertAutomaticRunID(runID)
  return path.join(root, `${runDescriptorPrefix}${runID}${runDescriptorSuffix}`)
}

export function assertAutomaticRunID(runID: string) {
  if (!automaticRunIDPattern.test(runID)) throw new Error(`invalid automatic run ID: ${runID}`)
}

export function assertAutomaticRepoRoot(repoRoot: string) {
  if (!path.isAbsolute(repoRoot)) throw new Error(`automatic run root is not absolute: ${repoRoot}`)
}

export function parseRunDescriptor(value: unknown): RunDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("automatic run descriptor is not a plain object")
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new Error("automatic run descriptor has an unsupported version")
  if (typeof record.runID !== "string" || !record.runID) throw new Error("automatic run descriptor is missing its run ID")
  assertAutomaticRunID(record.runID)
  if (typeof record.repoRoot !== "string" || !record.repoRoot) throw new Error("automatic run descriptor is missing its repository root")
  assertAutomaticRepoRoot(record.repoRoot)
  if (typeof record.installDir !== "string" || !record.installDir) throw new Error("automatic run descriptor is missing its install directory")
  if (typeof record.createdAt !== "string" || !record.createdAt) throw new Error("automatic run descriptor is missing its creation time")
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid)) throw new Error("automatic run descriptor has no owning PID")
  if (typeof record.startedAt !== "string") throw new Error("automatic run descriptor has no owning process start time")
  if (typeof record.phase !== "string" || !automaticPhases.has(record.phase)) throw new Error("automatic run descriptor has an unknown phase")
  for (const key of ["approvedClose", "forceCloseApproved", "restart"] as const) {
    if (typeof record[key] !== "boolean") throw new Error(`automatic run descriptor is missing ${key}`)
  }
  if (record.agentRetry !== undefined && typeof record.agentRetry !== "boolean")
    throw new Error("automatic run descriptor has an invalid agent retry mode")
  if (record.pinnedBuildID !== undefined && typeof record.pinnedBuildID !== "string") throw new Error("automatic run descriptor has an invalid pinned build")
  if (record.launchToken !== undefined && typeof record.launchToken !== "string") throw new Error("automatic run descriptor has an invalid launch token")
  if (record.consumed !== undefined && typeof record.consumed !== "boolean") throw new Error("automatic run descriptor has an invalid handoff state")
  return record as RunDescriptor
}

export function readRunDescriptor(runID: string, root = stateRoot): RunDescriptor {
  const descriptorPath = automaticDescriptorPath(runID, root)
  if (!fs.existsSync(descriptorPath)) throw new Error(`automatic run descriptor does not exist: ${descriptorPath}`)
  try {
    return parseRunDescriptor(JSON.parse(fs.readFileSync(descriptorPath, "utf8")))
  } catch (error) {
    throw new Error(`automatic run descriptor is unreadable; refusing to close OpenCode fail-closed: ${descriptorPath}`, { cause: error })
  }
}

export function writeRunDescriptor(descriptor: RunDescriptor, root = stateRoot) {
  const descriptorPath = automaticDescriptorPath(descriptor.runID, root)
  const temporary = `${descriptorPath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8")
  fs.renameSync(temporary, descriptorPath)
}

export function claimAutomaticHandoff(runID: string, launchToken: string, root = stateRoot): RunDescriptor {
  const lockPath = path.join(root, `automatic-claim-${runID}.lock`)
  try {
    fs.writeFileSync(lockPath, String(process.pid), { encoding: "utf8", flag: "wx" })
  } catch {
    throw new Error(`automatic handoff for ${runID} was already consumed`)
  }
  try {
    const descriptor = readRunDescriptor(runID, root)
    if (descriptor.launchToken !== launchToken) throw new Error(`automatic worker authorization for ${runID} is no longer current`)
    if (descriptor.consumed === true) throw new Error(`automatic handoff for ${runID} was already consumed`)
    if (descriptor.phase !== "automatic-handoff") throw new Error(`automatic run ${runID} is not awaiting handoff (phase: ${descriptor.phase})`)
    const claimed = { ...descriptor, consumed: true, phase: "automatic-worker-started" }
    writeRunDescriptor(claimed, root)
    return claimed
  } catch (error) {
    fs.rmSync(lockPath, { force: true })
    throw error
  }
}

export function cancelAutomaticHandoff(runID: string, reason: string, root = stateRoot) {
  assertAutomaticRunID(runID)
  const lockPath = path.join(root, `automatic-claim-${runID}.lock`)
  try {
    fs.writeFileSync(lockPath, String(process.pid), { encoding: "utf8", flag: "wx" })
  } catch {
    return undefined
  }
  try {
    if (!fs.existsSync(automaticDescriptorPath(runID, root))) return undefined
    const descriptor = readRunDescriptor(runID, root)
    if (descriptor.consumed === true || descriptor.phase !== "automatic-handoff") return descriptor
    const cancelled = { ...descriptor, consumed: true, phase: "automatic-cancelled" as const }
    writeRunDescriptor(cancelled, root)
    // The descriptor and status must come from the same state root. A timed-out
    // controller must not replace a status written by a newer run.
    const currentStatus = readDeployStatusStrict(root)
    if (!currentStatus || terminalDeployStatuses.has(currentStatus.status) || currentStatus.runID === runID) {
      writeStatus({ status: "automatic-failed", runID, phase: "automatic-cancelled", error: reason }, root)
    }
    return cancelled
  } finally {
    fs.rmSync(lockPath, { force: true })
  }
}

const terminalDeployStatuses = new Set([
  "completed",
  "failed",
  "deployed",
  "discarded",
  "automatic-completed",
  "automatic-failed",
  "automatic-cancelled",
])

export function isAutomaticRunInFlight(status: Pick<DeployStatus, "status" | "runID"> | undefined): boolean {
  if (!status) return false
  // An automatic run owns every non-terminal status carrying its runID,
  // including the manual prepare phase names that prepare() writes while the
  // automatic worker holds ownership. Terminal statuses never block.
  if (status.runID && !terminalDeployStatuses.has(status.status)) return true
  // A manual ready state may be launched or discarded. Automatic-owned READY
  // states are still blocked by the runID check above; cleanup has a separate guard.
  if (status.status === "ready") return false
  return liveDeployStatuses.has(status.status)
}

export function assertNoConflictingAutomaticRun(status: Pick<DeployStatus, "status" | "runID" | "buildID"> | undefined, runID?: string) {
  if (!status || !isAutomaticRunInFlight(status)) return
  if (runID && status.runID === runID) return
  const owner = status.runID ? `automatic run ${status.runID}` : `deployment status ${status.status}`
  throw new Error(`${owner} is still in flight; refusing to start a second automatic run`)
}

export type AutomaticHandoffRequest = {
  runID: string
  launchToken: string
  approvedClose: boolean
  forceCloseApproved: boolean
  restart: boolean
  pinnedBuildID?: string
}

export function parseAutomaticHandoffRequest(value: unknown): AutomaticHandoffRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("automatic handoff request is not a plain object")
  const record = value as Record<string, unknown>
  if (typeof record.runID !== "string" || !record.runID) throw new Error("automatic handoff request is missing its run ID")
  assertAutomaticRunID(record.runID)
  if (typeof record.launchToken !== "string" || !record.launchToken) throw new Error("automatic handoff request is missing its launch token")
  for (const key of ["approvedClose", "forceCloseApproved", "restart"] as const) {
    if (typeof record[key] !== "boolean") throw new Error(`automatic handoff request is missing ${key}`)
  }
  if (record.pinnedBuildID !== undefined && typeof record.pinnedBuildID !== "string") throw new Error("automatic handoff request has an invalid pinned build")
  return record as AutomaticHandoffRequest
}

export type RecoveryChoice = "opencode" | "codex" | "previous-app" | "restore-backup" | "abort"

export function parseRecoveryChoice(value: string | undefined): RecoveryChoice {
  value = value?.trim()
  if (value === "1" || value === "opencode") return "opencode"
  if (value === "2" || value === "codex") return "codex"
  if (value === "3" || value === "previous-app") return "previous-app"
  if (value === "4" || value === "restore-backup") return "restore-backup"
  if (value === "0" || value === "abort" || value === "" || value === undefined) return "abort"
  throw new Error(`unknown recovery choice: ${value}`)
}

export type RecoverySpawn = {
  command: string
  args: string[]
  cwd: string
}

export function opencodeRecoverySpawn(input: { cli: string; repoRoot: string; contextPath: string; prompt: string; interactive?: boolean }): RecoverySpawn {
  assertAutomaticRepoRoot(input.repoRoot)
  if (!input.cli) throw new Error("OpenCode recovery CLI is unavailable")
  if (!input.contextPath) throw new Error("OpenCode recovery context is missing")
  if (!input.prompt) throw new Error("OpenCode recovery prompt is missing")
  return {
    command: input.cli,
    args: ["run", "--pure", ...(input.interactive === false ? [] : ["--interactive"]), "--dir", input.repoRoot, input.prompt],
    cwd: input.repoRoot,
  }
}

export function codexRecoverySpawn(input: { cli: string; repoRoot: string; prompt: string }): RecoverySpawn {
  assertAutomaticRepoRoot(input.repoRoot)
  if (!input.cli) throw new Error("Codex recovery CLI is unavailable")
  if (!input.prompt) throw new Error("Codex recovery prompt is missing")
  return { command: input.cli, args: [input.prompt], cwd: input.repoRoot }
}

export function backupPrefixForInstall(installPath = installDir) {
  return `${path.basename(installPath)}.backup-`
}

export function isManifestBackupDirectory(candidate: string, installPath = installDir) {
  const parentReal = (() => {
    try {
      return realPathWithin(path.dirname(installPath))
    } catch {
      return undefined
    }
  })()
  if (!parentReal) return false
  if (path.dirname(candidate) !== path.dirname(installPath)) return false
  if (!path.basename(candidate).startsWith(backupPrefixForInstall(installPath))) return false
  if (!isRealLocalDirectory(candidate, parentReal)) return false
  try {
    verifyManifest(candidate)
    return true
  } catch {
    return false
  }
}

export function listManifestBackups(installPath = installDir): Array<{ directory: string; buildID: string; artifactSha256: string }> {
  const parent = path.dirname(installPath)
  if (!path.isAbsolute(parent)) throw new Error(`deploy stage parent is not absolute: ${parent}`)
  const parentReal = realPathWithin(parent)
  if (!fs.statSync(parent).isDirectory()) throw new Error(`deploy stage parent is not a directory: ${parent}`)
  const backups: Array<{ directory: string; buildID: string; artifactSha256: string }> = []
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (!entry.name.startsWith(backupPrefixForInstall(installPath))) continue
    const candidate = path.join(parent, entry.name)
    if (!isSameOrInside(candidate, parentReal) || !isRealLocalDirectory(candidate, parentReal)) continue
    try {
      const manifest = verifyManifest(candidate)
      backups.push({ directory: candidate, buildID: manifest.buildID, artifactSha256: manifest.artifactSha256 })
    } catch {
      continue
    }
  }
  return backups.sort((left, right) => left.directory.localeCompare(right.directory))
}

async function main() {
  fs.mkdirSync(stateRoot, { recursive: true })
  const command = process.argv[2]
  if (command === "prepare") return prepare()
  if (command === "launch") return launch()
  if (command === "worker") return worker()
  if (command === automaticCommandName) return automatic()
  if (command === automaticWorkerCommandName) return automaticWorker()
  if (command === "status") return printStatus()
  if (command === "recover") return recoverFailedRun()
  if (command === "discard") return discard()
  if (command === "clean-stages") return cleanStagesCommand()
  fail(
    `usage: bun run desktop:deploy <prepare|launch|worker|${automaticCommandName}|${automaticWorkerCommandName}|status|recover|discard|clean-stages>`,
  )
}

function cleanStagesCommand() {
  const releaseLock = acquireLock()
  let result: StageCleanupResult
  try {
    result = cleanOrphanedDeployStages({ dryRun: process.argv.includes("--dry-run") })
  } finally {
    releaseLock()
  }
  result.removed.forEach((directory) => console.log(`${result.dryRun ? "WOULD REMOVE" : "REMOVED"} : ${directory}`))
  if (result.inFlightStatus)
    console.warn(`skipped cleanup: deployment status is ${result.inFlightStatus}; no stages were removed`)
  console.log(`SCANNED : ${path.dirname(installDir)} for ${stagePrefix()}*`)
}

async function prepare(automaticContext?: { runID: string; internal: boolean }) {
  if (process.platform !== "win32") fail("the installed Desktop deploy pipeline currently supports Windows only")
  const releaseLock = acquireLock()
  try {
    // A ready build must never be silently overwrite-orphaned by a new prepare.
    // Strict-but-missing-is-undefined keeps the lock releasable on first runs;
    // readStatus() would process.exit() past every finally.
    const strict = readDeployStatusStrict()
    assertPrepareCanStart(strict)
    assertNoConflictingAutomaticRun(strict, automaticContext?.internal ? automaticContext.runID : undefined)
    if (automaticContext && !automaticContext.internal) {
      throw new Error(`automatic run ${automaticContext.runID} does not own this prepare`)
    }
    const stageCleanup = cleanOrphanedDeployStages()
    stageCleanup.removed.forEach((directory) => console.log(`Cleaned orphaned deploy stage: ${directory}`))
    if (stageCleanup.inFlightStatus)
      console.warn(`skipped orphaned stage cleanup: deployment status is ${stageCleanup.inFlightStatus}`)
  } catch (error) {
    releaseLock()
    throw error
  }
  const buildID = `${timestamp()}-${randomUUID().slice(0, 8)}`
  const logPath = path.join(stateRoot, `build-${buildID}.log`)
  const stagePath = path.join(path.dirname(installDir), `${path.basename(installDir)}.deploy-${buildID}`)
  try {
    writeBuildLogHeader(logPath, buildID)
    const external = prepareExternalRelease(process.env.OPENCODE_DESKTOP_RELEASE_INPUT, path.join(stateRoot, `release-${buildID}`))
    const automaticStatus = automaticContext ? { runID: automaticContext.runID, phase: "automatic-building" } : {}
    writeStatus({ status: "fingerprinting-source", buildID, logPath, ...automaticStatus })
    const sourceFingerprint = sourceTreeFingerprint()
    writeStatus({ status: "building", buildID, sourceFingerprint, logPath, ...automaticStatus })
    assertFreeMemoryForBuild(os.freemem())
    assertNoCompetingWriters(listLocalProcesses(), repoRoot, process.pid)
    fs.rmSync(path.join(desktopDir, "out"), { recursive: true, force: true })
    fs.rmSync(path.join(desktopDir, "dist"), { recursive: true, force: true })
    await buildDesktopSources(repoRoot, logPath)
    assertUnchangedFingerprint(sourceFingerprint, sourceTreeFingerprint(), "while the web frontend was building")

    const marker = path.join(desktopDir, "out", ".build-channel")
    if (!fs.existsSync(marker) || fs.readFileSync(marker, "utf8").trim() !== "prod") {
      throw new Error(`fresh build did not produce the required prod marker: ${marker}`)
    }
    const prodMarker = marker

    const desktopCli = path.join(desktopDir, "resources", "opencode-cli.exe")
    fs.rmSync(desktopCli, { force: true })
    await runLogged([process.execPath, "script/build.ts", "--single", "--skip-install"], opencodeDir, logPath, 20 * 60_000)
    const builtCli = nativeWindowsCliOutput(opencodeDir, process.arch)
    if (!fs.existsSync(builtCli)) {
      throw new Error(`native Windows CLI build did not produce the required ${process.arch} executable: ${builtCli}`)
    }
    fs.copyFileSync(builtCli, desktopCli)

    writeStatus({ status: "packaging", buildID, sourceFingerprint, prodMarker, logPath, ...automaticStatus })
    await runLogged([process.execPath, "run", "package:win", "--dir"], desktopDir, logPath, 20 * 60_000)
    assertUnchangedFingerprint(sourceFingerprint, sourceTreeFingerprint(), "while the build was running")

    const packageRoot = path.join(desktopDir, "dist", "win-unpacked")
    for (const required of requiredDesktopPackageFiles()) {
      if (!fs.existsSync(path.join(packageRoot, required))) throw new Error(`packaged desktop is missing ${required}`)
    }

    if (fs.existsSync(stagePath)) throw new Error(`immutable stage already exists: ${stagePath}`)
    writeStatus({ status: "staging", buildID, sourceFingerprint, stagePath, logPath, ...automaticStatus })
    fs.cpSync(packageRoot, stagePath, { recursive: true, errorOnExist: true, force: false })
    const uninstaller = path.join(installDir, "Uninstall OpenCode.exe")
    if (fs.existsSync(uninstaller)) fs.copyFileSync(uninstaller, path.join(stagePath, path.basename(uninstaller)))
    if (external) fs.writeFileSync(path.join(stagePath, ".opencode-plugin-release.json"), JSON.stringify(external, null, 2))

    const manifest = createManifest(stagePath, buildID, sourceFingerprint)
    fs.writeFileSync(path.join(stagePath, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    verifyManifest(stagePath)
    writeStatus({
      status: "ready",
      buildID,
      sourceFingerprint,
      artifactSha256: manifest.artifactSha256,
      stagePath,
      prodMarker,
      logPath,
      ...automaticStatus,
      ...(external ? { externalManifestPath: external.externalManifestPath, externalManifestSha256: external.externalManifestSha256 } : {}),
    })
    console.log(`READY   : ${buildID}`)
    console.log(`SOURCE  : ${sourceFingerprint}`)
    console.log(`ARTIFACT: ${manifest.artifactSha256}`)
    console.log(`STAGE   : ${stagePath}`)
    console.log(`PROD    : ${prodMarker}`)
    console.log(`LOG     : ${logPath}`)
    console.log(`STATUS  : ${statusPath}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = readStatus()
    if (status.buildID === buildID && status.status === "staging") {
      fs.rmSync(stagePath, { recursive: true, force: true })
    }
    writeStatus({
      status: automaticContext ? "automatic-failed" : "failed",
      buildID,
      logPath,
      error: message,
      ...(automaticContext ? { runID: automaticContext.runID, phase: "automatic-failed" } : {}),
    })
    console.error(`FAILED: ${message}`)
    process.exitCode = 1
  } finally {
    releaseLock()
  }
}

export async function buildDesktopSources(root: string, logPath: string, run = runLogged) {
  // App plugins are plain JS/assets: their build step copies the durable sources
  // into the runtime tree. Keep this shared by the Settings button and CLI.
  await run([process.execPath, "run", "sync:plugins"], root, logPath, 2 * 60_000)
  await run([process.execPath, "run", "build"], path.join(root, "packages", "desktop"), logPath, 20 * 60_000)
}

async function launch() {
  if (!process.argv.includes("--approved-close")) {
    fail("launch requires --approved-close after explicit current-chat approval to close OpenCode")
  }
  const releaseLock = acquireLock()
  try {
    if (!fs.existsSync(statusPath)) throw new Error(`deploy status does not exist: ${statusPath}`)
    const current = readStatus()
    assertNoConflictingAutomaticRun(current)
    if (current.status !== "ready" || !current.buildID || !current.stagePath) {
      throw new Error(`no prepared deployment is ready (current status: ${current.status})`)
    }
    const requestedBuildID = argument("--build-id")
    if (requestedBuildID && requestedBuildID !== current.buildID) {
      throw new Error(`prepared build is ${current.buildID}, not requested build ${requestedBuildID}`)
    }
    verifyPrepared(current)
    const restart = process.argv.includes("--restart")
    const forceCloseApproved = process.argv.includes("--force-close-approved")
    const launchToken = randomUUID()
    const cancellationPath = launchCancellationPath(current.buildID, launchToken)
    fs.rmSync(cancellationPath, { force: true })
    const launcher = path.join(stateRoot, `launch-${current.buildID}.ps1`)
    const args = [scriptPath(), "worker", "--build-id", current.buildID, "--launch-token", launchToken]
    if (restart) args.push("--restart")
    if (forceCloseApproved) args.push("--force-close-approved")
    fs.writeFileSync(
      launcher,
      [
        "$ErrorActionPreference = 'Stop'",
        `Start-Process -FilePath '${ps(process.execPath)}' -ArgumentList @(${args.map((value) => `'${ps(value)}'`).join(", ")}) -WorkingDirectory '${ps(path.dirname(scriptPath()))}' -WindowStyle Hidden`,
      ].join("\r\n"),
      "utf8",
    )
    writeStatus({ ...current, status: "launching-worker", restart, forceCloseApproved, launchToken })
    const result = Bun.spawnSync(
      ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    )
    if (result.exitCode !== 0) {
      fs.writeFileSync(cancellationPath, "cancelled\n", "utf8")
      writeStatus({ ...current, status: "ready" })
      throw new Error(`could not start detached deploy worker: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`)
    }
    const started = await waitFor(() => {
      const status = readStatus()
      return status.status === "worker-started" && status.launchToken === launchToken
    }, 10_000)
    if (!started) {
      fs.writeFileSync(cancellationPath, "cancelled\n", "utf8")
      writeStatus({ ...current, status: "ready" })
      throw new Error("detached deploy worker did not acknowledge startup within 10 seconds")
    }
    console.log(`STARTED : detached deploy worker for ${current.buildID}`)
    console.log(`STATUS  : ${statusPath}`)
  } catch (error) {
    console.error(`FAILED: ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  } finally {
    releaseLock()
  }
}

async function worker() {
  const buildID = requiredArgument("--build-id")
  const launchToken = requiredArgument("--launch-token")
  const current = readStatus()
  if (
    current.status !== "launching-worker" ||
    current.buildID !== buildID ||
    !current.stagePath ||
    current.launchToken !== launchToken
  ) {
    fail(`deploy worker authorization for ${buildID} is no longer current`)
  }
  const restart = process.argv.includes("--restart")
  const forceCloseApproved = process.argv.includes("--force-close-approved")
  let backupPath: string | undefined
  writeStatus({ ...current, status: "worker-started", restart, forceCloseApproved, launchToken })
  await Bun.sleep(5_000)
  if (fs.existsSync(launchCancellationPath(buildID, launchToken))) {
    writeStatus({ ...current, status: "ready", launchToken: undefined })
    return
  }
  const authorized = readStatus()
  if (authorized.status !== "worker-started" || authorized.launchToken !== launchToken) return
  try {
    verifyPrepared(current)
    writeStatus({ ...current, status: "closing-app", restart, forceCloseApproved })
    await closeOpenCode(forceCloseApproved)
    writeStatus({ ...current, status: "deploying", restart, forceCloseApproved })
    backupPath = replaceInstallation(current.stagePath, installDir, buildID)
    if (current.externalManifestPath) installReleaseFiles(readExternalRelease(current))
    const manifest = verifyManifest(installDir)
    writeStatus({
      ...current,
      status: restart ? "restarting" : "deployed",
      artifactSha256: manifest.artifactSha256,
      backupPath,
      restart,
      forceCloseApproved,
    })
    if (restart) {
      startOpenCode()
      if (!(await waitForStableOpenCode()))
        throw new Error("new OpenCode process or desktop runtime did not become healthy")
    }
    pruneBackups()
    writeStatus({
      ...current,
      status: "completed",
      artifactSha256: manifest.artifactSha256,
      backupPath,
      restart,
      forceCloseApproved,
    })
  } catch (error) {
    if (error instanceof InstallationReplacementError) backupPath = error.backupPath
    const message = error instanceof Error ? error.message : String(error)
    let rollbackError: string | undefined
    if (backupPath) {
      try {
        await closeOpenCode(forceCloseApproved)
        if (current.externalManifestPath) {
          const receiptPath = path.join(path.dirname(current.externalManifestPath), "receipt.json")
          if (fs.existsSync(receiptPath)) rollbackReleaseFiles(readExternalReleaseReceipt(current))
        }
        rollbackInstallation(installDir, backupPath, buildID)
        if (restart) startOpenCode()
      } catch (error) {
        rollbackError = error instanceof Error ? error.message : String(error)
      }
    }
    writeStatus({
      ...current,
      status: "failed",
      backupPath,
      restart,
      forceCloseApproved,
      error: rollbackError
        ? `${message}; rollback failed: ${rollbackError}`
        : backupPath
          ? `${message}; deployment rolled back`
          : message,
    })
    process.exitCode = 1
  }
}

async function automatic() {
  if (process.platform !== "win32") fail("the installed Desktop deploy pipeline currently supports Windows only")
  if (process.argv.includes("--prompt-stale-cancel") && (await promptStaleAutomaticCancellation())) return
  const approvedClose = process.argv.includes("--approved-close")
  const forceCloseApproved = process.argv.includes("--force-close-approved")
  const restart = !process.argv.includes("--no-restart")
  const agentRetry = process.argv.includes("--agent-retry")
  if ((!approvedClose || !forceCloseApproved) && !process.stdin.isTTY) {
    fail("automatic requires --approved-close and --force-close-approved when no interactive console is available")
  }
  const approvals = await resolveAutomaticApprovals({ approvedClose, forceCloseApproved, restart })
  const releaseLock = acquireLock()
  try {
    assertNoConflictingAutomaticRun(readDeployStatusStrict())
    assertPrepareCanStart(readDeployStatusStrict())
  } catch (error) {
    releaseLock()
    throw error
  }
  const runID = `auto-${timestamp()}-${randomUUID().slice(0, 8)}`
  const launchToken = randomUUID()
  const startedAt = currentProcessStartedAt(process.pid) ?? ""
  const descriptor: RunDescriptor = {
    version: 1,
    runID,
    repoRoot,
    installDir,
    createdAt: new Date().toISOString(),
    pid: process.pid,
    startedAt,
    approvedClose: approvals.approvedClose,
    forceCloseApproved: approvals.forceCloseApproved,
    restart: approvals.restart,
    agentRetry,
    phase: "automatic-handoff",
    launchToken,
  }
  try {
    writeRunDescriptor(descriptor)
    writeStatus({
      status: "automatic-handoff",
      runID,
      phase: descriptor.phase,
      restart: approvals.restart,
      forceCloseApproved: approvals.forceCloseApproved,
    })
  } catch (error) {
    releaseLock()
    throw error
  }
  // The controller releases deploy.lock before the detached worker continues:
  // the single-flight RunDescriptor plus durable status (not deploy.lock)
  // is the authority across handoff, shutdown, build, deploy, and recovery.
  releaseLock()
  const workerArgs = [scriptPath(), automaticWorkerCommandName, "--run-id", runID, "--launch-token", launchToken]
  const launcher = path.join(stateRoot, `automatic-${runID}.ps1`)
  const consolePath = path.join(stateRoot, `automatic-${runID}.cmd`)
  fs.writeFileSync(consolePath, automaticConsoleCommand([process.execPath, ...workerArgs], repoRoot), "utf8")
  fs.writeFileSync(
    launcher,
    [
      "$ErrorActionPreference = 'Stop'",
      `Start-Process -FilePath $env:ComSpec -ArgumentList '${ps(`/d /${agentRetry ? "c" : "k"} ""${consolePath}""`)}' -WorkingDirectory '${ps(repoRoot)}' -WindowStyle ${agentRetry ? "Hidden" : "Normal"}`,
    ].join("\r\n"),
    "utf8",
  )
  const result = Bun.spawnSync(
    ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (result.exitCode !== 0) {
    cancelAutomaticHandoff(
      runID,
      `could not start detached automatic worker: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`,
    )
    fail(`could not start detached automatic worker: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`)
  }
  const started = await waitFor(() => {
    try {
      const claimed = readRunDescriptor(runID)
      return claimed.consumed === true && claimed.phase === "automatic-worker-started"
    } catch {
      return false
    }
  }, 10_000)
  if (!started) {
    cancelAutomaticHandoff(runID, "detached automatic worker did not acknowledge startup within 10 seconds")
    fail("detached automatic worker did not acknowledge startup within 10 seconds")
  }
  console.log(`AUTOMATIC : detached worker for ${runID}`)
  console.log(`STATUS  : ${statusPath}`)
}

async function promptStaleAutomaticCancellation() {
  const previous = readDeployStatusStrict()
  if (!previous || !isAutomaticRunInFlight(previous)) return false
  if (!previous.runID) throw new Error(`deployment status ${previous.status} has no automatic run to cancel`)
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(`automatic run ${previous.runID} is still in flight; cancellation needs a visible interactive console`)
  console.log(`Deployment ${previous.runID} is still in flight (status: ${previous.status}).`)
  const answer = await promptLine("Willst du den verwaisten Lauf abbrechen? Ja/Nein [Nein] ")
  if (!/^(ja|j|yes|y)$/i.test(answer.trim())) {
    console.log("Abbruch abgelehnt; der vorhandene Lauf bleibt unverändert.")
    return true
  }
  const releaseLock = acquireLock()
  try {
    const current = readDeployStatusStrict()
    if (!current || current.runID !== previous.runID || current.updatedAt !== previous.updatedAt || !isAutomaticRunInFlight(current))
      throw new Error("deployment status changed while awaiting cancellation; inspect the current console")
    if (automaticWorkerRunning(current.runID))
      throw new Error(`automatic run ${current.runID} still has an active worker; use its visible console to abort safely`)
    if (current.status === "automatic-handoff") {
      const cancelled = cancelAutomaticHandoff(current.runID, "cancelled in the visible CMD console")
      if (cancelled?.phase !== "automatic-cancelled")
        throw new Error(`automatic handoff ${current.runID} was claimed while awaiting cancellation`)
    } else {
      writeStatus({ ...current, status: "automatic-cancelled", phase: "automatic-cancelled", error: "cancelled in the visible CMD console" })
    }
    console.log(`Verwaister Lauf ${current.runID} abgebrochen. Starte das CMD-Werkzeug erneut für einen neuen Deploy.`)
    return true
  } finally {
    releaseLock()
  }
}

function automaticWorkerRunning(runID: string) {
  const result = Bun.spawnSync(
    ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", "Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^(bun|node)(\\.exe)?$' -and $_.CommandLine -match 'desktop-prod-deploy' } | Select-Object -ExpandProperty CommandLine"],
    { stdout: "pipe", stderr: "pipe" },
  )
  if (result.exitCode !== 0) throw new Error("could not verify whether the automatic worker is still running")
  return result.stdout.toString().split(/\r?\n/).some((line) => line.includes("automatic-worker") && line.includes(runID))
}

export function automaticConsoleCommand(args: string[], directory: string) {
  const quote = (value: string) => {
    if (/["\r\n]/.test(value)) throw new Error("invalid automatic console argument")
    return `"${value.replace(/%/g, "%%")}"`
  }
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    "title OpenCode Build and Deploy",
    `cd /d ${quote(directory)}`,
    "if errorlevel 1 exit /b 1",
    args.map(quote).join(" "),
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n")
}

async function resolveAutomaticApprovals(input: { approvedClose: boolean; forceCloseApproved: boolean; restart: boolean }) {
  if (input.approvedClose && input.forceCloseApproved) return input
  if (!process.stdin.isTTY) fail("automatic requires --approved-close and --force-close-approved when no interactive console is available")
  console.log("Build and Deploy closes OpenCode immediately, then builds and deploys in this console.")
  console.log("Close approval includes force-close when graceful shutdown misses its deadline, and restart after a verified deploy.")
  const answer = await promptLine("Close OpenCode now and continue automatically? [y/N] ")
  if (!/^y(es)?$/i.test(answer.trim())) fail("automatic run cancelled before any shutdown")
  return { approvedClose: true, forceCloseApproved: true, restart: input.restart }
}

function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question)
    let answer = ""
    process.stdin.resume()
    process.stdin.setEncoding("utf8")
    const onData = (chunk: string) => {
      answer += chunk
      if (answer.includes("\n")) {
        process.stdin.off("data", onData)
        process.stdin.pause()
        resolve(answer.trim())
      }
    }
    process.stdin.on("data", onData)
  })
}

async function automaticWorker() {
  const runID = requiredArgument("--run-id")
  const launchToken = requiredArgument("--launch-token")
  assertAutomaticRunID(runID)
  const claimed = claimAutomaticHandoff(runID, launchToken)
  if (path.resolve(claimed.repoRoot) !== repoRoot) {
    writeStatus({ status: "automatic-failed", runID, phase: "automatic-failed", error: `automatic run root mismatch: ${claimed.repoRoot}` })
    fail(`automatic run root mismatch: ${claimed.repoRoot}`)
  }
  // Give the plugin host time to receive the claimed worker acknowledgement before shutdown.
  await Bun.sleep(5_000)
  const logPath = path.join(stateRoot, `automatic-${runID}.log`)
  writeBuildLogHeader(logPath, runID)
  let pausedDevServer: ProcessEntry | undefined
  try {
    const workerStatus = (status: string, extra: Record<string, unknown> = {}) =>
      writeStatus({ status, runID, phase: status, restart: claimed.restart, forceCloseApproved: claimed.forceCloseApproved, logPath, ...extra })
    workerStatus("automatic-closing-app")
    await closeOpenCodeInventoried(claimed.forceCloseApproved)
    pausedDevServer = await pauseOwnedViteDevServer(repoRoot)
    workerStatus("automatic-building")
    const prepared = await buildAutomaticPackage(runID)
    workerStatus("automatic-deploying", { buildID: prepared.buildID })
    const deployed = await deployAutomaticPackage(prepared, claimed.restart, claimed.forceCloseApproved, runID, workerStatus)
    pruneBackups()
    writeStatus({
      status: "completed",
      runID,
      phase: "automatic-completed",
      buildID: deployed.buildID,
      sourceFingerprint: deployed.sourceFingerprint,
      artifactSha256: deployed.artifactSha256,
      stagePath: deployed.stagePath,
      prodMarker: deployed.prodMarker,
      logPath: deployed.logPath,
      backupPath: deployed.backupPath,
      restart: claimed.restart,
      forceCloseApproved: claimed.forceCloseApproved,
    })
    console.log(`AUTOMATIC: ${runID} completed`)
    console.log(`READY   : ${deployed.buildID}`)
    console.log(`SOURCE  : ${deployed.sourceFingerprint}`)
    console.log(`ARTIFACT: ${deployed.artifactSha256}`)
    console.log(`STAGE   : ${deployed.stagePath}`)
    console.log(`PROD    : ${deployed.prodMarker}`)
    console.log(`LOG     : ${deployed.logPath}`)
    console.log(`STATUS  : ${statusPath}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const prepared = readStatusStrictOrUndefined()
    writeStatus({
      status: "automatic-failed",
      runID,
      phase: "automatic-failed",
      buildID: prepared?.buildID,
      logPath: prepared?.logPath ?? logPath,
      error: message,
    })
    console.error(`AUTOMATIC FAILED: ${message}`)
    if (claimed.agentRetry) {
      console.error(`Repair agent owns this failure. Log: ${prepared?.logPath ?? logPath}`)
      process.exitCode = 1
      return
    }
    try {
      await runAutomaticRecovery({
        runID,
        repoRoot,
        logPath: prepared?.logPath ?? logPath,
        message,
        forceCloseApproved: claimed.forceCloseApproved,
      })
    } catch (recoveryError) {
      const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
      if (readStatus().runID === runID)
        writeStatus({ status: "automatic-failed", runID, phase: "automatic-failed", logPath: prepared?.logPath ?? logPath, error: `${message}; recovery failed: ${recoveryMessage}` })
      throw recoveryError
    }
    process.exitCode = 1
  } finally {
    if (pausedDevServer) {
      try {
        restartOwnedViteDevServer(repoRoot, pausedDevServer)
      } catch (error) {
        console.error(`Could not restart the paused Vite dev server: ${error instanceof Error ? error.message : error}`)
        process.exitCode = 1
      }
    }
  }
}

export type PreparedAutomaticBuild = {
  buildID: string
  sourceFingerprint?: string
  artifactSha256?: string
  stagePath: string
  prodMarker?: string
  logPath: string
  externalManifestPath?: string
  externalManifestSha256?: string
}

async function buildAutomaticPackage(runID: string): Promise<PreparedAutomaticBuild> {
  await prepare({ runID, internal: true })
  const status = readStatus()
  if (status.status !== "ready" || !status.buildID || !status.stagePath) {
    throw new Error(`automatic build did not report READY (status: ${status.status})${status.error ? `: ${status.error}` : ""}`)
  }
  if (status.runID !== runID) throw new Error(`automatic build ${runID} lost ownership (status owner: ${status.runID ?? "none"})`)
  verifyPrepared(status)
  return {
    buildID: status.buildID,
    sourceFingerprint: status.sourceFingerprint,
    artifactSha256: status.artifactSha256,
    stagePath: status.stagePath,
    prodMarker: status.prodMarker,
    logPath: status.logPath ?? path.join(stateRoot, `build-${status.buildID}.log`),
    externalManifestPath: status.externalManifestPath,
    externalManifestSha256: status.externalManifestSha256,
  }
}

async function deployAutomaticPackage(
  prepared: PreparedAutomaticBuild,
  restart: boolean,
  forceCloseApproved: boolean,
  runID: string,
  workerStatus: (status: string, extra?: Record<string, unknown>) => void,
): Promise<PreparedAutomaticBuild & { backupPath?: string }> {
  verifyPreparedArtifact(prepared.stagePath, prepared)
  if (prepared.externalManifestPath) {
    verifyReleaseFiles(readExternalRelease({ externalManifestPath: prepared.externalManifestPath, externalManifestSha256: prepared.externalManifestSha256 }))
  }
  let backupPath: string | undefined
  try {
    backupPath = replaceInstallation(prepared.stagePath, installDir, prepared.buildID)
    if (prepared.externalManifestPath) {
      installReleaseFiles(readExternalRelease({ externalManifestPath: prepared.externalManifestPath, externalManifestSha256: prepared.externalManifestSha256 }))
    }
    const manifest = verifyManifest(installDir)
    if (restart) {
      workerStatus("automatic-restarting", { buildID: prepared.buildID, backupPath })
      startOpenCode()
      if (!(await waitForStableOpenCode())) throw new Error("new OpenCode process or desktop runtime did not become healthy")
    }
    return { ...prepared, artifactSha256: manifest.artifactSha256, backupPath }
  } catch (error) {
    if (error instanceof InstallationReplacementError) backupPath = error.backupPath
    let rollbackError: string | undefined
    if (backupPath) {
      try {
        await closeOpenCodeInventoried(forceCloseApproved)
        if (prepared.externalManifestPath) {
          try {
            rollbackReleaseFiles(readExternalReleaseReceipt({ externalManifestPath: prepared.externalManifestPath, externalManifestSha256: prepared.externalManifestSha256 }))
          } catch {
            const receiptPath = path.join(path.dirname(prepared.externalManifestPath), "receipt.json")
            if (fs.existsSync(receiptPath)) throw new Error(`external release receipt is inconsistent: ${receiptPath}`)
          }
        }
        rollbackInstallation(installDir, backupPath, prepared.buildID)
        if (restart) startOpenCode()
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)
      }
      if (rollbackError) {
        throw new Error(`${error instanceof Error ? error.message : error}; rollback failed: ${rollbackError}`)
      }
      throw new Error(`${error instanceof Error ? error.message : error}; deployment rolled back`)
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}

function readStatusStrictOrUndefined(): DeployStatus | undefined {
  try {
    return readDeployStatusStrict()
  } catch {
    return undefined
  }
}

async function runAutomaticRecovery(input: {
  runID: string
  repoRoot: string
  logPath: string
  message: string
  forceCloseApproved: boolean
}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`No interactive console for recovery. Inspect ${input.logPath} and run 'bun run desktop:deploy status'.`)
    writeStatus({ status: "automatic-failed", runID: input.runID, phase: "automatic-failed", logPath: input.logPath, error: input.message, recovery: "non-interactive" })
    return
  }
  writeStatus({ status: "automatic-recovering", runID: input.runID, phase: "automatic-recovering", logPath: input.logPath, error: input.message })
  try {
    console.error(`\nAutomatic build/deploy failed: ${input.message}`)
    console.error(`Full log: ${input.logPath}`)
    console.error(`\n1 OpenCode CLI repair (stored default chain)\n2 Codex CLI repair (its own settings)\n3 Start previous app\n4 Restore verified backup and start\n0 Abort without action`)
    let choice: RecoveryChoice
    for (;;) {
      try {
        choice = parseRecoveryChoice(await promptLine("Recovery choice [0-4] "))
        break
      } catch {
        console.error("Bitte 0, 1, 2, 3 oder 4 eingeben.")
      }
    }
    if (choice === "abort") {
      writeStatus({ status: "automatic-failed", runID: input.runID, phase: "automatic-failed", logPath: input.logPath, error: input.message, recovery: "aborted" })
      return
    }
    if (choice === "opencode") return runOpenCodeRecovery(input)
    if (choice === "codex") return runCodexRecovery(input)
    if (choice === "previous-app") return runPreviousAppRecovery(input)
    return runBackupRestoreRecovery(input)
  } catch (error) {
    const recoveryMessage = error instanceof Error ? error.message : String(error)
    if (readStatus().runID === input.runID)
      writeStatus({ status: "automatic-failed", runID: input.runID, phase: "automatic-failed", logPath: input.logPath, error: `${input.message}; recovery failed: ${recoveryMessage}` })
    throw error
  }
}

export function recoveryPrompt(input: { runID: string; repoRoot: string; logPath: string; message: string }) {
  return `Repair the failed OpenCode desktop deploy in ${input.repoRoot}. Read ${input.logPath}; failure: ${input.message}. Preserve unrelated work. Find and fix the actual cause, then run the relevant check. You may close and restart OpenCode.exe, build, and install. When ready, run "bun run desktop:deploy automatic --approved-close --force-close-approved --agent-retry" from the repo root. Its worker stays hidden and returns failures through "bun run desktop:deploy status"; follow each run until it completes or fails. If it fails, inspect the new log, fix the new cause, and retry only after new evidence or a change. Stay in this CLI. If you cannot resolve a concrete blocker, ask the user here what to do and wait for the answer. Do not commit, push, or launch another repair CLI.`
}

async function recoverFailedRun() {
  const status = readStatus()
  if (!["automatic-failed", "automatic-cancelled"].includes(status.status) || !status.runID || !status.logPath || !status.error)
    throw new Error("recover requires a recorded failed or cancelled automatic build with a log")
  const choice = parseRecoveryChoice(process.argv[3])
  if (choice !== "opencode" && choice !== "codex") throw new Error("recover requires opencode or codex")
  const input = { runID: status.runID, repoRoot, logPath: status.logPath, message: status.error }
  if (choice === "opencode") return runOpenCodeRecovery(input, process.argv.includes("--non-interactive"))
  if (process.argv.includes("--non-interactive")) throw new Error("non-interactive recovery is only supported for OpenCode")
  return runCodexRecovery(input)
}

async function runOpenCodeRecovery(input: { runID: string; repoRoot: string; logPath: string; message: string }, nonInteractive = false) {
  const cli = process.env.OPENCODE_CLI ?? "opencode"
  const contextPath = path.join(stateRoot, `automatic-${input.runID}-recovery.md`)
  const prompt = recoveryPrompt(input)
  fs.writeFileSync(
    contextPath,
    `# Automatic deploy recovery\n\n${prompt}\n`,
    "utf8",
  )
  const spawn = opencodeRecoverySpawn({ cli, repoRoot: input.repoRoot, contextPath, prompt, interactive: !nonInteractive })
  console.log(`Starting OpenCode repair with the stored default chain. No model override is passed; check the effective chain in the session.`)
  writeStatus({ status: "automatic-failed", runID: input.runID, phase: "automatic-failed", logPath: input.logPath, error: input.message, recovery: "opencode-repair" })
  await runInteractiveChild(spawn)
}

async function runCodexRecovery(input: { runID: string; repoRoot: string; logPath: string; message: string }) {
  const cli = process.env.CODEX_CLI ?? "codex"
  const probe = Bun.spawnSync([cli, "--help"], { stdout: "ignore", stderr: "ignore" })
  if (probe.exitCode !== 0) {
    console.error("Codex CLI is unavailable or unsuitable; no replacement action was started.")
    writeStatus({ status: "automatic-failed", runID: input.runID, phase: "automatic-failed", logPath: input.logPath, error: input.message, recovery: "codex-unavailable" })
    return
  }
  const spawn = codexRecoverySpawn({ cli, repoRoot: input.repoRoot, prompt: recoveryPrompt(input) })
  console.log(`Starting Codex with its own settings. No OpenCode chain applies.`)
  writeStatus({ status: "automatic-failed", runID: input.runID, phase: "automatic-failed", logPath: input.logPath, error: input.message, recovery: "codex-repair" })
  await runInteractiveChild(spawn)
}

async function runPreviousAppRecovery(input: { runID: string; logPath: string; message: string }) {
  // Recovery is entered from automatic-failed with the pre-swap failure captured
  // in input.message. The menu phase is automatic-recovering, so validate the
  // captured failure here instead of rereading that menu phase as install state.
  startOpenCode()
  if (!(await waitForStableOpenCode())) throw new Error("previous OpenCode process or desktop runtime did not become healthy")
  writeStatus({ status: "automatic-failed", runID: input.runID, phase: "automatic-failed", logPath: input.logPath, error: input.message, recovery: "previous-app" })
}

async function runBackupRestoreRecovery(input: {
  runID: string
  logPath: string
  message: string
  forceCloseApproved: boolean
}) {
  const backups = listManifestBackups()
  if (!backups.length) {
    console.error("No verified backup is available; no restore was started.")
    writeStatus({ status: "automatic-failed", runID: input.runID, phase: "automatic-failed", logPath: input.logPath, error: input.message, recovery: "restore-unavailable" })
    return
  }
  backups.forEach((backup, index) => console.error(`${index + 1} ${backup.buildID} ${backup.directory}`))
  const selection = Number(await promptLine(`Restore which verified backup [1-${backups.length}]? `))
  const selected = backups[selection - 1]
  if (!selected) {
    console.error("No backup selected; no restore was started.")
    writeStatus({ status: "automatic-failed", runID: input.runID, phase: "automatic-failed", logPath: input.logPath, error: input.message, recovery: "restore-unselected" })
    return
  }
  const confirmation = await promptLine(`Restore ${selected.buildID} and restart it? [y/N] `)
  if (!/^y(es)?$/i.test(confirmation.trim())) {
    writeStatus({ status: "automatic-failed", runID: input.runID, phase: "automatic-failed", logPath: input.logPath, error: input.message, recovery: "restore-declined" })
    return
  }
  const restored = await restoreVerifiedBackupTransaction(
    {
      backupDirectory: selected.directory,
      buildID: selected.buildID,
      artifactSha256: selected.artifactSha256,
      installPath: installDir,
    },
    {
      close: () => closeOpenCodeInventoried(input.forceCloseApproved),
      start: startOpenCode,
      waitForHealth: waitForStableOpenCode,
    },
  )
  writeStatus({ status: "automatic-failed", runID: input.runID, phase: "automatic-failed", logPath: input.logPath, error: input.message, recovery: `restored-${selected.buildID}`, backupPath: restored.backupPath, artifactSha256: restored.manifest.artifactSha256 })
}

export async function restoreVerifiedBackupTransaction(
  input: { backupDirectory: string; buildID: string; artifactSha256: string; installPath: string },
  dependencies: { close: () => Promise<unknown>; start: () => void; waitForHealth: () => Promise<boolean> },
) {
  const stagePath = path.join(
    path.dirname(input.installPath),
    `${path.basename(input.installPath)}.deploy-restore-${randomUUID()}`,
  )
  let backupPath: string | undefined
  try {
    fs.cpSync(input.backupDirectory, stagePath, { recursive: true, errorOnExist: true, force: false })
    const stagedManifest = verifyManifest(stagePath)
    if (stagedManifest.buildID !== input.buildID || stagedManifest.artifactSha256 !== input.artifactSha256)
      throw new Error(`verified backup changed after selection: ${input.backupDirectory}`)
    await dependencies.close()
    backupPath = replaceInstallation(stagePath, input.installPath, `restore-${input.buildID}`)
    const installedManifest = verifyManifest(input.installPath)
    if (installedManifest.buildID !== input.buildID || installedManifest.artifactSha256 !== input.artifactSha256)
      throw new Error(`restored installation does not match backup ${input.buildID}`)
    dependencies.start()
    if (!(await dependencies.waitForHealth())) throw new Error("restored OpenCode process or desktop runtime did not become healthy")
    return { backupPath, manifest: installedManifest }
  } catch (error) {
    if (!backupPath && error instanceof InstallationReplacementError) backupPath = error.backupPath
    if (backupPath) {
      try {
        // Do not rename an installation while its process may still be using it.
        await dependencies.close()
        rollbackInstallation(input.installPath, backupPath, `restore-${input.buildID}`)
      } catch (rollbackError) {
        throw new Error(
          `${error instanceof Error ? error.message : error}; backup restore rollback failed: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`,
          { cause: error },
        )
      }
      throw new Error(`${error instanceof Error ? error.message : error}; backup restore was rolled back`, { cause: error })
    }
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    fs.rmSync(stagePath, { recursive: true, force: true })
  }
}

async function runInteractiveChild(spawn: RecoverySpawn) {
  const child = Bun.spawn([spawn.command, ...spawn.args], { cwd: spawn.cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const exit = await child.exited
  if (exit !== 0) throw new Error(`${spawn.command} repair exited ${exit}`)
}

function printStatus() {
  const status = readStatus()
  const stall = detectDeployStall(status, { now: Date.now(), lockPID: readDeployLockPID(path.join(stateRoot, "deploy.lock")) })
  console.log(JSON.stringify(stall ? { ...status, ...stall } : status, null, 2))
}

function discard() {
  const releaseLock = acquireLock()
  try {
    if (!fs.existsSync(statusPath)) throw new Error(`deploy status does not exist: ${statusPath}`)
    const current = readStatus()
    assertNoConflictingAutomaticRun(current)
    if (current.status !== "ready" || !current.stagePath)
      throw new Error("only a ready, not-yet-launched deployment can be discarded")
    const expectedPrefix = `${path.basename(installDir)}.deploy-`
    if (
      path.dirname(current.stagePath) !== path.dirname(installDir) ||
      !path.basename(current.stagePath).startsWith(expectedPrefix)
    ) {
      throw new Error(`refusing to remove unexpected stage path: ${current.stagePath}`)
    }
    fs.rmSync(current.stagePath, { recursive: true, force: true })
    writeStatus({ ...current, status: "discarded" })
    console.log(`DISCARDED: ${current.buildID}`)
  } catch (error) {
    console.error(`FAILED: ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  } finally {
    releaseLock()
  }
}

export function createManifest(root: string, buildID: string, sourceFingerprint: string): BuildManifest {
  const files = hashTree(root)
  return {
    version: 1,
    buildID,
    channel: "prod",
    sourceFingerprint,
    createdAt: new Date().toISOString(),
    artifactSha256: treeDigest(files),
    files,
  }
}

export function verifyManifest(root: string) {
  const file = path.join(root, manifestName)
  if (!fs.existsSync(file)) throw new Error(`build manifest is missing: ${file}`)
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as BuildManifest
  if (value.version !== 1 || value.channel !== "prod" || !value.buildID || !value.sourceFingerprint) {
    throw new Error(`invalid production build manifest: ${file}`)
  }
  const actual = hashTree(root)
  if (treeDigest(actual) !== value.artifactSha256 || JSON.stringify(actual) !== JSON.stringify(value.files)) {
    throw new Error(`staged application bytes do not match build manifest ${value.buildID}`)
  }
  return value
}

export function verifyPreparedArtifact(
  root: string,
  expected: { buildID?: string; sourceFingerprint?: string; artifactSha256?: string },
) {
  const manifest = verifyManifest(root)
  if (
    manifest.buildID !== expected.buildID ||
    manifest.sourceFingerprint !== expected.sourceFingerprint ||
    manifest.artifactSha256 !== expected.artifactSha256
  ) {
    throw new Error(`staged application no longer matches pinned build ${expected.buildID ?? "<missing>"}`)
  }
  return manifest
}

function verifyPrepared(status: DeployStatus) {
  if (!status.stagePath) throw new Error("prepared deployment has no stage path")
  if (status.externalManifestPath) verifyReleaseFiles(readExternalRelease(status))
  return verifyPreparedArtifact(status.stagePath, status)
}

export function prepareExternalRelease(filename: string | undefined, directory: string, applicationDirectory = installDir) {
  if (!filename) return
  const input = z.object({
    entries: z.array(z.object({ source: z.string(), target: z.string(), expectedBaseHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional() }).strict()),
    packages: z.array(z.object({ name: z.string(), version: z.string(), api: z.record(z.string(), z.number().int().positive()), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  }).strict().parse(JSON.parse(fs.readFileSync(filename, "utf8")))
  for (const entry of input.entries) {
    const relative = path.relative(path.resolve(applicationDirectory), path.resolve(entry.target))
    if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)))
      throw new Error(`External release target overlaps the application directory: ${entry.target}`)
    const ancestor = path.relative(path.resolve(entry.target), path.resolve(applicationDirectory))
    if (!ancestor || (ancestor !== ".." && !ancestor.startsWith(`..${path.sep}`) && !path.isAbsolute(ancestor)))
      throw new Error(`External release target contains the application directory: ${entry.target}`)
  }
  const manifest = prepareReleaseFiles({ directory, entries: input.entries })
  const externalManifestPath = path.join(directory, "manifest.json")
  return { hostVersion: JSON.parse(fs.readFileSync(path.join(opencodeDir, "package.json"), "utf8")).version as string,
    externalManifestPath, externalManifestSha256: sha256(fs.readFileSync(externalManifestPath)), packages: input.packages,
    targets: manifest.entries.map((entry) => ({ target: entry.target, sha256: entry.sha256 })) }
}

export function readExternalRelease(status: Pick<DeployStatus, "externalManifestPath" | "externalManifestSha256">) {
  if (!status.externalManifestPath || !status.externalManifestSha256) throw new Error("External plugin release is not pinned")
  const data = fs.readFileSync(status.externalManifestPath)
  if (sha256(data) !== status.externalManifestSha256) throw new Error("External plugin release manifest changed")
  return parseReleaseFiles(JSON.parse(data.toString("utf8")))
}

export function readExternalReleaseReceipt(status: Pick<DeployStatus, "externalManifestPath" | "externalManifestSha256">) {
  const manifest = readExternalRelease(status)
  const receipt = parseReleaseFilesReceipt(JSON.parse(fs.readFileSync(path.join(manifest.directory, "receipt.json"), "utf8")))
  if (JSON.stringify(receipt.manifest) !== JSON.stringify(manifest)) throw new Error("External release receipt does not match the pinned manifest")
  return receipt
}

export function replaceInstallation(stage: string, target: string, buildID: string, rename = renameWithRetry) {
  verifyManifest(stage)
  if (path.dirname(stage) !== path.dirname(target))
    throw new Error("stage and installation must share a parent for atomic rename")
  if (!fs.existsSync(target)) throw new Error(`installed application is missing: ${target}`)
  const backup = `${target}.backup-${timestamp()}-${buildID}`
  rename(target, backup)
  try {
    rename(stage, target)
    verifyManifest(target)
    return backup
  } catch (error) {
    try {
      if (fs.existsSync(target)) rename(target, `${target}.failed-${timestamp()}-${buildID}`)
      rename(backup, target)
    } catch (rollbackError) {
      throw new InstallationReplacementError(
        `${error instanceof Error ? error.message : error}; immediate rollback failed: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`,
        backup,
        error,
      )
    }
    throw error
  }
}

export function rollbackInstallation(target: string, backup: string, buildID: string) {
  if (!fs.existsSync(backup)) throw new Error(`rollback backup is missing: ${backup}`)
  if (fs.existsSync(target)) renameWithRetry(target, `${target}.failed-${timestamp()}-${buildID}`)
  renameWithRetry(backup, target)
}

export function renameWithRetry(source: string, target: string) {
  return retryWindowsRename(() => fs.renameSync(source, target))
}

export function retryWindowsRename(operation: () => void, timeoutMs = 10_000, delayMs = 250): void {
  const deadline = Date.now() + timeoutMs
  try {
    operation()
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      !["EBUSY", "EPERM"].includes(String(error.code)) ||
      Date.now() >= deadline
    ) {
      throw error
    }
    Bun.sleepSync(Math.min(delayMs, Math.max(1, deadline - Date.now())))
    retryWindowsRename(operation, Math.max(0, deadline - Date.now()), delayMs)
  }
}

function hashTree(root: string) {
  const files: BuildManifest["files"] = []
  const visit = (dir: string) => {
    fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((entry) => {
        const absolute = path.join(dir, entry.name)
        if (entry.isDirectory()) return visit(absolute)
        const relative = path.relative(root, absolute).replaceAll("\\", "/")
        if (relative === manifestName) return
        const contents = fs.readFileSync(absolute)
        files.push({ path: relative, size: contents.byteLength, sha256: sha256(contents) })
      })
  }
  visit(root)
  return files
}

function treeDigest(files: BuildManifest["files"]) {
  return sha256(files.map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`).join(""))
}

function sourceTreeFingerprint() {
  const result = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      ".opencode/skills/opencode-desktop-deploy-restart",
      "packages/app",
      "packages/core",
      "packages/desktop",
      "packages/llm",
      "packages/opencode",
      "packages/plugin",
      "packages/sdk",
      "packages/server",
      "packages/ui",
      "packages/tui",
      "packages/tui-plugins",
      "packages/provider-plugins",
      ".opencode/plugin-sources",
      "script/plugin-package-artifacts.ts",
      "script/audit-plugin-sources.ts",
      "script/sync-plugin-sources.ts",
      "package.json",
      "bun.lock",
    ],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe", env: sourceFingerprintGitEnvironment(process.env) },
  )
  if (result.exitCode !== 0) throw new Error(`could not enumerate deployable source: ${result.stderr.toString()}`)
  const files = result.stdout
    .toString()
    .split("\0")
    .filter(Boolean)
    .filter(isDeployableSourceFile)
    .sort()
  return fingerprintSourceFiles(repoRoot, files)
}

export function sourceFingerprintGitEnvironment(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)),
  )
}

export function isDeployableSourceFile(file: string): boolean {
  // Runtime caches under .opencode/cache (e.g. the Cursor model snapshot) refresh periodically
  // while the app runs; they are not deployable source and would fail every prepare with
  // mixed-snapshot drift when a refresh lands inside the build window.
  if (/(^|\/)\.opencode\/cache(\/|$)/.test(file)) return false
  return !/(^|\/)(out|dist|node_modules|test-results)(\/|$)/.test(file)
}

export function fingerprintSourceFiles(root: string, files: string[]) {
  const hash = createHash("sha256")
  files.forEach((file) => {
    hash.update(file)
    hash.update("\0")
    const absolute = path.join(root, file)
    if (!fs.existsSync(absolute)) {
      hash.update("missing")
      hash.update("\0")
      return
    }
    hash.update("file")
    hash.update("\0")
    hash.update(fs.readFileSync(absolute))
    hash.update("\0")
  })
  return hash.digest("hex")
}

export function nativeWindowsCliOutput(root: string, arch: NodeJS.Architecture) {
  if (arch !== "x64" && arch !== "arm64") throw new Error(`unsupported Windows CLI architecture: ${arch}`)
  return path.join(root, "dist", `opencode-windows-${arch}`, "bin", "opencode.exe")
}

export function requiredDesktopPackageFiles() {
  return ["OpenCode.exe", path.join("resources", "app.asar"), path.join("resources", "opencode-cli.exe"),
    ...["provider", "tui"].map(family => path.join("resources", "plugin-packages", family, "release-manifest.json"))]
}

// The status names logPath from its first message on, so the file must exist
// before fingerprinting starts; otherwise a stalled phase points at a log
// that was never created.
export function writeBuildLogHeader(logPath: string, buildID: string) {
  const header = `BUILD   : ${buildID}\nPID     : ${process.pid}\nSTARTED : ${new Date().toISOString()}\n`
  fs.writeFileSync(logPath, header, { flag: "a" })
}

export function deployBuildEnv(source: NodeJS.ProcessEnv = process.env) {
  const env: NodeJS.ProcessEnv = { ...source, OPENCODE_CHANNEL: "prod" }
  // The in-app button runs through the desktop sidecar, which defers database
  // startup work for its live server. Build verifiers use isolated databases
  // and must not inherit those runtime-only deferrals.
  delete env.OPENCODE_DEFER_DB_STARTUP_REPAIRS
  delete env.OPENCODE_DEFER_BACKGROUND_STARTUP
  // Repair CLIs use --pure for their own session. Their child build still
  // needs plugins enabled so the production smoke checks exercise them.
  delete env.OPENCODE_PURE
  return env
}

export async function runLogged(command: string[], cwd: string, logPath: string, timeout: number) {
  fs.appendFileSync(logPath, `\n> ${command.join(" ")}\n`, "utf8")
  const env = deployBuildEnv()
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const log = fs.openSync(logPath, "a")
  const stdoutReader = child.stdout.getReader()
  const stderrReader = child.stderr.getReader()
  const pump = async (reader: ReadableStreamDefaultReader<Uint8Array>, target: NodeJS.WriteStream) => {
    while (true) {
      const next = await reader.read()
      if (next.done) return
      fs.writeSync(log, next.value)
      target.write(next.value)
    }
  }
  const output = Promise.all([pump(stdoutReader, process.stdout), pump(stderrReader, process.stderr)])
  const result = await withDeadline(child.exited, timeout)
  if (result === deadlineExpired) {
    terminateTree(child.pid)
    const stopped = await withDeadline(child.exited, 10_000)
    if (stopped === deadlineExpired) {
      child.kill()
      child.unref()
    }
    await Promise.allSettled([stdoutReader.cancel(), stderrReader.cancel()])
    await withDeadline(output, 1_000)
    fs.closeSync(log)
    throw new Error(`${command.join(" ")} exceeded the ${Math.round(timeout / 60_000)} minute deadline`)
  }
  await output
  fs.closeSync(log)
  if (typeof result !== "number" || result !== 0)
    throw new Error(`${command.join(" ")} exited ${String(result)}; see ${logPath}`)
}

async function withDeadline<T>(operation: Promise<T>, timeout: number): Promise<T | typeof deadlineExpired> {
  let watchdog: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<typeof deadlineExpired>((resolve) => {
        watchdog = setTimeout(() => resolve(deadlineExpired), timeout)
      }),
    ])
  } finally {
    if (watchdog) clearTimeout(watchdog)
  }
}

export type OpenCodeProcess = { pid: number; parentPid?: number; executablePath?: string; commandLine?: string }

export function parseOpenCodeInventory(output: string): OpenCodeProcess[] {
  return output
    .split(/\r?\n/)
    .flatMap((line): OpenCodeProcess[] => {
      if (!line.trim()) return []
      const parts = line.split("\t")
      const pid = Number(parts[0])
      if (!Number.isInteger(pid)) return []
      const parentPid = parts[1] ? Number(parts[1]) : Number.NaN
      return [
        {
          pid,
          parentPid: Number.isInteger(parentPid) ? parentPid : undefined,
          executablePath: parts[2]?.trim() || undefined,
          commandLine: parts.slice(3).join("\t").trim() || undefined,
        },
      ]
    })
}

export function filterAutomaticShutdownTargets(
  processes: OpenCodeProcess[],
  excludePids: number[],
): OpenCodeProcess[] {
  const excluded = new Set(excludePids)
  return processes.filter((entry) => Number.isInteger(entry.pid) && !excluded.has(entry.pid))
}

export function listOpenCodeProcesses(excludePids: number[] = []): OpenCodeProcess[] {
  if (process.platform !== "win32") return []
  const result = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='OpenCode.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)\" }",
    ],
    { stdout: "pipe", stderr: "ignore" },
  )
  if (result.exitCode !== 0) throw new Error("could not inventory OpenCode processes; refusing to close fail-closed")
  return filterAutomaticShutdownTargets(
    desktopShutdownTargets(parseOpenCodeInventory(result.stdout.toString()), path.join(installDir, "OpenCode.exe")),
    excludePids,
  )
}

export function desktopShutdownTargets(processes: OpenCodeProcess[], executable: string) {
  const target = path.resolve(executable).toLowerCase()
  return processes.filter((entry) => entry.executablePath && path.resolve(entry.executablePath).toLowerCase() === target)
}

export type ShutdownDependencies = {
  list?: () => OpenCodeProcess[]
  requestQuit?: () => Promise<boolean>
  waitForExit?: (timeoutMs: number) => Promise<boolean>
  killPid?: (pid: number, force: boolean) => void
}

export async function closeOpenCodeInventoried(forceApproved: boolean, deps: ShutdownDependencies = {}) {
  const list = deps.list ?? (() => listOpenCodeProcesses([process.pid]))
  const requestQuit = deps.requestQuit ?? requestDesktopQuit
  const waitForExit =
    deps.waitForExit ?? ((timeoutMs: number) => waitFor(() => list().length === 0, timeoutMs))
  const killPid =
    deps.killPid ??
    ((pid: number, force: boolean) => {
      Bun.spawnSync(["taskkill.exe", "/PID", String(pid), ...(force ? ["/F"] : [])], {
        stdout: "ignore",
        stderr: "ignore",
      })
    })
  const initial = list()
  if (initial.length === 0) return
  await requestQuit()
  if (await waitForExit(30_000)) return
  if (!forceApproved) throw new Error("OpenCode did not close gracefully; force close was not explicitly approved")
  // Re-inventory immediately before force-close so a reused PID can never be
  // killed: only processes still reported as OpenCode are eligible targets.
  const remaining = list()
  if (remaining.length === 0) return
  for (const entry of filterAutomaticShutdownTargets(remaining, [])) killPid(entry.pid, true)
  if (!(await waitForExit(15_000))) throw new Error("OpenCode processes remained after approved force close")
}

async function closeOpenCode(forceApproved: boolean) {
  return closeOpenCodeInventoried(forceApproved)
}

export async function requestDesktopQuit(
  tokenPath = path.join(process.env.APPDATA ?? "", "ai.opencode.desktop", "desktop-testing.json"),
) {
  if (!tokenPath || !fs.existsSync(tokenPath)) return false
  try {
    const token = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as { url?: unknown; token?: unknown }
    if (typeof token.url !== "string" || typeof token.token !== "string") return false
    const response = await fetch(`${token.url}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-desktop-token": token.token },
      body: JSON.stringify({ type: "app.quit" }),
      signal: AbortSignal.timeout(3_000),
    })
    return response.ok
  } catch {
    return false
  }
}

function startOpenCode() {
  const executable = path.join(installDir, "OpenCode.exe")
  if (!fs.existsSync(executable)) throw new Error(`deployed executable is missing: ${executable}`)
  const env = { ...process.env }
  // A repair CLI can use --pure for its own session. Do not launch the
  // installed Desktop with that CLI-only restriction inherited.
  delete env.OPENCODE_PURE
  Bun.spawn([executable], { env, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref()
}

function isOpenCodeRunning() {
  const result = Bun.spawnSync(["tasklist.exe", "/FI", "IMAGENAME eq OpenCode.exe", "/FO", "CSV", "/NH"], {
    stdout: "pipe",
    stderr: "ignore",
  })
  return result.exitCode === 0 && /"OpenCode\.exe","\d+"/i.test(result.stdout.toString())
}

async function waitForStableOpenCode() {
  if (!(await waitFor(isOpenCodeRunning, 5_000))) return false
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!isOpenCodeRunning()) return false
    await Bun.sleep(250)
  }
  const tokenFile = path.join(process.env.APPDATA ?? "", "ai.opencode.desktop", "desktop-testing.json")
  if (!fs.existsSync(tokenFile)) return isOpenCodeRunning()
  const runtimeDeadline = Date.now() + 120_000
  while (Date.now() < runtimeDeadline) {
    if (!isOpenCodeRunning()) return false
    if (await probeDesktopRuntime(tokenFile)) return true
    await Bun.sleep(1_000)
  }
  return false
}

export async function probeDesktopRuntime(tokenFile: string) {
  try {
    const connection = z.object({ url: z.string().url(), token: z.string().min(1) }).parse(JSON.parse(fs.readFileSync(tokenFile, "utf8")))
    const url = new URL("/status", connection.url)
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false
    const response = await fetch(url, { headers: { authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(3_000) })
    if (!response.ok) return false
    const status = z.object({ sidecar: z.object({ healthy: z.literal(true) }), renderer: z.object({ error: z.null().optional() }) }).safeParse(await response.json())
    return status.success
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, timeout: number) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return true
    await Bun.sleep(250)
  }
  return check()
}

function terminateTree(pid: number) {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill.exe", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
    return
  }
  process.kill(pid, "SIGKILL")
}

export type DeployLock = { pid: number; startedAt: string }

export function parseDeployLock(content: string): DeployLock | undefined {
  const text = content.trim()
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text) as { pid?: unknown; startedAt?: unknown }
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid)) {
      return { pid: parsed.pid, startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "" }
    }
  } catch {
    // Legacy locks written by older deploys contain a bare PID instead of JSON.
  }
  if (/^\d+$/.test(text)) return { pid: Number(text), startedAt: "" }
  return undefined
}

// A lock is only active when the recorded PID is alive AND is still the same
// process that wrote the lock. PID reuse (alive but different start time) and
// missing PIDs both prove the owning deploy is gone, so its lock is orphaned.
export function evaluateDeployLock(
  lock: DeployLock,
  pidAlive: boolean,
  currentStartedAt: string | null,
): { active: boolean; reason: string } {
  if (!pidAlive) return { active: false, reason: `recorded PID ${lock.pid} is no longer running` }
  if (lock.startedAt && currentStartedAt && currentStartedAt !== lock.startedAt) {
    return {
      active: false,
      reason: `PID ${lock.pid} was reused by a newer process (lock start ${lock.startedAt}, current start ${currentStartedAt})`,
    }
  }
  return { active: true, reason: `PID ${lock.pid} is running` }
}

export function currentProcessStartedAt(pid: number): string | null {
  // A process start time never changes, so cache per PID: acquiring the lock
  // reads it for the own process on every CLI invocation.
  const cached = startedAtCache.get(pid)
  if (cached !== undefined) return cached
  const startedAt = readProcessStartedAt(pid)
  startedAtCache.set(pid, startedAt)
  return startedAt
}

const startedAtCache = new Map<number, string | null>()

function readProcessStartedAt(pid: number): string | null {
  if (process.platform !== "win32") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
      return stat.substring(stat.lastIndexOf(")") + 2).trim().split(" ")[19] || null
    } catch {
      return null
    }
  }
  const result = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  )
  if (result.exitCode !== 0) return null
  return result.stdout.toString().trim() || null
}

export function acquireDeployLockAt(
  lockPath: string,
  own: DeployLock,
  readStartedAt: (pid: number) => string | null,
): () => void {
  if (fs.existsSync(lockPath)) {
    const lock = parseDeployLock(fs.readFileSync(lockPath, "utf8"))
    if (lock) {
      const alive = processRunning(lock.pid)
      const verdict = evaluateDeployLock(lock, alive, alive ? readStartedAt(lock.pid) : null)
      if (verdict.active) {
        throw new Error(
          `another desktop deploy owns ${lockPath} (PID ${lock.pid}${lock.startedAt ? `, started ${lock.startedAt}` : ""})`,
        )
      }
      console.warn(`adopting orphaned deploy lock: ${verdict.reason}`)
    } else {
      console.warn(`replacing unreadable deploy lock at ${lockPath}`)
    }
    fs.rmSync(lockPath, { force: true })
  }
  fs.writeFileSync(lockPath, JSON.stringify(own), { encoding: "utf8", flag: "wx" })
  return () => fs.rmSync(lockPath, { force: true })
}

function acquireLock() {
  return acquireDeployLockAt(
    path.join(stateRoot, "deploy.lock"),
    { pid: process.pid, startedAt: currentProcessStartedAt(process.pid) ?? "" },
    currentProcessStartedAt,
  )
}

export type DeployStall = { stalled: true; ageSeconds: number; lockPID?: number }

// Phases that must keep progressing; a frozen updatedAt here means the deploy
// worker is wedged or gone. ready, failed, completed, deployed and discarded
// are intentional resting states and never stall.
const transientDeployStatuses = new Set([
  "fingerprinting-source",
  "building",
  "packaging",
  "staging",
  "launching-worker",
  "worker-started",
  "closing-app",
  "deploying",
  "restarting",
  ...inFlightAutomaticStatuses,
])

export const DEFAULT_DEPLOY_STALL_THRESHOLD_MS = 120_000

export function deployStallThresholdMs() {
  const configured = Number(process.env.OPENCODE_DEPLOY_STALL_THRESHOLD_SECONDS)
  return Number.isFinite(configured) && configured > 0 ? configured * 1000 : DEFAULT_DEPLOY_STALL_THRESHOLD_MS
}

export function detectDeployStall(
  status: DeployStatus,
  options: { now?: number; lockPID?: number; thresholdMs?: number } = {},
): DeployStall | undefined {
  if (!transientDeployStatuses.has(status.status)) return undefined
  const updatedAtMs = Date.parse(status.updatedAt)
  if (Number.isNaN(updatedAtMs)) return undefined
  const ageMs = (options.now ?? Date.now()) - updatedAtMs
  if (ageMs < (options.thresholdMs ?? deployStallThresholdMs())) return undefined
  const stall: DeployStall = { stalled: true, ageSeconds: Math.round(ageMs / 1000) }
  if (options.lockPID !== undefined) stall.lockPID = options.lockPID
  return stall
}

export function readDeployLockPID(lockPath: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown }
    return typeof parsed.pid === "number" ? parsed.pid : undefined
  } catch {
    return undefined
  }
}

// The build and smoke test can fail under memory pressure (exit code 9 was
// observed near 2 GiB free). Keep the requested 1.5 GiB reserve at preflight;
// memory use can still rise after this check.
export const MIN_BUILD_FREE_MEMORY_BYTES = 1.5 * 1024 ** 3

export function minBuildFreeMemoryBytes(): number {
  const configured = Number(process.env.OPENCODE_DEPLOY_MIN_FREE_MEMORY_MB)
  return Number.isFinite(configured) && configured > 0 ? configured * 1024 * 1024 : MIN_BUILD_FREE_MEMORY_BYTES
}

export function assertFreeMemoryForBuild(freeBytes: number, minBytes = minBuildFreeMemoryBytes()) {
  if (freeBytes >= minBytes) return
  const freeGiB = (freeBytes / 1024 ** 3).toFixed(1)
  const minGiB = (minBytes / 1024 ** 3).toFixed(1)
  throw new Error(
    `build blocked: only ${freeGiB} GiB of memory is free, but the desktop build needs at least ${minGiB} GiB. ` +
      "Close applications to free memory and retry, otherwise the build or its smoke test dies from memory pressure before packaging.",
  )
}

export type ProcessEntry = { pid: number; parentPid?: number; name: string; commandLine: string; devArgs?: string[] }

const competingWriterNames = /^(bun|node|npm|npx|git|tsc|vite|electron|python)(\.exe)?$/i

export function filterCompetingWriters(entries: ProcessEntry[], root: string, selfPID: number): ProcessEntry[] {
  const normalizedRoot = root.toLowerCase()
  return entries.filter(
    (entry) =>
      entry.pid !== selfPID &&
      competingWriterNames.test(entry.name) &&
      entry.commandLine.toLowerCase().includes(normalizedRoot) &&
      !entry.commandLine.toLowerCase().includes("desktop-prod-deploy"),
  )
}

export function assertNoCompetingWriters(entries: ProcessEntry[], root: string, selfPID: number) {
  const competing = filterCompetingWriters(entries, root, selfPID)
  if (!competing.length) return
  const listed = competing
    .map((entry) => `PID ${entry.pid} ${entry.name}: ${entry.commandLine.slice(0, 200)}`)
    .join("; ")
  throw new Error(
    `build blocked: ${competing.length} competing process(es) are working in ${root} and may change sources mid-build. ` +
      `Stop them or run the deploy later (${listed})`,
  )
}

export function ownedViteDevServer(entries: ProcessEntry[], root: string): ProcessEntry | undefined {
  const vitePath = path.join(root, "packages", "app", "node_modules", ".bin", "vite.exe").toLowerCase()
  const vite = entries.filter((entry) => entry.name.toLowerCase() === "vite.exe" &&
    entry.commandLine.trim().replaceAll('"', "").toLowerCase().startsWith(vitePath))
  if (vite.length !== 1) return undefined
  const viteCommand = vite[0]!.commandLine.trim().replaceAll('"', "")
  const viteOptions = viteCommand.slice(vitePath.length).trim()
  const optionMatch = viteOptions.match(/^(?:--host (?:127\.0\.0\.1|localhost) --port ([1-9]\d{0,4}) --strictPort)?$/i)
  if (!viteCommand.toLowerCase().startsWith(vitePath) || !optionMatch || (optionMatch[1] && Number(optionMatch[1]) > 65535)) return undefined
  const owner = entries.find((entry) => entry.pid === vite[0]!.parentPid)
  const ownerMatch = owner?.commandLine.trim().match(/(?:^|[/\\])bun(?:\.exe)?"?\s+run\s+dev(?:\s+(.*))?$/i)
  if (!owner || !/^bun(?:\.exe)?$/i.test(owner.name) || !ownerMatch || (ownerMatch[1] ?? "") !== viteOptions) return undefined
  const descendants = entries.filter((entry) => entry.parentPid === vite[0]!.pid)
  if (descendants.some((entry) => {
    if (entry.name.toLowerCase() === "conhost.exe")
      return !/^\\\?\?\\[a-z]:\\windows\\system32\\conhost\.exe\s/i.test(entry.commandLine)
    const nodeCommand = entry.commandLine.trim().replaceAll('"', "")
    const nodePath = path.join(root, "packages", "app", "node_modules", "vite", "bin", "vite.js").toLowerCase()
    return !/^node(?:\.exe)?$/i.test(entry.name) || nodeCommand.toLowerCase() !== `node ${nodePath}${viteOptions ? ` ${viteOptions.toLowerCase()}` : ""}`
  })) return undefined
  return { ...owner, devArgs: viteOptions ? viteOptions.split(" ") : [] }
}

async function pauseOwnedViteDevServer(root: string) {
  const owner = ownedViteDevServer(listLocalProcesses(), root)
  if (!owner || ownedViteDevServer(listLocalProcesses(), root)?.pid !== owner.pid) return undefined
  const result = Bun.spawnSync(["taskkill.exe", "/PID", String(owner.pid), "/T", "/F"], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`could not pause the verified Vite dev server: ${result.stderr.toString().trim()}`)
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!listLocalProcesses().some((entry) => entry.pid === owner.pid)) return owner
    await Bun.sleep(250)
  }
  throw new Error(`Vite dev server PID ${owner.pid} remained after shutdown`)
}

export function viteDevServerLaunch(root: string, owner?: ProcessEntry) {
  return { command: [process.execPath, "run", "dev", ...(owner?.devArgs ?? [])], cwd: path.join(root, "packages", "app") }
}

function restartOwnedViteDevServer(root: string, owner: ProcessEntry) {
  const launch = viteDevServerLaunch(root, owner)
  const child = Bun.spawn(launch.command, {
    cwd: launch.cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
    detached: true,
  })
  child.unref()
  console.log(`Restarted paused Vite dev server as PID ${child.pid}`)
}

export function listLocalProcesses(): ProcessEntry[] {
  if (process.platform !== "win32") return []
  const result = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)\" }",
    ],
    { stdout: "pipe", stderr: "ignore" },
  )
  if (result.exitCode !== 0) return []
  return result.stdout
    .toString()
    .split(/\r?\n/)
    .flatMap((line): ProcessEntry[] => {
      const first = line.indexOf("\t")
      const second = line.indexOf("\t", first + 1)
      const third = line.indexOf("\t", second + 1)
      const pid = Number(first > 0 ? line.slice(0, first) : Number.NaN)
      const parentPid = Number(second > first ? line.slice(first + 1, second) : Number.NaN)
      const name = third > second ? line.slice(second + 1, third) : ""
      if (!Number.isInteger(pid) || !name) return []
      return [{ pid, ...(Number.isInteger(parentPid) ? { parentPid } : {}), name, commandLine: line.slice(third + 1) }]
    })
}

export function assertUnchangedFingerprint(before: string, after: string, phase: string) {
  if (before === after) return
  throw new Error(
    `deployable source changed ${phase}; refusing to continue with a mixed snapshot (was ${before.slice(0, 12)}, now ${after.slice(0, 12)})`,
  )
}

function processRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Orphaned stages accumulate when a previous deploy never reached its own
// cleanup: a failed prepare only deletes its stage while status is exactly
// "staging", and an interrupted run can leave a stage behind a rewritten
// status. Removal therefore only trusts the deploy lock, the recorded
// status, exact stage naming, and real (non-reparse) directories directly
// under the install parent.
export type StageCleanupResult = {
  removed: string[]
  dryRun: boolean
  inFlightStatus?: string
}

// Launch/worker phases never hold deploy.lock, so seeing them under an
// acquired lock means another launcher or worker may still be mid-flight;
// cleanup refuses to race them. Crashed prepare phases are different: their
// runs hold deploy.lock while alive, so reaching cleanup with one of those
// statuses proves the owning run is gone and its stage is stale.
const liveDeployStatuses = new Set([
  "ready",
  "launching-worker",
  "worker-started",
  "closing-app",
  "deploying",
  "restarting",
  ...inFlightAutomaticStatuses,
])

export class PreparedDeploymentExistsError extends Error {
  readonly buildID: string | undefined

  constructor(buildID: string | undefined) {
    super(
      buildID
        ? `prepared deployment ${buildID} is still ready; launch it or run 'desktop:deploy discard' before preparing another build`
        : "a prepared deployment is still ready; launch it or run 'desktop:deploy discard' before preparing another build",
    )
    this.name = "PreparedDeploymentExistsError"
    this.buildID = buildID
  }
}

export function assertPrepareCanStart(status: DeployStatus | undefined) {
  if (status?.status === "ready") throw new PreparedDeploymentExistsError(status.buildID)
}

export function cleanOrphanedDeployStages(
  options: { installPath?: string; dryRun?: boolean; readStatusOverride?: () => DeployStatus | undefined } = {},
): StageCleanupResult {
  const dryRun = options.dryRun ?? false
  const installPath = options.installPath ?? installDir
  const parent = path.dirname(installPath)
  const prefix = `${path.basename(installPath)}.deploy-`
  if (!path.isAbsolute(parent)) throw new Error(`deploy stage parent is not absolute: ${parent}`)
  const parentReal = realPathWithin(parent)
  if (!fs.statSync(parent).isDirectory()) throw new Error(`deploy stage parent is not a directory: ${parent}`)

  const currentStatus = (options.readStatusOverride ?? readDeployStatusStrict)()
  // A live launch/worker owns stages and status.json without holding the
  // deploy lock; never race them. Stale prepare phases (crashed run) are
  // cleaned because reaching here proves their lock is gone.
  if (currentStatus && liveDeployStatuses.has(currentStatus.status))
    return { removed: [], dryRun, inFlightStatus: currentStatus.status }

  const installName = path.basename(installPath)
  const protectedPaths = [
    installPath,
    ...listPrefixedDirectories(parent, `${installName}.backup-`),
    ...listPrefixedDirectories(parent, `${installName}.failed-`),
  ]

  const removed: string[] = []
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    const candidate = path.join(parent, entry.name)
    if (!entry.name.startsWith(prefix) || candidate === installPath) continue
    if (entry.isSymbolicLink()) continue
    if (!isRealLocalDirectory(candidate, parentReal)) continue
    if (protectedPaths.some((protectedPath) => isSameOrInside(candidate, protectedPath))) continue
    // Only exact "<timestamp>-<8 hex>" build-ID suffixes are ever removed.
    if (!/^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(entry.name.slice(prefix.length))) continue
    if (dryRun) {
      removed.push(candidate)
      continue
    }
    try {
      fs.rmSync(candidate, { recursive: true, force: true })
    } catch (error) {
      console.warn(`could not remove orphaned stage ${candidate}: ${error instanceof Error ? error.message : error}`)
      continue
    }
    removed.push(candidate)
  }
  return { removed, dryRun }
}

export function stagePrefix(installPath = installDir) {
  return `${path.basename(installPath)}.deploy-`
}

function realPathWithin(directory: string) {
  const resolved = path.normalize(directory)
  let real: string
  try {
    real = fs.realpathSync(resolved)
  } catch (error) {
    throw new Error(`cannot safely scan deploy stage parent: ${directory}`, { cause: error })
  }
  // A differing real path means the parent itself sits behind a reparse point.
  if (!isSameWindowsPath(real, resolved))
    throw new Error(`deploy stage parent is redirected by a reparse point: ${resolved}`)
  return resolved
}

function isRealLocalDirectory(candidate: string, parentReal: string) {
  try {
    const lstat = fs.lstatSync(candidate)
    if (!lstat.isDirectory() || lstat.isSymbolicLink()) return false
    // Volume mount points can pass lstat as plain directories while resolving
    // elsewhere; require exact real-path identity inside the scanned parent.
    const real = fs.realpathSync(candidate)
    return isSameWindowsPath(real, candidate) && isSameOrInside(real, parentReal)
  } catch {
    return false
  }
}

function isSameWindowsPath(a: string, b: string) {
  return path.relative(a.toLowerCase(), path.normalize(b).toLowerCase()) === ""
}

function isSameOrInside(candidate: string, protectedPath: string) {
  const relative = path.relative(protectedPath.toLowerCase(), path.normalize(candidate).toLowerCase())
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function listPrefixedDirectories(parent: string, prefix: string) {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink() && entry.name.startsWith(prefix))
      .map((entry) => path.join(parent, entry.name))
  } catch {
    return []
  }
}

function readDeployStatusStrict(root = stateRoot): DeployStatus | undefined {
  const currentStatusPath = path.join(root, "status.json")
  if (!fs.existsSync(currentStatusPath)) return undefined
  try {
    const parsed = JSON.parse(fs.readFileSync(currentStatusPath, "utf8"))
    return parseDeployStatus(parsed, currentStatusPath)
  } catch (error) {
    if (error instanceof DeployStatusShapeError) throw error
    throw new Error(`deploy status is unreadable; refusing to touch deploy stages fail-closed: ${currentStatusPath}`, {
      cause: error,
    })
  }
}

class DeployStatusShapeError extends Error {
  constructor(detail: string, sourcePath = statusPath) {
    super(`deploy status has invalid shape (${detail}); refusing to touch deploy stages fail-closed: ${sourcePath}`)
    this.name = "DeployStatusShapeError"
  }
}

const supportedDeployStatuses = new Set([
  "fingerprinting-source",
  "building",
  "packaging",
  "staging",
  "ready",
  "launching-worker",
  "worker-started",
  "closing-app",
  "deploying",
  "restarting",
  "deployed",
  "completed",
  "failed",
  "discarded",
  ...inFlightAutomaticStatuses,
  "automatic-completed",
  "automatic-failed",
  "automatic-cancelled",
])

export function parseDeployStatus(parsed: unknown, sourcePath = statusPath): DeployStatus {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new DeployStatusShapeError("not a plain object", sourcePath)
  const record = parsed as Record<string, unknown>
  if (typeof record.status !== "string" || !record.status) throw new DeployStatusShapeError("status is not a non-empty string", sourcePath)
  if (!supportedDeployStatuses.has(record.status))
    throw new DeployStatusShapeError(`unknown status ${JSON.stringify(record.status)}`, sourcePath)
  for (const key of ["buildID", "stagePath"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") throw new DeployStatusShapeError(`${key} is present but not a string`, sourcePath)
  }
  if (record.updatedAt !== undefined && (typeof record.updatedAt !== "string" || Number.isNaN(Date.parse(record.updatedAt)))) {
    throw new DeployStatusShapeError("updatedAt is present but not a parseable date", sourcePath)
  }
  if (record.runID !== undefined && (typeof record.runID !== "string" || !automaticRunIDPattern.test(record.runID))) {
    throw new DeployStatusShapeError("runID is present but invalid", sourcePath)
  }
  return parsed as DeployStatus
}


function pruneBackups() {
  try {
    const parent = path.dirname(installDir)
    const prefix = `${path.basename(installDir)}.backup-`
    fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => path.join(parent, entry.name))
      .sort()
      .slice(0, -backupRetention)
      .forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
  } catch (error) {
    console.warn(
      `desktop deploy completed, but old backup pruning failed: ${error instanceof Error ? error.message : error}`,
    )
  }
}

function readStatus() {
  if (!fs.existsSync(statusPath)) fail(`deploy status does not exist: ${statusPath}`)
  try {
    return parseDeployStatus(JSON.parse(fs.readFileSync(statusPath, "utf8")))
  } catch (error) {
    if (error instanceof DeployStatusShapeError) throw error
    throw new Error(`deploy status is unreadable; refusing to continue fail-closed: ${statusPath}`, { cause: error })
  }
}

function writeStatus(status: Omit<DeployStatus, "updatedAt"> | DeployStatus, root = stateRoot) {
  const currentStatusPath = path.join(root, "status.json")
  const value = { ...status, updatedAt: new Date().toISOString() }
  const temporary = `${currentStatusPath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  fs.renameSync(temporary, currentStatusPath)
  if (value.buildID) {
    fs.writeFileSync(
      path.join(root, `status-${value.buildID}.json`),
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    )
  }
}

function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function requiredArgument(name: string) {
  const value = argument(name)
  if (!value) fail(`missing ${name}`)
  return value
}

function scriptPath() {
  return path.resolve(import.meta.dir, "desktop-prod-deploy.ts")
}

function launchCancellationPath(buildID: string, launchToken: string) {
  return path.join(stateRoot, `cancel-${buildID}-${launchToken}`)
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

function ps(value: string) {
  return value.replaceAll("'", "''")
}

function fail(message: string): never {
  console.error(`FAILED: ${message}`)
  process.exit(1)
}

if (import.meta.main) {
  await main()
}
