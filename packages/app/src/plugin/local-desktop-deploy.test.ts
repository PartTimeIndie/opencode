import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

type DeployModule = {
  commandErrorMessage: (result: { output: string; exitCode: number }) => string
  deployPhase: (output: string) => "Prepare" | "Deploy"
  isInFlightDeployStatus: (status: unknown) => boolean
  hasLaunchMarker: (result: { output?: string; stdout?: string; exitCode: number }, buildID: string) => boolean
  deployStatus: (
    status: string,
    result: { output: string; exitCode: number },
    directory: string,
  ) => {
    output: string
    outputTruncated: boolean
    logPath?: string
    phase: "Prepare" | "Deploy"
    prodMarker?: string
  }
  preparedBuild: (output: string) =>
    | {
        buildID: string
        sourceFingerprint: string
        artifactSha256: string
        stagePath: string
        prodMarker: string
        logPath: string
      }
    | undefined
  preparedBuildStatus: (
    status: { status: string; finishedAt: number; buildID?: string; logPath?: string },
    startedAt: number,
  ) => ReturnType<DeployModule["preparedBuild"]>
  durableStatus: (
    output: string,
    directory: string,
  ) => { status: string; buildID?: string; message?: string } | undefined
  previousStatusLine: (status: { status: string; finishedAt: number; logPath?: string; message?: string }) => string
  prepareScript: () => string
  automaticScript: () => string
  hasAutomaticMarker: (result: { output?: string; stdout?: string; exitCode: number }) => boolean
  launchScript: (buildID: string) => string
  statusScript: () => string
}

const deploy = (await import(
  new URL("../../../../.opencode/plugin-sources/local-desktop-deploy-app/index.js", import.meta.url).href
)) as unknown as DeployModule

describe("local desktop deploy failures", () => {
  test("PowerShell host commands request text output rather than serialized CLIXML", () => {
    expect(deploy.prepareScript()).toContain("| ForEach-Object { $_.ToString() }")
    expect(deploy.prepareScript()).not.toContain("Write-Error $_")
  })

  test.skipIf(process.platform !== "win32")(
    "native command failures preserve their exit code and readable stderr through EncodedCommand",
    () => {
      const script = deploy
        .prepareScript()
        .replace(
          '@("run", "desktop:deploy", "prepare")',
          `@("-e", "console.error('deploy boundary failure'); process.exit(7)")`,
        )
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { cwd: fileURLToPath(new URL("../../../../", import.meta.url)), encoding: "utf8", timeout: 15_000 },
      )
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(7)
      expect(result.stdout).toContain("deploy boundary failure")
      expect(`${result.stdout}${result.stderr}`).not.toContain("CLIXML")
      expect(`${result.stdout}${result.stderr}`).not.toContain("<Objs")
    },
  )

  test("shows and stores a bounded tail while preserving the durable build log path", () => {
    const output = `LOG     : C:\\Temp\\opencode-deploy-button.log\nBUILD-BEGIN-${"x".repeat(250_000)}\nnode runtime guard failed\nBun.file found in out/main/index.js`
    const result = { output, exitCode: 1 }

    expect(deploy.commandErrorMessage(result)).toContain("Prepare failed (exit code 1)")
    expect(deploy.commandErrorMessage(result)).toContain(
      "node runtime guard failed\nBun.file found in out/main/index.js",
    )
    expect(deploy.commandErrorMessage(result)).toContain("Full log: C:\\Temp\\opencode-deploy-button.log")
    expect(deploy.commandErrorMessage(result)).not.toContain("BUILD-BEGIN")
    expect(deploy.deployStatus("failed", result, "C:/repo")).toMatchObject({
      phase: "Prepare",
      logPath: "C:\\Temp\\opencode-deploy-button.log",
      outputTruncated: true,
    })
    expect(deploy.deployStatus("failed", result, "C:/repo").output.length).toBeLessThanOrEqual(6_100)
    expect(deploy.deployStatus("failed", result, "C:/repo").output).not.toContain("BUILD-BEGIN")
    expect(deploy.deployStatus("failed", { output: "x".repeat(6_001), exitCode: 1 }, "C:/repo").outputTruncated).toBe(
      true,
    )
  })

  test("labels failures after prepare as deploy failures", () => {
    const output = "$ bun run desktop:deploy launch --build-id build-1\nverification failed"

    expect(deploy.deployPhase(output)).toBe("Deploy")
    expect(deploy.commandErrorMessage({ output, exitCode: 1 })).toStartWith("Deploy failed (exit code 1)")
  })

  test("labels automatic failures as deploy failures and tracks in-flight deploys", () => {
    expect(deploy.deployPhase("AUTOMATIC : detached worker for auto-1\nverification failed")).toBe("Deploy")
    expect(deploy.isInFlightDeployStatus("automatic-building")).toBe(true)
    expect(deploy.isInFlightDeployStatus("launching-worker")).toBe(true)
    expect(deploy.isInFlightDeployStatus("automatic-failed")).toBe(false)
    expect(deploy.isInFlightDeployStatus("completed")).toBe(false)
  })

  test("accepts only a launch acknowledgement for the pinned build", () => {
    const result = { stdout: "STARTED : detached deploy worker for 20260731T120000Z-abcd1234", exitCode: 0 }
    expect(deploy.hasLaunchMarker(result, "20260731T120000Z-abcd1234")).toBe(true)
    expect(deploy.hasLaunchMarker(result, "20260731T120000Z-other123")).toBe(false)
  })

  test("uses the canonical full-package prepare, external automatic handoff, and durable status commands", () => {
    expect(deploy.prepareScript()).toContain('@("run", "desktop:deploy", "prepare")')
    expect(deploy.automaticScript()).toContain(
      '@("run", "desktop:deploy", "automatic", "--detach", "--approved-close", "--force-close-approved", "--restart")',
    )
    expect(deploy.statusScript()).toContain('@("run", "desktop:deploy", "status")')
    expect(deploy.prepareScript()).not.toContain("deploy-asar")
    expect(deploy.automaticScript()).not.toContain("deploy-asar")
    expect(deploy.hasAutomaticMarker({ output: "AUTOMATIC : detached worker for auto-1", exitCode: 0 })).toBe(true)
    expect(deploy.hasAutomaticMarker({ output: "READY : build-1", exitCode: 0 })).toBe(false)
    expect(deploy.launchScript("20260731T120000Z-abcd1234")).toContain(
      '@("run", "desktop:deploy", "launch", "--build-id", "20260731T120000Z-abcd1234", "--approved-close", "--force-close-approved", "--restart")',
    )
    expect(() => deploy.launchScript("unsafe; Stop-Process")).toThrow("invalid desktop deploy build ID")
  })

  test("requires complete READY metadata and reconciles durable completion", () => {
    const output = [
      "READY   : 20260731T120000Z-abcd1234",
      "SOURCE  : source-sha",
      "ARTIFACT: artifact-sha",
      "STAGE   : C:\\Programs\\OpenCode.deploy-build",
      "PROD    : C:\\repo\\packages\\desktop\\out\\.build-channel",
      "LOG     : C:\\OpenCodeDeploy\\build.log",
    ].join("\n")
    expect(deploy.preparedBuild(output)).toEqual({
      buildID: "20260731T120000Z-abcd1234",
      sourceFingerprint: "source-sha",
      artifactSha256: "artifact-sha",
      stagePath: "C:\\Programs\\OpenCode.deploy-build",
      prodMarker: "C:\\repo\\packages\\desktop\\out\\.build-channel",
      logPath: "C:\\OpenCodeDeploy\\build.log",
    })
    expect(deploy.preparedBuild(output.replace("ARTIFACT", "MISSING"))).toBeUndefined()
    expect(deploy.preparedBuild(output.replace("PROD", "MISS"))).toBeUndefined()
    expect(
      deploy.durableStatus(
        '$ bun run script/desktop-prod-deploy.ts status\n{"status":"completed","buildID":"build-1","updatedAt":"2026-07-31T12:00:00.000Z","prodMarker":"C:\\\\repo\\\\packages\\\\desktop\\\\out\\\\.build-channel","backupPath":"C:\\\\Programs\\\\OpenCode.backup","artifactSha256":"asar-sha"}',
        "C:/repo",
      ),
    ).toMatchObject({
      status: "completed",
      buildID: "build-1",
      message:
        "Prod deploy completed for build-1. Prod marker: C:\\repo\\packages\\desktop\\out\\.build-channel. Backup: C:\\Programs\\OpenCode.backup. Deployed ASAR version: asar-sha.",
    })
  })

  test("recovers READY metadata from fresh durable status when the host command output omits it", () => {
    const ready = {
      status: "ready",
      finishedAt: 200,
      buildID: "20260923T151525Z-85f7765d",
      sourceFingerprint: "source-sha",
      artifactSha256: "artifact-sha",
      stagePath: "C:\\Programs\\OpenCode.deploy-build",
      prodMarker: "C:\\repo\\packages\\desktop\\out\\.build-channel",
      logPath: "C:\\OpenCodeDeploy\\build.log",
    }

    expect(deploy.preparedBuildStatus(ready, 100)).toEqual({
      buildID: ready.buildID,
      sourceFingerprint: ready.sourceFingerprint,
      artifactSha256: ready.artifactSha256,
      stagePath: ready.stagePath,
      prodMarker: ready.prodMarker,
      logPath: ready.logPath,
    })
    expect(deploy.preparedBuildStatus({ ...ready, finishedAt: 99 }, 100)).toBeUndefined()
    expect(deploy.preparedBuildStatus({ ...ready, status: "failed" }, 100)).toBeUndefined()
    expect(deploy.preparedBuildStatus({ ...ready, logPath: undefined }, 100)).toBeUndefined()
  })

  test("keeps previous failure dialogs concise and links the durable log", () => {
    const text = deploy.previousStatusLine({
      status: "failed",
      finishedAt: 0,
      logPath: "C:\\Temp\\opencode-deploy-button.log",
      message: `Build failed (exit code 1)\nEARLY-${"x".repeat(20_000)}\nlatest-error`,
    })

    expect(text).toContain("Letztes Log: C:\\Temp\\opencode-deploy-button.log")
    expect(text).toContain("latest-error")
    expect(text).not.toContain("EARLY-")
    expect(text.length).toBeLessThan(1_300)
  })
})
