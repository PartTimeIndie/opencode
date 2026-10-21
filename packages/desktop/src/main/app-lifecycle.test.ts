import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deepLinkCorrelation, installedBuildIdentity, lifecycleIdentity, quitRequestedRecord, redactDeepLink, relaunchRequestedRecord } from "./app-lifecycle"

const incidentHandoff =
  "opencode://plugin-handoff/?directory=C%3A%5CGitRepros%5Copencode&pluginID=scheduled-jobs-app&handlerID=run&payload=%7B%22scopeId%22%3A%22opencode-6bf699ecdff8%22%2C%22runId%22%3A%22f44887cc68ae43c79e7e29a1fc0d4787%22%2C%22slug%22%3A%22scheduler-nightly-failure-watchdog%22%7D"

describe("app lifecycle records", () => {
  test("redacts deep link query and hash while keeping scheme and path", () => {
    expect(redactDeepLink(incidentHandoff)).toBe("opencode://plugin-handoff/")
    expect(redactDeepLink("opencode://scheduled-job-run?runId=1")).toBe("opencode://scheduled-job-run")
    expect(redactDeepLink("opencode://open-project?directory=C%3A%5Cwork#frag")).toBe("opencode://open-project")
  })

  test("extracts non-secret scheduled-job correlation ids and drops everything else", () => {
    const [handoff] = deepLinkCorrelation([incidentHandoff])
    expect(handoff).toEqual({
      url: "opencode://plugin-handoff/",
      scopeId: "opencode-6bf699ecdff8",
      slug: "scheduler-nightly-failure-watchdog",
      runId: "f44887cc68ae43c79e7e29a1fc0d4787",
    })
  })

  test("keeps non-handoff deep links redacted without correlation ids", () => {
    expect(deepLinkCorrelation(["opencode://open-project?directory=C%3A%5Csecret%5Cdir"])).toEqual([
      { url: "opencode://open-project" },
    ])
    expect(deepLinkCorrelation(["opencode://plugin-handoff/?payload=not-json"])).toEqual([
      { url: "opencode://plugin-handoff/" },
    ])
  })

  test("identity is stable within the process and carries pid/ppid/bootId", () => {
    const first = lifecycleIdentity()
    const second = lifecycleIdentity()
    expect(second).toBe(first)
    expect(first.pid).toBe(process.pid)
    expect(first.ppid).toBeGreaterThan(0)
    expect(first.bootId).toMatch(/^\d+$/)
  })

  test("relaunch and quit records name their trigger and share the boot identity", () => {
    const relaunch = relaunchRequestedRecord("unresponsive-dialog")
    const quit = quitRequestedRecord("before-quit")
    expect(relaunch.reason).toBe("unresponsive-dialog")
    expect(quit.source).toBe("before-quit")
    expect(relaunch.bootId).toBe(quit.bootId)
  })

  test("installed build identity reports the real deployed manifest fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-build-identity-"))
    try {
      await writeFile(
        join(root, ".opencode-build-manifest.json"),
        JSON.stringify({
          version: 1,
          buildID: "20261003-120000-abcd1234",
          channel: "prod",
          sourceFingerprint: "f".repeat(64),
          createdAt: "2026-10-03T12:00:00.000Z",
          artifactSha256: "a".repeat(64),
          files: [{ path: "OpenCode.exe", size: 1, sha256: "0".repeat(64) }],
        }),
      )
      expect(installedBuildIdentity(root)).toEqual({
        present: true,
        buildID: "20261003-120000-abcd1234",
        channel: "prod",
        sourceFingerprint: "f".repeat(64),
        artifactSha256: "a".repeat(64),
        manifestCreatedAt: "2026-10-03T12:00:00.000Z",
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a missing manifest stays honest instead of inventing a fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-build-identity-missing-"))
    try {
      const identity = installedBuildIdentity(root)
      expect(identity.present).toBe(false)
      if (identity.present) throw new Error("unreachable")
      expect(identity.manifestPath).toBe(join(root, ".opencode-build-manifest.json"))
      expect(identity.reason).toContain("ENOENT")
      expect("sourceFingerprint" in identity).toBe(false)
      expect("buildID" in identity).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("foreign or partial manifests never yield a partial fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-build-identity-invalid-"))
    try {
      const manifests = [
        JSON.stringify({
          version: 2,
          buildID: "future",
          channel: "prod",
          sourceFingerprint: "f".repeat(64),
          artifactSha256: "a".repeat(64),
          createdAt: "t",
        }),
        JSON.stringify({ version: 1, buildID: "partial", channel: "prod" }),
        "{corrupt",
        "null",
      ]
      for (const [index, content] of manifests.entries()) {
        const dir = join(root, `case-${index}`)
        await mkdir(dir)
        await writeFile(join(dir, ".opencode-build-manifest.json"), content)
        const identity = installedBuildIdentity(dir)
        expect(identity.present).toBe(false)
        if (identity.present) throw new Error("unreachable")
        expect("sourceFingerprint" in identity).toBe(false)
        expect("buildID" in identity).toBe(false)
        expect(identity.reason).toBeTruthy()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
