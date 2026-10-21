import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, utimes } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AppProcess } from "../src/process"
import { EffectFlock } from "../src/util/effect-flock"
import { FSUtil } from "../src/fs-util"
import { Git } from "../src/git"
import { Global } from "../src/global"
import { Hash } from "../src/util/hash"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { Snapshot } from "../src/snapshot"
import { SnapshotActivity } from "../src/snapshot-activity"

const run = async (command: string[], cwd: string) => {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

const makeSnapshot = (root: string, globalData: string, globalState: string) => {
  const global = Global.layerWith({
    data: globalData,
    state: globalState,
    cache: path.join(globalData, "cache"),
    config: path.join(globalData, "config"),
    tmp: path.join(globalData, "tmp"),
    bin: path.join(globalData, "bin"),
    log: path.join(globalData, "log"),
    repos: path.join(globalData, "repos"),
    home: root,
  })
  const flock = EffectFlock.layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(global))
  return Snapshot.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(AppProcess.defaultLayer),
    Layer.provide(global),
    Layer.provide(flock),
  )
}

let repoForTest = ""

const track = (layer: Layer.Layer<Snapshot.Service>) =>
  Effect.gen(function* () {
    const service = yield* Snapshot.Service
    return yield* service.track(Location.Ref.make({ directory: AbsolutePath.make(repoForTest) }))
  }).pipe(Effect.provide(layer), Effect.runPromise)

const setup = async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-snapshot-test-"))
  const repo = path.join(root, "repo")
  const globalData = path.join(root, "global-data")
  const globalState = path.join(root, "global-state")
  await run(["git", "init", repo], root)
  await Bun.write(path.join(repo, "tracked.txt"), "tracked\n")
  await run(["git", "add", "tracked.txt"], repo)
  await run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], repo)
  repoForTest = repo
  return { root, repo, globalData, globalState, gitdir: path.join(globalData, "snapshot", Hash.fast(repo)) }
}

describe("Snapshot.Service index lock recovery", () => {
  test("completes a partial snapshot repository", async () => {
    const fixture = await setup()
    try {
      await mkdir(path.join(fixture.gitdir, "hooks"), { recursive: true })
      await Bun.write(path.join(fixture.gitdir, "description"), "Unnamed repository\n")

      const tree = await track(makeSnapshot(fixture.root, fixture.globalData, fixture.globalState))

      expect(tree).toMatch(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
      const validation = Bun.spawnSync(["git", "--git-dir", fixture.gitdir, "cat-file", "-e", `${tree}^{tree}`], {
        cwd: fixture.repo,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(validation.exitCode, validation.stderr.toString()).toBe(0)
      const activity = await SnapshotActivity.read(fixture.gitdir)
      expect(activity).toMatchObject({ version: 1, lastUsedAt: expect.any(Number) })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  test("removes a stale index lock and tracks successfully", async () => {
    const fixture = await setup()
    try {
      const layer = makeSnapshot(fixture.root, fixture.globalData, fixture.globalState)
      expect(await track(layer)).toBeString()
      const lock = path.join(fixture.gitdir, "index.lock")
      await Bun.write(lock, "stale lock")
      const stale = new Date(Date.now() - 61_000)
      await utimes(lock, stale, stale)
      expect(await track(layer)).toBeString()
      expect(await Bun.file(lock).exists()).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  test("preserves a fresh index lock and fails open", async () => {
    const fixture = await setup()
    try {
      const layer = makeSnapshot(fixture.root, fixture.globalData, fixture.globalState)
      expect(await track(layer)).toBeString()
      const lock = path.join(fixture.gitdir, "index.lock")
      await Bun.write(lock, "fresh lock")
      expect(await track(layer)).toBeUndefined()
      expect(await Bun.file(lock).exists()).toBe(true)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
