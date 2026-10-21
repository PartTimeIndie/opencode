import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import {
  createManifest,
  fingerprintSourceFiles,
  InstallationReplacementError,
  renameWithRetry,
  replaceInstallation,
  requestDesktopQuit,
  retryWindowsRename,
  rollbackInstallation,
  runLogged,
  verifyManifest,
  verifyPreparedArtifact,
} from "../script/desktop-prod-deploy"

const roots: string[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
})

test("manifest rejects changed, missing, and extra application files", () => {
  const root = fixtureRoot("manifest")
  fs.mkdirSync(path.join(root, "resources"), { recursive: true })
  fs.writeFileSync(path.join(root, "OpenCode.exe"), "current exe")
  fs.writeFileSync(path.join(root, "resources", "app.asar"), "current asar")
  writeManifest(root)

  expect(verifyManifest(root).artifactSha256).toBeTruthy()
  fs.writeFileSync(path.join(root, "resources", "app.asar"), "stale asar")
  expect(() => verifyManifest(root)).toThrow("do not match")
  fs.writeFileSync(path.join(root, "resources", "app.asar"), "current asar")
  fs.writeFileSync(path.join(root, "old-runtime.dll"), "old")
  expect(() => verifyManifest(root)).toThrow("do not match")
  fs.rmSync(path.join(root, "old-runtime.dll"))
  fs.rmSync(path.join(root, "OpenCode.exe"))
  expect(() => verifyManifest(root)).toThrow("do not match")
})

test("full installation replacement has exact new bytes and preserves rollback", () => {
  const parent = fixtureRoot("replace")
  const target = path.join(parent, "installed")
  const stage = path.join(parent, "installed.deploy-build-1")
  fs.mkdirSync(path.join(target, "resources", "app.asar.unpacked"), { recursive: true })
  fs.writeFileSync(path.join(target, "OpenCode.exe"), "old executable")
  fs.writeFileSync(path.join(target, "resources", "app.asar"), "old asar")
  fs.writeFileSync(path.join(target, "resources", "app.asar.unpacked", "old.node"), "old native")
  fs.mkdirSync(path.join(stage, "resources", "app.asar.unpacked"), { recursive: true })
  fs.writeFileSync(path.join(stage, "OpenCode.exe"), "new executable")
  fs.writeFileSync(path.join(stage, "resources", "app.asar"), "new asar")
  fs.writeFileSync(path.join(stage, "resources", "app.asar.unpacked", "new.node"), "new native")
  writeManifest(stage)

  const backup = replaceInstallation(stage, target, "build-1")

  expect(fs.readFileSync(path.join(target, "OpenCode.exe"), "utf8")).toBe("new executable")
  expect(fs.existsSync(path.join(target, "resources", "app.asar.unpacked", "old.node"))).toBe(false)
  expect(fs.readFileSync(path.join(backup, "OpenCode.exe"), "utf8")).toBe("old executable")
  expect(verifyManifest(target).buildID).toBe("build-1")

  rollbackInstallation(target, backup, "build-1")
  expect(fs.readFileSync(path.join(target, "OpenCode.exe"), "utf8")).toBe("old executable")
})

test("Windows installation rename retries transient filesystem locks", () => {
  let attempts = 0
  retryWindowsRename(
    () => {
      attempts++
      if (attempts < 3) throw Object.assign(new Error("installation is still locked"), { code: "EPERM" })
    },
    1_000,
    1,
  )

  expect(attempts).toBe(3)
})

test("Windows installation rename does not retry permanent failures", () => {
  let attempts = 0
  expect(() =>
    retryWindowsRename(() => {
      attempts++
      throw Object.assign(new Error("source is missing"), { code: "ENOENT" })
    }),
  ).toThrow("source is missing")
  expect(attempts).toBe(1)
})

test("failed immediate restore preserves the backup path for worker recovery", () => {
  const parent = fixtureRoot("replace-recovery")
  const target = path.join(parent, "installed")
  const stage = path.join(parent, "installed.deploy-build-1")
  fs.mkdirSync(path.join(target, "resources"), { recursive: true })
  fs.writeFileSync(path.join(target, "OpenCode.exe"), "old executable")
  fs.writeFileSync(path.join(target, "resources", "app.asar"), "old asar")
  fs.mkdirSync(path.join(stage, "resources"), { recursive: true })
  fs.writeFileSync(path.join(stage, "OpenCode.exe"), "new executable")
  fs.writeFileSync(path.join(stage, "resources", "app.asar"), "new asar")
  writeManifest(stage)
  let attempts = 0

  expect(() =>
    replaceInstallation(stage, target, "build-1", (source, destination) => {
      attempts++
      if (attempts === 1) return renameWithRetry(source, destination)
      throw Object.assign(new Error("installation remains locked"), { code: "EPERM" })
    }),
  ).toThrow(InstallationReplacementError)
  expect(attempts).toBe(3)
  expect(fs.existsSync(target)).toBe(false)
  expect(
    fs.readdirSync(parent).some((entry) => entry.startsWith("installed.backup-") && entry.endsWith("-build-1")),
  ).toBe(true)
})

test("prepared artifact remains pinned if files and manifest are both replaced", () => {
  const root = fixtureRoot("pinned")
  fs.mkdirSync(path.join(root, "resources"), { recursive: true })
  fs.writeFileSync(path.join(root, "OpenCode.exe"), "current exe")
  fs.writeFileSync(path.join(root, "resources", "app.asar"), "current asar")
  const pinned = writeManifest(root)

  expect(verifyPreparedArtifact(root, pinned).artifactSha256).toBe(pinned.artifactSha256)
  fs.writeFileSync(path.join(root, "resources", "app.asar"), "different asar")
  writeManifest(root)

  expect(() => verifyPreparedArtifact(root, pinned)).toThrow("no longer matches pinned build")
})

test("source fingerprint records tracked deletions without opening missing files", () => {
  const root = fixtureRoot("source-deletion")
  const deleted = fingerprintSourceFiles(root, ["deleted.txt"])
  fs.writeFileSync(path.join(root, "deleted.txt"), "")
  const empty = fingerprintSourceFiles(root, ["deleted.txt"])
  fs.writeFileSync(path.join(root, "deleted.txt"), "restored")

  expect(empty).not.toBe(deleted)
  expect(fingerprintSourceFiles(root, ["deleted.txt"])).not.toBe(deleted)
  fs.rmSync(path.join(root, "deleted.txt"))
  expect(fingerprintSourceFiles(root, ["deleted.txt"])).toBe(deleted)
})

test("desktop deploy requests a real app quit before falling back to taskkill", async () => {
  const root = fixtureRoot("desktop-quit")
  const tokenPath = path.join(root, "desktop-testing.json")
  let request: { token: string | null; body: unknown } | undefined
  const server = Bun.serve({
    port: 0,
    async fetch(input) {
      request = {
        token: input.headers.get("x-opencode-desktop-token"),
        body: await input.json(),
      }
      return Response.json({ ok: true })
    },
  })
  fs.writeFileSync(tokenPath, JSON.stringify({ url: server.url.origin, token: "desktop-token" }))

  try {
    expect(await requestDesktopQuit(tokenPath)).toBe(true)
  } finally {
    server.stop(true)
  }
  expect(request).toEqual({ token: "desktop-token", body: { type: "app.quit" } })
})

test("legacy partial ASAR deploy is rejected", () => {
  const result = Bun.spawnSync([process.execPath, "run", path.resolve(import.meta.dir, "..", "deploy-asar.ts")], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  })

  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain("partial ASAR replacement can mix old and new")
})

test("logged subprocesses are terminated at their hard deadline", async () => {
  const root = fixtureRoot("deadline")
  const started = Date.now()

  await expect(
    runLogged([process.execPath, "-e", "await Bun.sleep(60000)"], root, path.join(root, "deadline.log"), 100),
  ).rejects.toThrow("exceeded")
  expect(Date.now() - started).toBeLessThan(5_000)
})

test("successful logged subprocess clears its watchdog before process exit", () => {
  const root = fixtureRoot("watchdog")
  const started = Date.now()
  const module = pathToFileURL(path.resolve(import.meta.dir, "..", "script", "desktop-prod-deploy.ts")).href
  const script = `const mod = await import(${JSON.stringify(module)}); await mod.runLogged([process.execPath, "-e", "console.log('done')"], ${JSON.stringify(root)}, ${JSON.stringify(path.join(root, "watchdog.log"))}, 3000)`

  const result = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })

  expect(result.exitCode).toBe(0)
  expect(Date.now() - started).toBeLessThan(1_500)
})

test("logged build subprocesses do not inherit desktop sidecar deferrals", async () => {
  const root = fixtureRoot("sidecar-env")
  const previousRepairs = process.env.OPENCODE_DEFER_DB_STARTUP_REPAIRS
  const previousBackground = process.env.OPENCODE_DEFER_BACKGROUND_STARTUP
  process.env.OPENCODE_DEFER_DB_STARTUP_REPAIRS = "1"
  process.env.OPENCODE_DEFER_BACKGROUND_STARTUP = "1"
  try {
    await runLogged(
      [
        process.execPath,
        "-e",
        "if (process.env.OPENCODE_DEFER_DB_STARTUP_REPAIRS || process.env.OPENCODE_DEFER_BACKGROUND_STARTUP) process.exit(41)",
      ],
      root,
      path.join(root, "sidecar-env.log"),
      3_000,
    )
  } finally {
    if (previousRepairs === undefined) delete process.env.OPENCODE_DEFER_DB_STARTUP_REPAIRS
    else process.env.OPENCODE_DEFER_DB_STARTUP_REPAIRS = previousRepairs
    if (previousBackground === undefined) delete process.env.OPENCODE_DEFER_BACKGROUND_STARTUP
    else process.env.OPENCODE_DEFER_BACKGROUND_STARTUP = previousBackground
  }
})

function fixtureRoot(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `opencode-desktop-deploy-${name}-`))
  roots.push(root)
  return root
}

function writeManifest(root: string) {
  const manifest = createManifest(root, "build-1", "source-1")
  fs.writeFileSync(path.join(root, ".opencode-build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
