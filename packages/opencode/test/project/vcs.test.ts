import { afterEach, describe, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { parsePatch } from "diff"
import { Deferred, Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import fs from "fs/promises"
import path from "path"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Git } from "../../src/git"
import { Provider } from "../../src/provider/provider"
import { Vcs } from "@/project/vcs"
import { testEffect } from "../lib/effect"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const weird = process.platform === "win32" ? "space file.txt" : "tab\tfile.txt"

const layer = Layer.mergeAll(
  Vcs.layer.pipe(
    Layer.provideMerge(Git.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
    Layer.provideMerge(Provider.defaultLayer),
  ),
  CrossSpawnSpawner.defaultLayer,
  FSUtil.defaultLayer,
)
const GIT_TEST_TIMEOUT = 20_000
const it = testEffect(layer)
const worktreeIt = testEffect(Layer.mergeAll(layer, testInstanceStoreLayer))

const git = Effect.fn("VcsTest.git")(function* (cwd: string, args: string[]) {
  const result = yield* Git.Service.use((git) => git.run(args, { cwd }))
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
})

const gitText = Effect.fn("VcsTest.gitText")(function* (cwd: string, args: string[]) {
  const result = yield* Git.Service.use((git) => git.run(args, { cwd }))
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
  return result.text().trim()
})

const write = Effect.fn("VcsTest.write")(function* (file: string, content: string) {
  yield* FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))
})

const appendGitignoreInProcesses = (cwd: string, patterns: string[]) =>
  Effect.promise(() =>
    Promise.all(
      patterns.map(async (pattern) => {
        const child = Bun.spawn(
          [process.execPath, path.join(import.meta.dir, "../fixture/gitignore-worker.ts"), cwd, pattern],
          { stdout: "pipe", stderr: "pipe" },
        )
        const exitCode = await child.exited
        if (exitCode === 0) return
        throw new Error(`gitignore worker failed (${exitCode}): ${await new Response(child.stderr).text()}`)
      }),
    ),
  )

const appendGitignoreWithLockState = (cwd: string, pattern: string, state: string) =>
  Effect.promise(async () => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../fixture/gitignore-worker.ts"), cwd, pattern], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENCODE_TEST_FLOCK_STATE: state,
        OPENCODE_TEST_GITIGNORE_RESULT: "1",
      },
    })
    const exitCode = await child.exited
    const stderr = await new Response(child.stderr).text()
    if (exitCode !== 0) throw new Error(`gitignore worker failed (${exitCode}): ${stderr}`)
    return JSON.parse(await new Response(child.stdout).text()) as Vcs.GitActionResult
  })

const remove = Effect.fn("VcsTest.remove")(function* (file: string) {
  yield* FSUtil.Service.use((fs) => fs.remove(file))
})

const symlink = (target: string, file: string) => Effect.promise(() => fs.symlink(target, file))

const init = Effect.fn("VcsTest.init")(function* () {
  const vcs = yield* Vcs.Service
  yield* vcs.init()
  return vcs
})

const nextBranchUpdate = Effect.fn("VcsTest.nextBranchUpdate")(function* () {
  const events = yield* EventV2Bridge.Service
  const updated = yield* Deferred.make<string | undefined>()

  const off = yield* events.listen((event) => {
    if (event.type === Vcs.Event.BranchUpdated.type)
      Deferred.doneUnsafe(updated, Effect.succeed((event.data as typeof Vcs.Event.BranchUpdated.data.Type).branch))
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  return updated
})

const publishHeadChangeUntil = Effect.fn("VcsTest.publishHeadChangeUntil")(function* (
  pending: Deferred.Deferred<string | undefined>,
  head: string,
) {
  const events = yield* EventV2Bridge.Service
  for (let i = 0; i < 50; i++) {
    yield* events.publish(Watcher.Event.Updated, { file: head, event: "change" })
    if (yield* Deferred.isDone(pending)) return
    yield* Effect.sleep("10 millis")
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Vcs", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "branch() returns current branch name",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const branch = yield* vcs.branch()

        expect(branch).toBeDefined()
        expect(typeof branch).toBe("string")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance("branch() returns undefined for non-git directories", () =>
    Effect.gen(function* () {
      const vcs = yield* init()
      const branch = yield* vcs.branch()

      expect(branch).toBeUndefined()
    }),
  )

  it.instance(
    "publishes BranchUpdated when .git/HEAD changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)

        const updated = yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))
        expect(updated).toBe(branch)
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "branch() reflects the new branch after HEAD change",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)
        yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))

        const current = yield* vcs.branch()
        expect(current).toBe(branch)
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )
})

describe("Vcs diff", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "defaultBranch() falls back to main",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("main")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "defaultBranch() uses init.defaultBranch when available",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "trunk"])
        yield* git(test.directory, ["config", "init.defaultBranch", "trunk"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("trunk")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  worktreeIt.live(
    "detects current branch from the active worktree",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped({ git: true })
        const wt = yield* tmpdirScoped()
        yield* git(tmp, ["branch", "-M", "main"])
        const dir = path.join(wt, "feature")
        yield* git(tmp, ["worktree", "add", "-b", "feature/test", dir, "HEAD"])

        const [branch, base] = yield* Effect.gen(function* () {
          const vcs = yield* init()
          return yield* Effect.all([vcs.branch(), vcs.defaultBranch()], { concurrency: 2 })
        }).pipe(provideInstance(dir))

        expect(branch).toBeDefined()
        expect(branch).toBe("feature/test")
        expect(base).toBe("main")
      }),
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "diff('git') returns uncommitted changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "original\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "changed\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "file.txt",
              status: "modified",
            }),
          ]),
        )
        expect(diff.find((item) => item.file === "file.txt")?.patch).toContain("diff --git")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "diff('git') handles special filenames",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, weird), "hello\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: weird,
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "diff('git') keeps batched patches aligned for type changes",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const test = yield* TestInstance
        yield* write(path.join(test.directory, "a.txt"), "old\n")
        yield* write(path.join(test.directory, "b.txt"), "old\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add files"])
        yield* remove(path.join(test.directory, "a.txt"))
        yield* symlink("target", path.join(test.directory, "a.txt"))
        yield* write(path.join(test.directory, "b.txt"), "new\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const a = diff.find((item) => item.file === "a.txt")
        const b = diff.find((item) => item.file === "b.txt")

        expect(a?.patch).toContain("deleted file mode")
        expect(a?.patch).toContain("new file mode")
        expect(b?.patch).toContain("+new")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "diff('git') keeps carriage returns inside patch hunks",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "keep\nsame\rdiff --git inside\ndelete\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "keep\nadd\nsame\rdiff --git inside\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const file = diff.find((item) => item.file === "file.txt")

        expect(file?.patch).toContain(" same\rdiff --git inside")
        expect(file?.patch).toContain("-delete")
        expect(() => parsePatch(file?.patch ?? "")).not.toThrow()
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "diff('branch') returns changes against default branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["checkout", "-b", "feature/test"])
        yield* write(path.join(test.directory, "branch.txt"), "hello\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "branch file"])

        const vcs = yield* init()
        const diff = yield* vcs.diff("branch")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "branch.txt",
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )
})

describe("Vcs git actions", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  worktreeIt.live(
    "discovers nested repositories from a non-git directory with bounded depth and pruning",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const direct = path.join(root, "direct-repo")
        const nestedRepo = path.join(direct, "packages", "nested-repo")
        const deep = path.join(root, "group", "nested", "deep-repo")
        const worktree = path.join(root, "worktree-repo")
        const ignored = path.join(root, "node_modules", "ignored-repo")
        const tooDeep = path.join(root, "one", "two", "three", "too-deep-repo")
        yield* Effect.promise(() =>
          Promise.all(
            [direct, nestedRepo, deep, worktree, ignored, tooDeep].map((directory) =>
              fs.mkdir(directory, { recursive: true }),
            ),
          ),
        )
        yield* Effect.all([
          git(direct, ["init"]),
          git(nestedRepo, ["init"]),
          git(deep, ["init"]),
          git(ignored, ["init"]),
          git(tooDeep, ["init"]),
        ])
        yield* write(path.join(worktree, ".git"), "gitdir: ../shared.git/worktrees/worktree-repo\n")

        const [result, clamped] = yield* Effect.gen(function* () {
          const vcs = yield* init()
          return yield* Effect.all([
            vcs.discoverRepositories({ maxDepth: 3 }),
            vcs.discoverRepositories({ maxDepth: 10 }),
          ])
        }).pipe(provideInstance(root))

        expect(result.truncated).toBe(false)
        expect(result.repositories.map((repository) => repository.worktree)).toEqual(
          expect.arrayContaining([direct, nestedRepo, deep, worktree]),
        )
        expect(result.repositories.map((repository) => repository.worktree)).not.toContain(ignored)
        expect(result.repositories.map((repository) => repository.worktree)).not.toContain(tooDeep)
        expect(clamped.repositories.map((repository) => repository.worktree)).not.toContain(tooDeep)
      }),
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "gitSnapshot omits worktree outside git",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const snapshot = yield* vcs.gitSnapshot({ limit: 10 })

        expect(snapshot.info.worktree).toBeUndefined()
      }),
    undefined,
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "gitSnapshot parses branch metadata from for-each-ref",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["checkout", "-b", "feature/workbench"])

        const vcs = yield* init()
        const snapshot = yield* vcs.gitSnapshot({ limit: 10 })

        expect(snapshot.info.worktree).toBe(test.directory)
        expect(snapshot.branches).toContainEqual(
          expect.objectContaining({
            name: "feature/workbench",
            current: true,
            remote: false,
          }),
        )
        expect(snapshot.branches.map((branch) => branch.name).join("\n")).not.toContain("%x1f")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "pull and sync explain unrelated histories without changing either branch tip",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const remote = yield* tmpdirScoped({ git: true })
        yield* git(remote, ["branch", "-M", "main"])
        // Ensure the upstream root differs even if both fixtures were created in the same second.
        yield* git(remote, ["commit", "--amend", "--allow-empty", "--no-gpg-sign", "-m", "upstream root"])
        yield* git(test.directory, ["branch", "-M", "local"])
        yield* git(test.directory, ["remote", "add", "origin", remote])
        yield* git(test.directory, ["config", "branch.local.remote", "origin"])
        yield* git(test.directory, ["config", "branch.local.merge", "refs/heads/main"])
        yield* git(test.directory, ["config", "pull.rebase", "false"])
        yield* git(test.directory, ["config", "pull.ff", "true"])
        const localTip = yield* gitText(test.directory, ["rev-parse", "HEAD"])
        const remoteTip = yield* gitText(remote, ["rev-parse", "HEAD"])

        const vcs = yield* init()
        for (const input of [{ action: "pull" }, { action: "sync", remote: "origin", branch: "main" }] as const) {
          const result = yield* vcs.gitAction(input)
          expect(result.ok).toBe(false)
          expect(result.message).toMatch(/no common commit.*check out a branch/i)
          expect(result.output).toBeUndefined()
        }
        yield* git(test.directory, ["config", "pull.ff", "only"])
        const fastForwardOnly = yield* vcs.gitAction({ action: "pull" })
        expect(fastForwardOnly.ok).toBe(false)
        expect(fastForwardOnly.message).toMatch(/cannot be fast-forwarded/i)
        expect(yield* gitText(test.directory, ["rev-parse", "HEAD"])).toBe(localTip)
        expect(yield* gitText(remote, ["rev-parse", "HEAD"])).toBe(remoteTip)
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).toBe("")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "pull guides users through missing upstream tracking and withholds raw remote errors",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const vcs = yield* init()
        const untracked = yield* vcs.gitAction({ action: "pull" })
        expect(untracked.ok).toBe(false)
        expect(untracked.message).toMatch(/no upstream branch/i)

        const missing = path.join(test.directory, "missing-private-remote-fixture")
        const result = yield* vcs.gitAction({ action: "pull", remote: missing, branch: "main" })
        expect(result.ok).toBe(false)
        expect(result.message).toMatch(/pull failed.*check/i)
        expect(result.output).toBeUndefined()
        expect(JSON.stringify(result)).not.toContain("missing-private-remote-fixture")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "commitAuto commits with a local fallback when the configured model is unavailable",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "cards", "fire.ts"), "export const fire = { damage: 5 }\n")
        yield* write(path.join(test.directory, "cards", "ice.ts"), "export const ice = { slow: 2 }\n")
        yield* write(path.join(test.directory, "cards", "storm.ts"), "export const storm = { chain: 3 }\n")

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "commitAuto" })

        expect(result.ok).toBe(true)
        expect(result.message).toMatch(/model cursor\/composer is not available/i)
        expect(result.message).toMatch(/local fallback/i)
        // the commit still happened with the local fallback message
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).toBe("")
        expect(yield* gitText(test.directory, ["log", "-1", "--format=%s"])).toBe(result.commit ?? "")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "discard removes selected untracked files",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "[ab].txt"), "selected\n")
        yield* write(path.join(test.directory, "a.txt"), "preserved\n")

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "discard", files: ["[ab].txt"] })

        expect(result.ok).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, "[ab].txt")).exists())).toBe(false)
        expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, "a.txt"), "utf8"))).toBe("preserved\n")
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).toBe("?? a.txt")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "discard fully restores only the selected tracked file",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "[ab].txt"), "original selected\n")
        yield* write(path.join(test.directory, "a.txt"), "original preserved\n")
        yield* git(test.directory, ["add", "[ab].txt", "a.txt"])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "track discard fixtures"])
        yield* write(path.join(test.directory, "[ab].txt"), "staged selected\n")
        yield* write(path.join(test.directory, "a.txt"), "staged preserved\n")
        yield* git(test.directory, ["add", "[ab].txt", "a.txt"])
        yield* write(path.join(test.directory, "[ab].txt"), "unstaged selected\n")

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "discard", files: ["[ab].txt"] })

        expect(result.ok).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, "[ab].txt"), "utf8"))).toBe(
          "original selected\n",
        )
        expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, "a.txt"), "utf8"))).toBe(
          "staged preserved\n",
        )
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).toBe("M  a.txt")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "discard removes only the selected staged addition before the first commit",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, ".gitignore"), "selected.txt\n")
        yield* write(path.join(test.directory, "selected.txt"), "selected\n")
        yield* write(path.join(test.directory, "preserved.txt"), "preserved\n")
        yield* git(test.directory, ["add", ".gitignore", "preserved.txt"])
        yield* git(test.directory, ["add", "-f", "selected.txt"])

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "discard", files: ["selected.txt"] })

        expect(result.ok).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, "selected.txt")).exists())).toBe(false)
        expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, "preserved.txt"), "utf8"))).toBe(
          "preserved\n",
        )
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).toBe(
          "A  .gitignore\nA  preserved.txt",
        )
      }),
    { init: (directory) => git(directory, ["init"]) },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "discard restores an add-add conflict to the current branch version",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["checkout", "-b", "other"])
        yield* write(path.join(test.directory, "conflict.txt"), "other\n")
        yield* git(test.directory, ["add", "conflict.txt"])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add other version"])
        yield* git(test.directory, ["checkout", "main"])
        yield* write(path.join(test.directory, "conflict.txt"), "main\n")
        yield* git(test.directory, ["add", "conflict.txt"])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add main version"])
        const merge = yield* Git.Service.use((git) => git.run(["merge", "other"], { cwd: test.directory }))
        expect(merge.exitCode).not.toBe(0)
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).toBe("AA conflict.txt")

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "discard", files: ["conflict.txt"] })

        expect(result.ok).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, "conflict.txt"), "utf8"))).toBe(
          "main\n",
        )
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).toBe("")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "ignore handles real untracked files and folders without duplicates while preserving CRLF",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, ".gitignore"), "dist/\r\n")
        yield* write(path.join(test.directory, "assets", "splash.png"), "image")
        yield* write(path.join(test.directory, "assets", "generated", "output.txt"), "generated")
        const vcs = yield* init()

        expect((yield* vcs.gitAction({ action: "ignore", pattern: "assets/splash.png" })).ok).toBe(true)
        expect((yield* vcs.gitAction({ action: "ignore", pattern: "assets/generated/" })).ok).toBe(true)
        expect((yield* vcs.gitAction({ action: "ignore", pattern: "*.png" })).ok).toBe(true)
        const once = yield* Effect.promise(() => fs.readFile(path.join(test.directory, ".gitignore"), "utf8"))
        expect(once).toBe("dist/\r\n/assets/splash.png\r\n/assets/generated/\r\n*.png\r\n")
        expect(yield* gitText(test.directory, ["check-ignore", "--no-index", "assets/splash.png"])).toBe(
          "assets/splash.png",
        )
        expect(yield* gitText(test.directory, ["check-ignore", "--no-index", "assets/generated/output.txt"])).toBe(
          "assets/generated/output.txt",
        )

        expect((yield* vcs.gitAction({ action: "ignore", pattern: "*.png" })).ok).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, ".gitignore"), "utf8"))).toBe(once)
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "ignore creates .gitignore and rejects traversal, absolute paths, and unsafe patterns",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const vcs = yield* init()

        expect((yield* vcs.gitAction({ action: "ignore", pattern: "notes.txt" })).ok).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, ".gitignore"), "utf8"))).toBe(
          "/notes.txt\n",
        )

        for (const pattern of [
          "../outside.txt",
          "folder/../../outside.txt",
          "/absolute.txt",
          "C:\\absolute.txt",
          "*.tar.gz",
        ]) {
          const result = yield* vcs.gitAction({ action: "ignore", pattern })
          expect(result.ok).toBe(false)
        }
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "ignore escapes special characters and serializes cross-process appends without lost updates",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const vcs = yield* init()
        yield* write(path.join(test.directory, "folder", "[draft] #!.txt"), "draft")

        expect((yield* vcs.gitAction({ action: "ignore", pattern: "folder/[draft] #!.txt" })).ok).toBe(true)
        expect(yield* gitText(test.directory, ["check-ignore", "--no-index", "folder/[draft] #!.txt"])).toBe(
          "folder/[draft] #!.txt",
        )

        const patterns = ["/folder/a.txt", "/folder/b.txt", "/folder/c.txt", "/folder/d.txt"]
        yield* appendGitignoreInProcesses(test.directory, patterns)
        const lines = (yield* Effect.promise(() => fs.readFile(path.join(test.directory, ".gitignore"), "utf8")))
          .trim()
          .split(/\r?\n/)
        expect(lines).toEqual(expect.arrayContaining(["/folder/\\[draft\\]\\ \\#\\!.txt", ...patterns]))
        expect(lines).toHaveLength(5)
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "ignore clearly keeps an already tracked file tracked",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "tracked.txt"), "tracked\n")
        yield* git(test.directory, ["add", "tracked.txt"])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "track fixture"])
        const vcs = yield* init()

        const result = yield* vcs.gitAction({ action: "ignore", pattern: "tracked.txt" })

        expect(result.ok).toBe(true)
        expect(result.message).toContain("only affects untracked files")
        expect(result.message).toContain("already tracked by Git stay tracked")
        expect(yield* gitText(test.directory, ["ls-files", "--error-unmatch", "tracked.txt"])).toBe("tracked.txt")
        expect(yield* gitText(test.directory, ["check-ignore", "--no-index", "tracked.txt"])).toBe("tracked.txt")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "ignore refuses a .gitignore symlink or reparse point without changing its outside target",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const outside = yield* tmpdirScoped()
        const target = path.join(outside, "outside.gitignore")
        yield* write(target, "outside\n")
        const linked = yield* Effect.promise(() =>
          fs
            .symlink(target, path.join(test.directory, ".gitignore"), process.platform === "win32" ? "file" : undefined)
            .then(() => true)
            .catch((error: unknown) => {
              if (
                error &&
                typeof error === "object" &&
                "code" in error &&
                (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP")
              )
                return false
              throw error
            }),
        )
        if (!linked) return

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "ignore", pattern: "private.txt" })

        expect(result.ok).toBe(false)
        expect(result.message).toMatch(/symbolic link|reparse point/i)
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("outside\n")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "ignore reports real read, write, and lock failures without defecting",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const vcs = yield* init()
        const file = path.join(test.directory, ".gitignore")

        yield* Effect.promise(() => fs.mkdir(file))
        const read = yield* vcs.gitAction({ action: "ignore", pattern: "read.txt" })
        expect(read.ok).toBe(false)
        expect(read.message).toMatch(/not a regular file/i)
        yield* Effect.promise(() => fs.rm(file, { recursive: true }))

        yield* write(file, "existing\n")
        const writeResult =
          process.platform !== "win32" && process.getuid?.() === 0
            ? undefined
            : yield* Effect.acquireUseRelease(
                Effect.promise(() => fs.chmod(file, 0o444)),
                () => vcs.gitAction({ action: "ignore", pattern: "write.txt" }),
                () => Effect.promise(() => fs.chmod(file, 0o666).catch(() => undefined)),
              )
        if (writeResult) {
          expect(writeResult.ok).toBe(false)
          expect(writeResult.message).toMatch(/could not update .gitignore/i)
        }

        const lockState = path.join(test.directory, "blocked-lock-state")
        yield* write(lockState, "not a directory")
        const lock = yield* appendGitignoreWithLockState(test.directory, "/lock.txt", lockState)
        expect(lock.ok).toBe(false)
        expect(lock.message).toMatch(/could not update .gitignore/i)
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )
})

describe("Vcs git history", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  const fastImport = (cwd: string, stream: string) => {
    const result = spawnSync("git", ["fast-import", "--quiet"], { cwd, input: stream })
    if (result.status !== 0) throw new Error(`git fast-import failed: ${result.stderr.toString()}`)
  }

  const gitSpawn = (cwd: string, args: string[]) => {
    const result = spawnSync("git", args, { cwd })
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
    return result.stdout.toString().trim()
  }

  const currentBranch = (cwd: string) => gitSpawn(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])

  const commitBlock = (
    mark: number,
    message: string,
    options: { from?: number; merge?: number; branch?: string; fromRef?: string } = {},
  ) => {
    const data = Buffer.from(message, "utf8")
    const fromLine = options.from ? `from :${options.from}` : options.fromRef ? `from ${options.fromRef}` : ""
    return [
      `commit refs/heads/${options.branch ?? ""}`.trimEnd(),
      `mark :${mark}`,
      "committer Test User <test@example.com> 1700000000 +0000",
      `data ${data.length}`,
      message,
      ...(fromLine ? [fromLine] : []),
      ...(options.merge ? [`merge :${options.merge}`] : []),
      "",
    ].join("\n")
  }

  const resetBlock = (branch: string, mark: number) => [`reset refs/heads/${branch}`, `from :${mark}`, ""].join("\n")

  const subjects = (page: { commits: ReadonlyArray<{ subject: string }> }) => page.commits.map((commit) => commit.subject)

  it.instance(
    "filters history per branch and exposes canonical refs",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = currentBranch(test.directory)
        const stream = [
          commitBlock(1, "A root", { branch, fromRef: "HEAD" }),
          commitBlock(2, "B base", { from: 1, branch }),
          commitBlock(3, "S side", { from: 2, branch: "side" }),
          commitBlock(4, "M merge", { from: 2, merge: 3, branch }),
          commitBlock(5, "C tip", { from: 4, branch }),
          commitBlock(6, "I island", { branch: "island" }),
          resetBlock("topic/HEAD", 2),
          resetBlock("release", 5),
        ].join("\n")
        fastImport(test.directory, stream)
        gitSpawn(test.directory, ["tag", "release", "HEAD"])

        const vcs = yield* init()
        const rootMatcher = expect.stringMatching(/^root commit/)
        const head = yield* vcs.gitHistory({ selector: "head", limit: 50 })
        expect(subjects(head)).toEqual(["C tip", "M merge", "S side", "B base", "A root", rootMatcher])

        const firstParent = yield* vcs.gitHistory({ selector: "head", firstParent: true, limit: 50 })
        expect(subjects(firstParent)).toEqual(["C tip", "M merge", "B base", "A root", rootMatcher])

        const island = yield* vcs.gitHistory({ selector: "branch", ref: "refs/heads/island", limit: 50 })
        expect(subjects(island)).toEqual(["I island"])

        const all = yield* vcs.gitHistory({ selector: "all", limit: 50 })
        expect(subjects(all)).toContain("I island")
        expect(subjects(all)).toContain("C tip")
        expect(head.headOid).toBeDefined()

        const allFirstParent = yield* Effect.flip(vcs.gitHistory({ selector: "all", firstParent: true, limit: 10 }))
        expect(allFirstParent.code).toBe("invalid_ref")

        const snapshot = yield* vcs.gitSnapshot({ limit: 10 })
        const topicHead = snapshot.branches.find((branch) => branch.name === "topic/HEAD")
        expect(topicHead?.ref).toBe("refs/heads/topic/HEAD")
        const release = snapshot.branches.find((branch) => branch.ref === "refs/heads/release")
        // With the tag "release" present, git disambiguates the display short
        // name; the canonical ref must stay exact.
        expect(release?.name).toBe("heads/release")
        expect(release?.ref).toBe("refs/heads/release")
        expect(snapshot.branches.map((branch) => branch.name)).not.toContain("origin/HEAD")

        gitSpawn(test.directory, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/main"])
        const snapshotWithAlias = yield* vcs.gitSnapshot({ limit: 10 })
        expect(snapshotWithAlias.branches.map((branch) => branch.name)).not.toContain("origin/HEAD")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "pages through more than 1000 commits without gaps",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = currentBranch(test.directory)
        const blocks: string[] = []
        for (let mark = 1; mark <= 1200; mark++) {
          blocks.push(commitBlock(mark, `chain ${mark}`, mark === 1 ? { branch, fromRef: "HEAD" } : { from: mark - 1, branch }))
        }
        fastImport(test.directory, blocks.join("\n"))

        const vcs = yield* init()
        const collected: string[] = []
        let cursor: string | undefined
        let pages = 0
        for (;;) {
          const page = cursor
            ? yield* vcs.gitHistory({ cursor })
            : yield* vcs.gitHistory({ selector: "head", limit: 200 })
          pages += 1
          for (const commit of page.commits) {
            expect(collected).not.toContain(commit.hash)
            collected.push(commit.hash)
          }
          if (!page.hasMore) {
            expect(page.nextCursor).toBeUndefined()
            break
          }
          expect(page.nextCursor).toBeDefined()
          cursor = page.nextCursor
          expect(pages).toBeLessThan(50)
        }
        expect(collected).toHaveLength(1201)
        const expected = gitSpawn(test.directory, [
          "--no-replace-objects",
          "rev-list",
          "--topo-order",
          "HEAD",
        ]).split("\n")
        expect(collected).toEqual(expected)
        expect(pages).toBe(7)
      }),
    { git: true },
    GIT_TEST_TIMEOUT * 3,
  )

  it.instance(
    "keeps continuation pages frozen while refs move",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = currentBranch(test.directory)
        fastImport(
          test.directory,
          [
            commitBlock(1, "one", { branch, fromRef: "HEAD" }),
            commitBlock(2, "two", { from: 1, branch }),
            commitBlock(3, "three", { from: 2, branch }),
            commitBlock(4, "four", { from: 3, branch }),
          ].join("\n"),
        )

        const vcs = yield* init()
        const firstPage = yield* vcs.gitHistory({ selector: "head", limit: 2 })
        expect(subjects(firstPage)).toEqual(["four", "three"])
        expect(firstPage.hasMore).toBe(true)
        const cursor = firstPage.nextCursor
        expect(cursor).toBeDefined()

        fastImport(
          test.directory,
          [commitBlock(5, "five", { fromRef: "HEAD", branch })].join("\n"),
        )
        const frozenPage = yield* vcs.gitHistory({ cursor })
        expect(subjects(frozenPage)).toEqual(["two", "one"])
        expect(frozenPage.hasMore).toBe(true)
        const frozenTail = yield* vcs.gitHistory({ cursor: frozenPage.nextCursor })
        expect(subjects(frozenTail)).toEqual([expect.stringMatching(/^root commit/)])
        expect(frozenTail.hasMore).toBe(false)

        const refreshed = yield* vcs.gitHistory({ selector: "head", limit: 2 })
        expect(subjects(refreshed)).toEqual(["five", "four"])
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "continues frozen pages after branch deletion and fails initial requests for deleted branches",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = currentBranch(test.directory)
        fastImport(
          test.directory,
          [
            commitBlock(1, "a", { branch, fromRef: "HEAD" }),
            commitBlock(2, "b", { from: 1, branch }),
            commitBlock(3, "c", { from: 2, branch }),
            resetBlock("tmp", 2),
          ].join("\n"),
        )

        const vcs = yield* init()
        const firstPage = yield* vcs.gitHistory({ selector: "branch", ref: "refs/heads/tmp", limit: 1 })
        expect(subjects(firstPage)).toEqual(["b"])
        const cursor = firstPage.nextCursor
        expect(cursor).toBeDefined()

        yield* git(test.directory, ["branch", "-D", "tmp"])
        const frozenPage = yield* vcs.gitHistory({ cursor })
        expect(subjects(frozenPage)).toEqual(["a"])

        const failed = yield* Effect.flip(vcs.gitHistory({ selector: "branch", ref: "refs/heads/tmp", limit: 10 }))
        expect(failed.code).toBe("invalid_ref")
        expect(failed.recovery).toBe("change-selection")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "requires refresh when the shallow boundary changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = currentBranch(test.directory)
        fastImport(
          test.directory,
          [
            commitBlock(1, "a", { branch, fromRef: "HEAD" }),
            commitBlock(2, "b", { from: 1, branch }),
            commitBlock(3, "c", { from: 2, branch }),
          ].join("\n"),
        )
        const gitDir = gitSpawn(test.directory, ["rev-parse", "--git-dir"])
        const shallowPath = path.isAbsolute(gitDir) ? path.join(gitDir, "shallow") : path.join(test.directory, gitDir, "shallow")
        const headBefore = gitSpawn(test.directory, ["rev-parse", "HEAD~1"])
        yield* Effect.promise(() => Bun.write(shallowPath, `${headBefore}\n`))

        const vcs = yield* init()
        const firstPage = yield* vcs.gitHistory({ selector: "head", limit: 1 })
        expect(subjects(firstPage)).toEqual(["c"])
        expect(firstPage.hasMore).toBe(true)
        const cursor = firstPage.nextCursor
        expect(cursor).toBeDefined()

        const boundary = gitSpawn(test.directory, ["rev-parse", "HEAD"])
        yield* Effect.promise(() => Bun.write(shallowPath, `${boundary}\n`))

        const failed = yield* Effect.flip(vcs.gitHistory({ cursor }))
        expect(failed.code).toBe("shallow_changed")
        expect(failed.recovery).toBe("refresh")
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "keeps large commit messages readable without blocking the page",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = currentBranch(test.directory)
        const bigBody = "x".repeat(1_500_000)
        const bigMessage = `big subject\n\n${bigBody}\n`
        const stream = [
          `commit refs/heads/${branch}`,
          "mark :1",
          "committer Test User <test@example.com> 1700000000 +0000",
          `data ${Buffer.from(bigMessage, "utf8").length}`,
          bigMessage,
          "from HEAD",
          "",
          commitBlock(2, "after big", { from: 1, branch }),
        ].join("\n")
        fastImport(test.directory, stream)

        const vcs = yield* init()
        const page = yield* vcs.gitHistory({ selector: "head", limit: 10 })
        expect(page.commits).toHaveLength(3)
        const bigCommit = page.commits.find((commit) => commit.subject === "big subject")
        expect(bigCommit).toBeDefined()
        expect(bigCommit?.bodyTruncated).toBe(true)
        expect(Buffer.byteLength(bigCommit?.body ?? "", "utf8")).toBeLessThanOrEqual(16 * 1024)
        expect(subjects(page)).toContain("after big")

        let text = ""
        let cursor: string | undefined
        for (let rounds = 0; rounds < 200; rounds += 1) {
          const chunk = cursor
            ? yield* vcs.gitCommitMessage({ cursor })
            : yield* vcs.gitCommitMessage({ hash: bigCommit?.hash })
          text += chunk.text
          if (!chunk.truncated) {
            expect(chunk.nextCursor).toBeUndefined()
            break
          }
          cursor = chunk.nextCursor
        }
        expect(text).toBe(bigMessage)
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )

  it.instance(
    "handles detached repositories predictably",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = currentBranch(test.directory)
        const vcs = yield* init()
        const initial = yield* vcs.gitHistory({ selector: "head", limit: 10 })
        expect(initial.commits).toHaveLength(1)
        expect(initial.hasMore).toBe(false)
        expect(initial.selector).toBe("head")

        fastImport(
          test.directory,
          [commitBlock(2, "second", { fromRef: "HEAD", branch })].join("\n"),
        )
        const headOidBefore = gitSpawn(test.directory, ["rev-parse", "HEAD"])
        yield* git(test.directory, ["checkout", "--detach", "HEAD~1"])
        const detached = yield* vcs.gitHistory({ selector: "head", limit: 10 })
        expect(detached.commits.map((commit) => commit.subject)).toHaveLength(1)
        expect(detached.commits[0].subject).not.toContain("second")
        expect(detached.headOid).toBe(gitSpawn(test.directory, ["rev-parse", "HEAD"]))
        expect(detached.headOid).not.toBe(headOidBefore)
        expect(detached.hasMore).toBe(false)
      }),
    { git: true },
    GIT_TEST_TIMEOUT,
  )
})
