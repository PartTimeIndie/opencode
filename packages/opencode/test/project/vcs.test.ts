import { afterEach, describe, expect } from "bun:test"
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
