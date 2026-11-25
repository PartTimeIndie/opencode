import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { MirrorSession } from "../src/session/workspace/mirror-session"
import { tmpdir } from "./fixture/tmpdir"

async function git(directory: string, args: string[]) {
  const child = Bun.spawn(["git", "-c", "core.autocrlf=false", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code) throw new Error(stderr)
  return stdout
}

async function reservations(root: string) {
  return (await fs.readdir(root)).filter((name) => /^[a-f0-9]{64}$/.test(name))
}

test("first-use Status is read-only; a Session reuses its independent dirty-source Mirror", async () => {
  await using source = await tmpdir({ git: true })
  await using storage = await tmpdir()
  await fs.writeFile(path.join(source.path, "tracked.txt"), "basis")
  await git(source.path, ["add", "tracked.txt"])
  await git(source.path, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "basis"])
  await fs.writeFile(path.join(source.path, "tracked.txt"), "dirty source")
  await fs.writeFile(path.join(source.path, "selected.txt"), "selected")
  await fs.writeFile(path.join(source.path, "private.txt"), "not selected")
  const input = { directory: source.path, sessionID: "ses_standalone", root: path.join(storage.path, "absent") }
  expect(await MirrorSession.inspect(input)).toEqual({ status: "available" })
  expect(await fs.readdir(storage.path)).toEqual([])
  const mirror = await MirrorSession.start({ ...input, untracked: ["selected.txt"] })
  expect(mirror.status).toBe("active")
  if (mirror.status !== "active") throw new Error("Mirror did not start")
  expect(await fs.readFile(path.join(mirror.directory, "tracked.txt"), "utf8")).toBe("dirty source")
  expect(await fs.readFile(path.join(mirror.directory, "selected.txt"), "utf8")).toBe("selected")
  expect(await fs.access(path.join(mirror.directory, "private.txt")).then(() => true, () => false)).toBe(false)
  // The raw dirty basis bytes are captured in a content-addressed snapshot so
  // a later three-way close can merge without re-reading historical Git state.
  const mirrorRoot = path.join(storage.path, "absent")
  const slots = await reservations(mirrorRoot)
  const slot = path.join(mirrorRoot, slots[0]!)
  const lease = JSON.parse(await fs.readFile(path.join(slot, "lease.json"), "utf8"))
  expect(typeof lease.basisSnapshotDigest).toBe("string")
  const blob = await fs.readFile(path.join(slot, "basis-blobs", createHash("sha256").update("dirty source").digest("hex")))
  expect(blob.toString("utf8")).toBe("dirty source")
  expect(await git(mirror.directory, ["remote"])).toBe("")
  await fs.writeFile(path.join(mirror.directory, "tracked.txt"), "mirror task")
  expect(await fs.readFile(path.join(source.path, "tracked.txt"), "utf8")).toBe("dirty source")
  expect(await MirrorSession.start(input)).toEqual(mirror)
  expect(await MirrorSession.inspect(input)).toEqual(mirror)
  const other = await MirrorSession.start({ ...input, sessionID: "ses_other" })
  expect(other.status).toBe("active")
  if (other.status !== "active") throw new Error("Other Mirror did not start")
  expect(other.directory).not.toBe(mirror.directory)
})

test("missing lease, corrupt basis, or a foreign owner never allocates a replacement", async () => {
  await using source = await tmpdir({ git: true })
  await using storage = await tmpdir()
  const input = { directory: source.path, sessionID: "ses_owner", root: storage.path }
  const mirror = await MirrorSession.start(input)
  if (mirror.status !== "active") throw new Error("Mirror did not start")
  const slots = await reservations(storage.path)
  const manifest = path.join(mirror.directory, ".git", "opencode-mirror.json")
  const original = await fs.readFile(manifest)
  await fs.writeFile(manifest, "{}")
  await expect(MirrorSession.start(input)).rejects.toThrow("basis or owner changed")
  await fs.writeFile(manifest, original)
  const owner = path.join(path.dirname(mirror.directory), "owner.json")
  await fs.writeFile(owner, JSON.stringify({ id: mirror.basisID, sourceSessionID: "ses_foreign" }))
  await expect(MirrorSession.inspect(input)).rejects.toThrow("basis or owner changed")
  await fs.unlink(path.join(storage.path, slots[0], "lease.json"))
  await expect(MirrorSession.start(input)).rejects.toThrow("reservation is incomplete")
  await expect(MirrorSession.inspect(input)).rejects.toThrow("reservation is incomplete")
  expect(await reservations(storage.path)).toEqual(slots)
})

test("identical files share one immutable basis blob without leaving an incomplete reservation", async () => {
  await using source = await tmpdir({ git: true })
  await using storage = await tmpdir()
  await fs.writeFile(path.join(source.path, "first.txt"), "same bytes")
  await fs.writeFile(path.join(source.path, "second.txt"), "same bytes")
  await git(source.path, ["add", "first.txt", "second.txt"])
  const input = { directory: source.path, sessionID: "ses_duplicates", root: storage.path }
  const mirror = await MirrorSession.start(input)
  expect(await MirrorSession.inspect(input)).toEqual(mirror)
  const located = await MirrorSession.locate(input)
  expect(located.basis.files.filter((file) => file.path.endsWith(".txt"))).toHaveLength(2)
  expect(await MirrorSession.readBasisBlob(located.slot, located.basis.files.find((file) => file.path === "second.txt")!))
    .toEqual(new Uint8Array(Buffer.from("same bytes")))
})

test("unsupported source preflight leaves no poisoned standalone reservation", async () => {
  await using source = await tmpdir({ git: true })
  await using storage = await tmpdir()
  const commit = (await git(source.path, ["rev-parse", "HEAD"])).trim()
  await git(source.path, ["update-index", "--add", "--cacheinfo", `160000,${commit},vendor/module`])
  await expect(MirrorSession.start({ directory: source.path, root: storage.path, sessionID: "ses_preflight" }))
    .rejects.toThrow("symlinks or submodules")
  expect(await fs.readdir(storage.path)).toEqual([])
})

test("preparation failure stays primary when its failure receipt cannot be recorded", async () => {
  await using source = await tmpdir({ git: true })
  await using storage = await tmpdir()
  const original = new Error("fixture lease publication failed")
  const write = fs.writeFile.bind(fs)
  // Windows permission changes do not provide a portable write-failure fixture.
  // Fail only the two publication writes; Git, cloning and snapshot I/O stay real.
  const fault = spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
    if (path.basename(String(file)) === "lease.json") throw original
    if (path.basename(String(file)) === "failed.json") throw new Error("fixture receipt denied")
    return write(file, data, options)
  })
  try {
    const failure = await MirrorSession.start({ directory: source.path, root: storage.path, sessionID: "ses_write_failure" })
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).cause).toBe(original)
    expect((failure as Error).message).toContain("fixture lease publication failed")
    expect((failure as Error).message).toContain("receipt could not be recorded: fixture receipt denied")
    expect(await reservations(storage.path)).toHaveLength(1)
  } finally {
    fault.mockRestore()
  }
})

test("recovery refuses absent, previously claimed and retained destinations with readable errors", async () => {
  await using source = await tmpdir({ git: true })
  await using storage = await tmpdir()
  const input = { directory: source.path, root: storage.path, sessionID: "ses_recovery_refusals" }
  await expect(MirrorSession.recover(input)).rejects.toThrow("No failed Mirror reservation")
  await MirrorSession.start(input)
  const located = await MirrorSession.locate(input)
  await fs.unlink(path.join(located.slot, "lease.json"))
  await fs.writeFile(path.join(located.slot, "failed.json"), JSON.stringify({ version: 1, source: source.path,
    sessionID: input.sessionID, generation: "22222222-2222-4222-8222-222222222222", error: "drained failure" }))
  const plan = await MirrorSession.recover(input)
  await fs.writeFile(path.join(located.slot, "recovery.json"), "existing claim")
  await expect(MirrorSession.recover({ ...input, planDigest: plan.planDigest })).rejects.toThrow("already claimed")
  expect(await fs.readFile(path.join(located.slot, "recovery.json"), "utf8")).toBe("existing claim")
  await fs.unlink(path.join(located.slot, "recovery.json"))
  await fs.mkdir(plan.retained)
  await fs.writeFile(path.join(plan.retained, "work.txt"), "retained work")
  await expect(MirrorSession.recover({ ...input, planDigest: plan.planDigest })).rejects.toThrow("retention destination exists")
  expect(await fs.readFile(path.join(plan.retained, "work.txt"), "utf8")).toBe("retained work")
  expect(await fs.readdir(located.slot)).not.toContain("recovery.json")
})

test("failed-preparation recovery retains exactly one reviewed generation and never repairs unknown owners", async () => {
  await using source = await tmpdir({ git: true })
  await using storage = await tmpdir()
  const input = { directory: source.path, root: storage.path, sessionID: "ses_retained" }
  const mirror = await MirrorSession.start(input)
  const located = await MirrorSession.locate(input)
  await expect(MirrorSession.recover(input)).rejects.toThrow("leased Mirror")
  await fs.unlink(path.join(located.slot, "lease.json"))
  await expect(MirrorSession.recover(input)).rejects.toThrow("Unknown preparation owner")
  const failure = { version: 1, source: source.path, sessionID: input.sessionID,
    generation: "11111111-1111-4111-8111-111111111111", error: "synthetic drained preparation" }
  await fs.writeFile(path.join(located.slot, "failed.json"), JSON.stringify({ ...failure, sessionID: "ses_foreign" }))
  await expect(MirrorSession.recover(input)).rejects.toThrow("does not match")
  await fs.writeFile(path.join(located.slot, "failed.json"), JSON.stringify(failure))
  const plan = await MirrorSession.recover(input)
  if (plan.status !== "recovery-ready") throw new Error("Expected read-only recovery plan")
  expect(await fs.access(plan.retained).then(() => true, () => false)).toBe(false)
  await expect(MirrorSession.recover({ ...input, planDigest: "stale" })).rejects.toThrow("plan changed")
  expect(await fs.readdir(located.slot)).not.toContain("recovery.json")
  const results = await Promise.allSettled([
    MirrorSession.recover({ ...input, planDigest: plan.planDigest }),
    MirrorSession.recover({ ...input, planDigest: plan.planDigest }),
  ])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(await MirrorSession.inspect(input)).toEqual({ status: "available" })
  const retainedWorkspace = path.join(plan.retained, "reservation", path.relative(located.slot, mirror.directory))
  expect(await fs.readFile(path.join(retainedWorkspace, ".git", "opencode-mirror.json")))
    .toEqual(located.manifest)
  const fresh = await MirrorSession.start(input)
  expect(fresh.directory).not.toBe(mirror.directory)
  await expect(MirrorSession.recover({ ...input, planDigest: plan.planDigest })).rejects.toThrow("leased Mirror")
})

test("legacy empty recovery needs an exact plan and quiescent host, then permits a fresh Mirror", async () => {
  await using source = await tmpdir({ git: true })
  await using storage = await tmpdir()
  const input = { directory: source.path, root: storage.path, sessionID: "ses_legacy_empty" }
  const identity = process.platform === "win32" ? source.path.toLowerCase() : source.path
  const key = createHash("sha256").update(`${identity}\0${input.sessionID}`).digest("hex")
  const slot = path.join(storage.path, key)
  await fs.mkdir(slot)
  const plan = await MirrorSession.recoverLegacyEmpty(input)
  expect(plan.status).toBe("legacy-empty-ready")
  expect(await fs.readdir(slot)).toEqual([])
  await expect(MirrorSession.recoverLegacyEmpty({ ...input, planDigest: "wrong", assertQuiescent: async () => {} }))
    .rejects.toThrow("plan changed")
  await expect(MirrorSession.recoverLegacyEmpty({ ...input, planDigest: plan.planDigest,
    assertQuiescent: async () => { throw new Error("host active") } })).rejects.toThrow("host active")
  expect(await fs.readdir(slot)).toEqual([])
  const results = await Promise.allSettled([
    MirrorSession.recoverLegacyEmpty({ ...input, planDigest: plan.planDigest, assertQuiescent: async () => {} }),
    MirrorSession.recoverLegacyEmpty({ ...input, planDigest: plan.planDigest, assertQuiescent: async () => {} }),
  ])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(await fs.readdir(path.join(plan.retained, "reservation"))).toEqual([])
  expect(await MirrorSession.inspect(input)).toEqual({ status: "available" })
  expect((await MirrorSession.start(input)).status).toBe("active")
})

test("legacy recovery refuses a nonempty or leased reservation", async () => {
  await using source = await tmpdir({ git: true })
  await using storage = await tmpdir()
  const input = { directory: source.path, root: storage.path, sessionID: "ses_legacy_nonempty" }
  const mirror = await MirrorSession.start(input)
  await expect(MirrorSession.recoverLegacyEmpty(input)).rejects.toThrow("not empty")
  expect((await MirrorSession.inspect(input)).status).toBe("active")
  expect(await fs.readFile(path.join(mirror.directory, ".git", "opencode-mirror.json"))).toBeTruthy()
})

test("default storage is absolute and independent of CWD, including an empty XDG override", () => {
  const home = path.resolve("fixture-home")
  const data = path.resolve("fixture-data")
  expect(MirrorSession.defaultRoot(undefined, home)).toBe(path.join(home, ".local", "share", "opencode", "standalone-mirrors"))
  expect(MirrorSession.defaultRoot("", home)).toBe(MirrorSession.defaultRoot(undefined, home))
  expect(MirrorSession.defaultRoot(data, home)).toBe(path.join(data, "opencode", "standalone-mirrors"))
  expect(path.isAbsolute(MirrorSession.defaultRoot("", home))).toBe(true)
  expect(() => MirrorSession.defaultRoot("relative-data", home)).toThrow("absolute")
})

test("linked reservations, replaced workspaces and escaping lease paths never allocate replacements", async () => {
  await using source = await tmpdir({ git: true })
  await using storage = await tmpdir()
  await using saved = await tmpdir()
  const input = { directory: source.path, root: storage.path, sessionID: "ses_identity" }
  const mirror = await MirrorSession.start(input)
  if (mirror.status !== "active") throw new Error("Mirror did not start")
  const slots = await reservations(storage.path)
  const slot = path.join(storage.path, slots[0])
  const retained = path.join(saved.path, "reservation")
  await fs.rename(slot, retained)
  await fs.symlink(retained, slot, process.platform === "win32" ? "junction" : "dir")
  await expect(MirrorSession.inspect(input)).rejects.toThrow("not a private directory")
  await expect(MirrorSession.start(input)).rejects.toThrow("not a private directory")
  await fs.unlink(slot)
  await fs.rename(retained, slot)
  const oldWorkspace = path.join(path.dirname(mirror.directory), "retained-workspace")
  await fs.rename(mirror.directory, oldWorkspace)
  await fs.symlink(oldWorkspace, mirror.directory, process.platform === "win32" ? "junction" : "dir")
  await expect(MirrorSession.inspect(input)).rejects.toThrow("workspace identity changed")
  await expect(MirrorSession.start(input)).rejects.toThrow("workspace identity changed")
  await fs.unlink(mirror.directory)
  await fs.rename(oldWorkspace, mirror.directory)
  const leaseFile = path.join(slot, "lease.json")
  const lease = JSON.parse(await fs.readFile(leaseFile, "utf8"))
  await fs.writeFile(leaseFile, JSON.stringify({ ...lease, directory: source.path }))
  await expect(MirrorSession.start(input)).rejects.toThrow("workspace identity changed")
  expect(await reservations(storage.path)).toEqual(slots)
})

test("invalid Session IDs and in-source storage fail before allocating files", async () => {
  await using source = await tmpdir({ git: true })
  await using storage = await tmpdir()
  for (const sessionID of ["", "-Action", "../other", "bad id", "x".repeat(129)]) {
    await expect(MirrorSession.start({ directory: source.path, root: storage.path, sessionID })).rejects.toThrow("Session ID")
  }
  await expect(MirrorSession.start({ directory: source.path, root: path.join(source.path, "mirrors"), sessionID: "ses_valid" }))
    .rejects.toThrow("outside the source")
  expect(await fs.readdir(storage.path)).toEqual([])
  expect(await fs.access(path.join(source.path, "mirrors")).then(() => true, () => false)).toBe(false)
})

test("concurrent starts reserve one workspace and never silently recover an incomplete reservation", async () => {
  await using source = await tmpdir({ git: true })
  await using storage = await tmpdir()
  const input = { directory: source.path, root: storage.path, sessionID: "ses_concurrent" }
  const results = await Promise.allSettled([MirrorSession.start(input), MirrorSession.start(input)])
  expect(results.some((result) => result.status === "fulfilled")).toBe(true)
  expect(await reservations(storage.path)).toHaveLength(1)
  const current = await MirrorSession.inspect(input)
  if (current.status !== "active") throw new Error("Mirror did not start")
  expect(await MirrorSession.start(input)).toEqual(current)
})

test("the actual CLI starts and reuses a Mirror from a different working directory", async () => {
  await using source = await tmpdir({ git: true })
  await using storage = await tmpdir()
  const root = path.join(storage.path, "cli-storage")
  const run = async (action: string) => {
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../../script/mirror.ts"),
      "--action", action, "--directory", source.path, "--session", "ses_cli", "--root", root],
    { cwd: storage.path, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    return JSON.parse(stdout)
  }
  expect(await run("status")).toEqual({ status: "available" })
  expect(await fs.readdir(storage.path)).toEqual([])
  const mirror = await run("start")
  expect(mirror).toMatchObject({ status: "active", sessionID: "ses_cli", source: source.path })
  expect(await run("start")).toEqual(mirror)
  expect(await run("status")).toEqual(mirror)
})
