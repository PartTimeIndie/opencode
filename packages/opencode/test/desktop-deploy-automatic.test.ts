import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  assertNoConflictingAutomaticRun,
  automaticDescriptorPath,
  cancelAutomaticHandoff,
  claimAutomaticHandoff,
  closeOpenCodeInventoried,
  createManifest,
  detectDeployStall,
  filterAutomaticShutdownTargets,
  listManifestBackups,
  parseDeployStatus,
  parseRecoveryChoice,
  parseRunDescriptor,
  codexRecoverySpawn,
  opencodeRecoverySpawn,
  readRunDescriptor,
  restoreVerifiedBackupTransaction,
  verifyManifest,
  writeRunDescriptor,
  type RunDescriptor,
} from "../script/desktop-prod-deploy"

function descriptor(overrides: Partial<RunDescriptor> = {}): RunDescriptor {
  return {
    version: 1,
    runID: "auto-20261016T000000Z-abcdef12",
    repoRoot: path.resolve("C:\\repo"),
    installDir: "C:\\Programs\\OpenCode",
    createdAt: new Date().toISOString(),
    pid: process.pid,
    startedAt: "now",
    approvedClose: true,
    forceCloseApproved: true,
    restart: true,
    phase: "automatic-handoff",
    launchToken: "token",
    ...overrides,
  }
}

describe("automatic shutdown inventory", () => {
  test("closes only inventoried OpenCode processes and spares the controller", async () => {
    const killed: Array<{ pid: number; force: boolean }> = []
    let alive = [{ pid: 4321 }, { pid: 4322 }]
    await closeOpenCodeInventoried(true, {
      list: () => alive,
      requestQuit: async () => true,
      waitForExit: async () => alive.length === 0,
      killPid: (pid, force) => {
        killed.push({ pid, force })
        alive = alive.filter((entry) => entry.pid !== pid)
      },
    })
    expect(alive).toEqual([])
    expect(killed.map((entry) => entry.pid).sort()).toEqual([4321, 4322])
  })

  test("does not build when the graceful close fails without force approval", async () => {
    await expect(
      closeOpenCodeInventoried(false, {
        list: () => [{ pid: 4321 }],
        requestQuit: async () => false,
        waitForExit: async () => false,
        killPid: () => {
          throw new Error("must not kill without approval")
        },
      }),
    ).rejects.toThrow(/not explicitly approved/)
  })

  test("excludes the controller and launcher from shutdown targets", () => {
    expect(
      filterAutomaticShutdownTargets(
        [{ pid: 100 }, { pid: 200 }, { pid: 300 }],
        [100, 200],
      ),
    ).toEqual([{ pid: 300 }])
  })

  test("kills only processes that are still inventoried before force-close", async () => {
    const killed: number[] = []
    let calls = 0
    await closeOpenCodeInventoried(true, {
      list: () => {
        calls += 1
        if (calls === 1) return [{ pid: 4321 }, { pid: 4322 }]
        return [{ pid: 4322 }]
      },
      requestQuit: async () => true,
      waitForExit: async () => false,
      killPid: (pid) => {
        killed.push(pid)
      },
    }).catch(() => undefined)
    expect(killed).toEqual([4322])
  })
})

describe("automatic handoff and single-flight ownership", () => {
  test("creates, validates, and consumes a run descriptor exactly once", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-automatic-run-"))
    try {
      const expected = descriptor()
      writeRunDescriptor(expected, root)
      expect(automaticDescriptorPath(expected.runID, root)).toBe(
        path.join(root, `automatic-run-${expected.runID}.json`),
      )
      expect(readRunDescriptor(expected.runID, root)).toEqual(expected)
      const claimed = claimAutomaticHandoff(expected.runID, "token", root)
      expect(claimed.consumed).toBe(true)
      expect(claimed.phase).toBe("automatic-worker-started")
      expect(() => claimAutomaticHandoff(expected.runID, "token", root)).toThrow(/already consumed/)
      const fresh = descriptor({ runID: "auto-20261016T000000Z-abcdef99", launchToken: "token" })
      writeRunDescriptor(fresh, root)
      expect(() => claimAutomaticHandoff(fresh.runID, "other", root)).toThrow(/no longer current/)
      expect(() => cancelAutomaticHandoff("auto-missing", "reason", root)).not.toThrow()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects malformed or mismatched run descriptors fail-closed", () => {
    expect(() => parseRunDescriptor({ version: 1 })).toThrow(/run ID/)
    expect(() => parseRunDescriptor(descriptor({ repoRoot: "relative" }))).toThrow(/absolute/)
    expect(() =>
      assertNoConflictingAutomaticRun({ status: "automatic-building", runID: "other" }, "current"),
    ).toThrow(/still in flight/)
    expect(() =>
      assertNoConflictingAutomaticRun({ status: "automatic-building", runID: "current" }, "current"),
    ).not.toThrow()
    expect(() =>
      assertNoConflictingAutomaticRun({ status: "building", runID: "other" }, "current"),
    ).toThrow(/still in flight/)
    expect(() => assertNoConflictingAutomaticRun({ status: "ready" }, "current")).not.toThrow()
    expect(() =>
      assertNoConflictingAutomaticRun({ status: "ready", runID: "auto-20261016T000000Z-abcdef12" }, "current"),
    ).toThrow(/still in flight/)
    expect(() => parseDeployStatus({ status: "", updatedAt: new Date().toISOString() })).toThrow(/non-empty string/)
    expect(() => parseDeployStatus({ status: "building", updatedAt: "not-a-date" })).toThrow(/parseable date/)
    expect(() => parseDeployStatus({ status: "automatic-building", runID: "../evil", updatedAt: new Date().toISOString() })).toThrow(/runID/)
    expect(detectDeployStall({ status: "automatic-building", updatedAt: new Date(Date.now() - 300_000).toISOString() })).toMatchObject({ stalled: true })
    expect(assertNoConflictingAutomaticRun({ status: "completed" }, "current")).toBeUndefined()
  })

  test("cancels only an unclaimed handoff and writes status under its supplied state root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-automatic-cancel-"))
    try {
      const pending = descriptor()
      writeRunDescriptor(pending, root)
      fs.writeFileSync(
        path.join(root, "status.json"),
        JSON.stringify({ status: "automatic-handoff", runID: pending.runID }),
      )

      expect(cancelAutomaticHandoff(pending.runID, "worker did not start", root)).toMatchObject({
        consumed: true,
        phase: "automatic-cancelled",
      })
      expect(JSON.parse(fs.readFileSync(path.join(root, "status.json"), "utf8"))).toMatchObject({
        status: "automatic-failed",
        runID: pending.runID,
        phase: "automatic-cancelled",
        error: "worker did not start",
      })
      expect(fs.existsSync(path.join(root, `status-${pending.runID}.json`))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("cancellation preserves a foreign in-flight status and never overwrites a claimed worker", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-automatic-cancel-owner-"))
    try {
      const pending = descriptor()
      writeRunDescriptor(pending, root)
      const foreignStatus = { status: "automatic-building", runID: "auto-20261016T000000Z-abcdef99" }
      fs.writeFileSync(path.join(root, "status.json"), JSON.stringify(foreignStatus))
      cancelAutomaticHandoff(pending.runID, "late timeout", root)
      expect(JSON.parse(fs.readFileSync(path.join(root, "status.json"), "utf8"))).toMatchObject(foreignStatus)

      const claimed = descriptor({ runID: "auto-20261016T000000Z-fedcba98" })
      writeRunDescriptor(claimed, root)
      fs.writeFileSync(path.join(root, "status.json"), JSON.stringify({ status: "automatic-worker-started", runID: claimed.runID }))
      expect(claimAutomaticHandoff(claimed.runID, "token", root).phase).toBe("automatic-worker-started")
      expect(cancelAutomaticHandoff(claimed.runID, "late timeout", root)).toBeUndefined()
      expect(readRunDescriptor(claimed.runID, root)).toMatchObject({ consumed: true, phase: "automatic-worker-started" })
      expect(JSON.parse(fs.readFileSync(path.join(root, "status.json"), "utf8"))).toMatchObject({
        status: "automatic-worker-started",
        runID: claimed.runID,
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("automatic recovery choices", () => {
  test("maps console input to exactly one recovery action", () => {
    expect(parseRecoveryChoice("1")).toBe("opencode")
    expect(parseRecoveryChoice("2")).toBe("codex")
    expect(parseRecoveryChoice("3")).toBe("previous-app")
    expect(parseRecoveryChoice("4")).toBe("restore-backup")
    expect(parseRecoveryChoice("0")).toBe("abort")
    expect(parseRecoveryChoice(undefined)).toBe("abort")
    expect(() => parseRecoveryChoice("9")).toThrow(/unknown recovery choice/)
  })

  test("starts repair CLIs without model overrides or permission bypasses", () => {
    const open = opencodeRecoverySpawn({ cli: "opencode", repoRoot: "C:\\repo", contextPath: "C:\\state\\context.md" })
    expect(open.args).toEqual(["run", "--interactive", "--dir", "C:\\repo", "--file", "C:\\state\\context.md"])
    expect(open.args.join(" ")).not.toContain("--model")
    expect(open.args.join(" ")).not.toContain("dangerously-skip-permissions")
    const codex = codexRecoverySpawn({ cli: "codex", repoRoot: "C:\\repo" })
    expect(codex.args).toEqual([])
    expect(() => opencodeRecoverySpawn({ cli: "", repoRoot: "C:\\repo", contextPath: "context" })).toThrow(/unavailable/)
    expect(() => codexRecoverySpawn({ cli: "", repoRoot: "C:\\repo" })).toThrow(/unavailable/)
  })

  test("offers only manifest-valid backups from the install parent", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-automatic-backup-"))
    try {
      const installDir = path.join(parent, "@opencode-aidesktop")
      fs.mkdirSync(installDir, { recursive: true })
      const valid = path.join(parent, "@opencode-aidesktop.backup-20261016T000000Z-restore1")
      const broken = path.join(parent, "@opencode-aidesktop.backup-20261016T000000Z-broken1")
      for (const directory of [valid, broken]) fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(valid, "OpenCode.exe"), "valid")
      const manifest = {
        version: 1,
        buildID: "restore1",
        channel: "prod",
        sourceFingerprint: "source",
        createdAt: new Date().toISOString(),
        artifactSha256: "",
        files: [] as Array<{ path: string; size: number; sha256: string }>,
      }
      const { createHash } = require("node:crypto") as typeof import("node:crypto")
      const digest = createHash("sha256").update("valid").digest("hex")
      manifest.files = [{ path: "OpenCode.exe", size: 5, sha256: digest }]
      manifest.artifactSha256 = createHash("sha256").update(`${manifest.files[0].path}\u00005\u0000${digest}\n`).digest("hex")
      fs.writeFileSync(path.join(valid, ".opencode-build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
      expect(verifyManifest(valid).buildID).toBe("restore1")
      const backups = listManifestBackups(installDir)
      expect(backups.map((backup) => backup.buildID)).toEqual(["restore1"])
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  test("backup restore shuts down before swapping and rolls back on failed health", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-automatic-restore-"))
    const installDir = path.join(parent, "OpenCode")
    const backupDir = path.join(parent, "OpenCode.backup-selected")
    try {
      makeManifestBuild(installDir, "previous-build", "previous")
      makeManifestBuild(backupDir, "selected-build", "selected")
      const events: string[] = []

      await expect(
        restoreVerifiedBackupTransaction(
          {
            backupDirectory: backupDir,
            buildID: "selected-build",
            artifactSha256: verifyManifest(backupDir).artifactSha256,
            installPath: installDir,
          },
          {
            close: async () => void events.push("close"),
            start: () => events.push("start"),
            waitForHealth: async () => false,
          },
        ),
      ).rejects.toThrow(/rolled back/)

      expect(events).toEqual(["close", "start", "close"])
      expect(verifyManifest(installDir).buildID).toBe("previous-build")
      expect(fs.readdirSync(parent).some((name) => name.includes(".deploy-restore-"))).toBe(false)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  test("backup restore does not mutate the installation when checked shutdown fails", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-automatic-restore-shutdown-"))
    const installDir = path.join(parent, "OpenCode")
    const backupDir = path.join(parent, "OpenCode.backup-selected")
    try {
      makeManifestBuild(installDir, "previous-build", "previous")
      makeManifestBuild(backupDir, "selected-build", "selected")
      const start = () => {
        throw new Error("must not start before swap")
      }

      await expect(
        restoreVerifiedBackupTransaction(
          {
            backupDirectory: backupDir,
            buildID: "selected-build",
            artifactSha256: verifyManifest(backupDir).artifactSha256,
            installPath: installDir,
          },
          {
            close: async () => {
              throw new Error("OpenCode did not exit")
            },
            start,
            waitForHealth: async () => true,
          },
        ),
      ).rejects.toThrow("OpenCode did not exit")

      expect(verifyManifest(installDir).buildID).toBe("previous-build")
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  test("backup restore keeps both directories untouched if shutdown cannot be verified before rollback", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-automatic-restore-close-again-"))
    const installDir = path.join(parent, "OpenCode")
    const backupDir = path.join(parent, "OpenCode.backup-selected")
    try {
      makeManifestBuild(installDir, "previous-build", "previous")
      makeManifestBuild(backupDir, "selected-build", "selected")
      let closes = 0
      await expect(
        restoreVerifiedBackupTransaction(
          {
            backupDirectory: backupDir,
            buildID: "selected-build",
            artifactSha256: verifyManifest(backupDir).artifactSha256,
            installPath: installDir,
          },
          {
            close: async () => {
              closes += 1
              if (closes === 2) throw new Error("OpenCode did not exit before rollback")
            },
            start: () => undefined,
            waitForHealth: async () => false,
          },
        ),
      ).rejects.toThrow(/rollback failed: OpenCode did not exit before rollback/)

      expect(closes).toBe(2)
      expect(verifyManifest(installDir).buildID).toBe("selected-build")
      const previousBackup = fs
        .readdirSync(parent)
        .map((name) => path.join(parent, name))
        .find((directory) => {
          try {
            return verifyManifest(directory).buildID === "previous-build"
          } catch {
            return false
          }
        })
      expect(previousBackup).toBeDefined()
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})

function makeManifestBuild(directory: string, buildID: string, contents: string) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "OpenCode.exe"), contents)
  const manifest = createManifest(directory, buildID, `source-${buildID}`)
  fs.writeFileSync(path.join(directory, ".opencode-build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}
