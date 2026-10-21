import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Cause, Duration, Effect, Layer, Option, Schedule, Schema, Semaphore, Context } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import { AppProcess } from "@opencode-ai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import { SnapshotActivity } from "@opencode-ai/core/snapshot-activity"

export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
})
export type Patch = typeof Patch.Type
export type RevertPatch = Patch & { after?: string }

export const FileDiff = Schema.Struct({
  // Optional because legacy/imported `summary_diffs` on disk may omit
  // file details and patch text. Required Schema rejected the whole
  // session response and broke session loading on Desktop.
  file: Schema.optional(Schema.String),
  patch: Schema.optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "SnapshotFileDiff" })
export type FileDiff = typeof FileDiff.Type

const prune = "never"
const limit = 2 * 1024 * 1024
export const MAX_DIFF_PATCH_BYTES = 2 * 1024 * 1024
const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const cfg = ["-c", "core.autocrlf=false", ...core]
const treeHash = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const quote = [...cfg, "-c", "core.quotepath=false"]
interface GitResult {
  readonly code: ChildProcessSpawner.ExitCode
  readonly text: string
  readonly stderr: string
}

type State = Omit<Interface, "init">

export const recoverCorruptRepository = <A>(
  fallback: A,
  attempt: Effect.Effect<{ value: A; corrupt: boolean }>,
  quarantine: Effect.Effect<boolean>,
  retryFailed: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const first = yield* attempt
    if (!first.corrupt) return first.value
    if (!(yield* quarantine)) return fallback
    const second = yield* attempt
    if (!second.corrupt) return second.value
    yield* retryFailed
    return fallback
  })

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly cleanup: () => Effect.Effect<void>
  readonly track: () => Effect.Effect<string | undefined>
  readonly patch: (hash: string) => Effect.Effect<Patch>
  readonly restore: (snapshot: string) => Effect.Effect<void>
  readonly revert: (patches: RevertPatch[]) => Effect.Effect<void>
  readonly diff: (hash: string) => Effect.Effect<string>
  readonly diffFull: (from: string, to: string) => Effect.Effect<FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Snapshot") {}

export const layer: Layer.Layer<
  Service,
  never,
  FSUtil.Service | AppProcess.Service | Config.Service | EffectFlock.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const effectFlock = yield* EffectFlock.Service
    const locks = new Map<string, Semaphore.Semaphore>()

    const lock = (key: string) => {
      const hit = locks.get(key)
      if (hit) return hit

      const next = Semaphore.makeUnsafe(1)
      locks.set(key, next)
      return next
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("Snapshot.state")(function* (ctx) {
        const state = {
          directory: ctx.directory,
          worktree: ctx.worktree,
          gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)),
          vcs: ctx.project.vcs,
        }

        const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

        const feed = (list: string[]) => list.join("\0") + "\0"

        const git = Effect.fnUntraced(
          function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; stdin?: string }) {
            const result = yield* appProcess.run(
              ChildProcess.make("git", cmd, { cwd: opts?.cwd, env: opts?.env, extendEnv: true }),
              { stdin: opts?.stdin },
            )
            return {
              code: ChildProcessSpawner.ExitCode(result.exitCode),
              text: result.stdout.toString("utf8"),
              stderr: result.stderr.toString("utf8"),
            } satisfies GitResult
          },
          Effect.catch((err) =>
            Effect.succeed({
              code: ChildProcessSpawner.ExitCode(1),
              text: "",
              stderr: err instanceof Error ? err.message : String(err),
            }),
          ),
        )

        const isCorruptionFailure = (result: GitResult) => {
          if (result.code === 0) return false
          return /(?:not a git repository|bad (?:tree )?object|invalid object|missing (?:blob|tree|commit)|object file .* (?:empty|corrupt)|loose object .* corrupt|unable to read(?: tree| sha1 file)?(?:\s+[0-9a-f]{40,64})?|could not read|failed to read object)/i.test(
            `${result.stderr}\n${result.text}`,
          )
        }

        const validateTree = Effect.fnUntraced(function* (hash: string) {
          const result = yield* git([...core, ...args(["cat-file", "-e", `${hash}^{tree}`])], {
            cwd: state.directory,
          })
          if (result.code === 0) return true
          yield* Effect.logWarning("failed to validate snapshot tree", {
            hash,
            exitCode: result.code,
            stderr: result.stderr,
          })
          return false
        })

        const ignore = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return new Set<string>()
          const check = yield* git(
            [
              ...quote,
              "--git-dir",
              path.join(state.worktree, ".git"),
              "--work-tree",
              state.worktree,
              "check-ignore",
              "--no-index",
              "--stdin",
              "-z",
            ],
            {
              cwd: state.directory,
              stdin: feed(files),
            },
          )
          if (check.code !== 0 && check.code !== 1) return new Set<string>()
          return new Set(check.text.split("\0").filter(Boolean))
        })

        const drop = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return { ok: true, corrupt: false }
          const result = yield* git(
            [
              ...cfg,
              ...args(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
            ],
            {
              cwd: state.directory,
              stdin: feed(files),
            },
          )
          if (result.code === 0) return { ok: true, corrupt: false }
          yield* Effect.logWarning("failed to remove snapshot files", {
            exitCode: result.code,
            stderr: result.stderr,
          })
          return { ok: false, corrupt: isCorruptionFailure(result) }
        })

        const stage = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return { ok: true, corrupt: false }
          const result = yield* git(
            [...cfg, ...args(["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"])],
            {
              cwd: state.directory,
              stdin: feed(files),
            },
          )
          if (result.code === 0) return { ok: true, corrupt: false }
          yield* Effect.logWarning("failed to add snapshot files", {
            exitCode: result.code,
            stderr: result.stderr,
          })
          return { ok: false, corrupt: isCorruptionFailure(result) }
        })

        const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
        const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
        const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
        const touch = () =>
          exists(state.gitdir).pipe(
            Effect.flatMap((present) => (present ? Effect.promise(() => SnapshotActivity.record(state.gitdir)) : Effect.void)),
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to update snapshot activity", { gitdir: state.gitdir, cause }),
            ),
          )
        const lockStat = (file: string) =>
          fs.stat(file).pipe(
            Effect.map((info) => ({
              mtime: info.mtime.pipe(Option.getOrElse(() => new Date(0))).getTime(),
              size: Number(info.size),
            })),
            Effect.catch(() => Effect.succeed(undefined)),
          )
        const prepareIndex = Effect.fnUntraced(function* () {
          const file = path.join(state.gitdir, "index.lock")
          const first = yield* lockStat(file)
          if (!first) return true
          if (Date.now() - first.mtime <= 60_000) {
            yield* Effect.logWarning("preserving fresh snapshot index lock", { gitdir: state.gitdir, file })
            return false
          }
          const second = yield* lockStat(file)
          if (!second || second.mtime !== first.mtime || second.size !== first.size) return false
          const removed = yield* fs.remove(file).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          )
          if (!removed || (yield* lockStat(file))) {
            yield* Effect.logWarning("failed to recover snapshot index lock", { gitdir: state.gitdir, file })
            return false
          }
          return true
        })
        const locked = <A>(fallback: A, fx: Effect.Effect<A>) =>
          effectFlock
            .withLock(state.gitdir)(
              lock(state.gitdir).withPermits(1)(
                Effect.gen(function* () {
                  if (!(yield* prepareIndex())) return fallback
                  return yield* fx
                }),
              ),
            )
            .pipe(
              Effect.catchTags({
                LockTimeoutError: (error) =>
                  Effect.logWarning("snapshot cross-process lock timed out", {
                    gitdir: state.gitdir,
                    key: error.key,
                  }).pipe(Effect.as(fallback)),
                LockCompromisedError: (error) =>
                  Effect.logWarning("snapshot cross-process lock was compromised", {
                    gitdir: state.gitdir,
                    detail: error.detail,
                  }).pipe(Effect.as(fallback)),
              }),
            )

        const enabled = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return false
          return (yield* config.get()).snapshot !== false
        })

        const excludes = Effect.fnUntraced(function* () {
          const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
            cwd: state.worktree,
          })
          const file = result.text.trim()
          if (!file) return
          if (!(yield* exists(file))) return
          return file
        })

        const sync = Effect.fnUntraced(function* (list: string[] = []) {
          const file = yield* excludes()
          const target = path.join(state.gitdir, "info", "exclude")
          const text = [
            file ? (yield* read(file)).trimEnd() : "",
            ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
          ]
            .filter(Boolean)
            .join("\n")
          yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(
            Effect.andThen(() => fs.writeFileString(target, text ? `${text}\n` : "")),
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to update snapshot excludes", {
                target,
                cause: Cause.pretty(cause),
              }),
            ),
          )
        })

        // Reuse the hashes for the git storage between the original repo and snapshot
        // on huge repos like chromium checkout the git add --all rebuilding the
        // hashes can take minutes. By doing this we eliminating this at all
        const seed = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return

          const commonDir = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd: state.worktree,
          })

          if (commonDir.code !== 0) return
          const source = commonDir.text.trim()
          if (!source || !(yield* exists(source))) return

          // Share the source object database (and the source's own alternates,
          // skipping any that no longer exist) so seeded blobs resolve.
          const sourceObjects = path.join(source, "objects")
          const chained = (yield* read(path.join(sourceObjects, "info", "alternates")))
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
          const alternates: string[] = []
          for (const candidate of [sourceObjects, ...chained]) {
            if (yield* exists(candidate)) alternates.push(candidate)
          }
          if (!alternates.length) return

          yield* fs.ensureDir(path.join(state.gitdir, "objects", "info")).pipe(Effect.orDie)
          yield* fs
            .writeFileString(path.join(state.gitdir, "objects", "info", "alternates"), alternates.join("\n") + "\n")
            .pipe(Effect.orDie)

          // Seed the index from the source repo so already-hashed entries are reused.
          // Best-effort: a missing/incompatible index just falls back to a full add.
          const sourceIndex = path.join(source, "index")
          if (yield* exists(sourceIndex)) {
            yield* fs.copyFile(sourceIndex, path.join(state.gitdir, "index")).pipe(Effect.catch(() => Effect.void))
          }
        })

        const add = Effect.fnUntraced(function* () {
          yield* sync()
          const [diff, other] = yield* Effect.all(
            [
              git([...quote, ...args(["diff-files", "--name-only", "-z", "--", "."])], {
                cwd: state.directory,
              }),
              git([...quote, ...args(["ls-files", "--others", "--exclude-standard", "-z", "--", "."])], {
                cwd: state.directory,
              }),
            ],
            { concurrency: 2 },
          )
          if (diff.code !== 0 || other.code !== 0) {
            yield* Effect.logWarning("failed to list snapshot files", {
              diffCode: diff.code,
              diffStderr: diff.stderr,
              otherCode: other.code,
              otherStderr: other.stderr,
            })
            return { ok: false, corrupt: isCorruptionFailure(diff) || isCorruptionFailure(other) }
          }

          const tracked = diff.text.split("\0").filter(Boolean)
          const untracked = other.text.split("\0").filter(Boolean)
          const all = Array.from(new Set([...tracked, ...untracked]))
          if (!all.length) return { ok: true, corrupt: false }

          // Resolve source-repo ignore rules against the exact candidate set.
          // --no-index keeps this pattern-based even when a path is already tracked.
          const ignored = yield* ignore(all)

          // Remove newly-ignored files from snapshot index to prevent re-adding
          if (ignored.size > 0) {
            const ignoredFiles = Array.from(ignored)
            yield* Effect.logInfo("removing gitignored files from snapshot", { count: ignoredFiles.length })
            const dropped = yield* drop(ignoredFiles)
            if (!dropped.ok) return dropped
          }

          const allow = all.filter((item) => !ignored.has(item))
          if (!allow.length) return { ok: true, corrupt: false }

          const large = new Set(
            (yield* Effect.all(
              allow.map((item) =>
                fs
                  .stat(path.join(state.directory, item))
                  .pipe(Effect.catch(() => Effect.void))
                  .pipe(
                    Effect.map((stat) => {
                      if (!stat || stat.type !== "File") return
                      const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                      return size > limit ? item : undefined
                    }),
                  ),
              ),
              { concurrency: 8 },
            )).filter((item): item is string => Boolean(item)),
          )
          const block = new Set(untracked.filter((item) => large.has(item)))
          yield* sync(Array.from(block))
          // Stage only the allowed candidate paths so snapshot updates stay scoped.
          return yield* stage(allow.filter((item) => !block.has(item)))
        })

        const initialize = Effect.fnUntraced(function* () {
          if (yield* exists(state.gitdir)) {
            const validation = yield* git([...core, ...args(["rev-parse", "--git-dir"])], { cwd: state.directory })
            if (validation.code === 0) return { ok: true, corrupt: false }
            yield* Effect.logWarning("invalid snapshot repository", {
              worktree: state.worktree,
              gitdir: state.gitdir,
              exitCode: validation.code,
              stderr: validation.stderr,
            })
            return { ok: false, corrupt: isCorruptionFailure(validation) }
          }
          yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
          const initialized = yield* git(["init"], {
            env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
          })
          if (initialized.code !== 0) return { ok: false, corrupt: isCorruptionFailure(initialized) }
          const configured = yield* Effect.all(
            [
              ["core.autocrlf", "false"],
              ["core.longpaths", "true"],
              ["core.symlinks", "true"],
              ["core.fsmonitor", "false"],
              ["feature.manyFiles", "true"],
              ["index.version", "4"],
              ["index.threads", "true"],
              ["core.untrackedCache", "true"],
            ].map(([key, value]) => git(["--git-dir", state.gitdir, "config", key, value])),
            { concurrency: 1 },
          )
          const failed = configured.find((result) => result.code !== 0)
          if (failed) return { ok: false, corrupt: isCorruptionFailure(failed) }
          yield* seed()
          yield* Effect.logInfo("initialized", { worktree: state.worktree, gitdir: state.gitdir })
          return { ok: true, corrupt: false }
        })

        const quarantine = Effect.fnUntraced(function* () {
          const target = `${state.gitdir}.corrupt-${Date.now()}-${crypto.randomUUID()}`
          const moved = yield* fs.rename(state.gitdir, target).pipe(
            Effect.as(true),
            Effect.catch((cause) =>
              Effect.logWarning("failed to quarantine corrupt snapshot repository", {
                worktree: state.worktree,
                gitdir: state.gitdir,
                quarantine: target,
                cause,
              }).pipe(Effect.as(false)),
            ),
          )
          if (!moved) return false
          yield* Effect.logWarning("quarantined corrupt snapshot repository", {
            worktree: state.worktree,
            gitdir: state.gitdir,
            quarantine: target,
          })
          return true
        })

        const recover = <A>(fallback: A, operation: string, attempt: Effect.Effect<{ value: A; corrupt: boolean }>) =>
          recoverCorruptRepository(
            fallback,
            attempt,
            quarantine(),
            Effect.logWarning("snapshot recovery retry failed", {
              operation,
              worktree: state.worktree,
              gitdir: state.gitdir,
            }),
          )

        const cleanup = Effect.fnUntraced(function* () {
          return yield* locked(
            undefined,
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              if (!(yield* exists(state.gitdir))) return
              return yield* recover(
                undefined,
                "cleanup",
                Effect.gen(function* () {
                  const initialized = yield* initialize()
                  if (!initialized.ok) return { value: undefined, corrupt: initialized.corrupt }
                  const result = yield* git(args(["gc", `--prune=${prune}`]), { cwd: state.directory })
                  if (result.code !== 0) {
                    yield* Effect.logWarning("cleanup failed", {
                      exitCode: result.code,
                      stderr: result.stderr,
                    })
                    return { value: undefined, corrupt: isCorruptionFailure(result) }
                  }
                  yield* Effect.logInfo("cleanup", { prune })
                  return { value: undefined, corrupt: false }
                }),
              )
            }),
          )
        })

        const track = Effect.fnUntraced(function* () {
          return yield* locked(
            undefined,
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              return yield* recover(
                undefined,
                "track",
                Effect.gen(function* () {
                   const initialized = yield* initialize()
                   if (!initialized.ok) return { value: undefined, corrupt: initialized.corrupt }
                   yield* touch()
                   const added = yield* add()
                  if (!added.ok) return { value: undefined, corrupt: added.corrupt }
                  const result = yield* git(args(["write-tree"]), { cwd: state.directory })
                  const hash = result.text.trim()
                  if (result.code !== 0 || !treeHash.test(hash)) {
                    yield* Effect.logWarning("failed to write snapshot tree", {
                      exitCode: result.code,
                      stderr: result.stderr,
                      hash,
                    })
                    return { value: undefined, corrupt: isCorruptionFailure(result) }
                  }
                  yield* Effect.logInfo("tracking", { hash, cwd: state.directory, git: state.gitdir })
                  return { value: hash, corrupt: false }
                }),
              )
            }),
          )
        })

        const patch = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            { hash, files: [] },
            Effect.gen(function* () {
              if (!treeHash.test(hash)) return { hash, files: [] }
              return yield* recover(
                { hash, files: [] },
                "patch",
                Effect.gen(function* () {
                   const initialized = yield* initialize()
                   if (!initialized.ok) return { value: { hash, files: [] }, corrupt: initialized.corrupt }
                   yield* touch()
                   if (!(yield* validateTree(hash))) return { value: { hash, files: [] }, corrupt: true }
                  const added = yield* add()
                  if (!added.ok) return { value: { hash, files: [] }, corrupt: added.corrupt }
                  const validation = yield* git(
                    [...quote, ...args(["diff", "--cached", "--no-ext-diff", "--shortstat", hash, "--", "."])],
                    { cwd: state.directory },
                  )
                  if (validation.code !== 0) {
                    yield* Effect.logWarning("failed to validate snapshot diff", {
                      hash,
                      exitCode: validation.code,
                      stderr: validation.stderr,
                    })
                    return { value: { hash, files: [] }, corrupt: isCorruptionFailure(validation) }
                  }
                  const result = yield* git(
                    [...quote, ...args(["diff", "--cached", "--no-ext-diff", "--name-only", hash, "--", "."])],
                    {
                      cwd: state.directory,
                    },
                  )
                  if (result.code !== 0) {
                    yield* Effect.logWarning("failed to get diff", { hash, exitCode: result.code })
                    return { value: { hash, files: [] }, corrupt: isCorruptionFailure(result) }
                  }
                  const files = result.text
                    .trim()
                    .split("\n")
                    .map((x) => x.trim())
                    .filter(Boolean)

                  // Hide ignored-file removals from the user-facing patch output.
                  const ignored = yield* ignore(files)

                  return {
                    value: {
                      hash,
                      files: files
                        .filter((item) => !ignored.has(item))
                        .map((x) => path.join(state.worktree, x).replaceAll("\\", "/")),
                    },
                    corrupt: false,
                  }
                }),
              )
            }),
          )
        })

        const restore = Effect.fnUntraced(function* (snapshot: string) {
          return yield* locked(
            undefined,
            Effect.gen(function* () {
              if (!treeHash.test(snapshot)) return
              return yield* recover(
                undefined,
                "restore",
                Effect.gen(function* () {
                   const initialized = yield* initialize()
                   if (!initialized.ok) return { value: undefined, corrupt: initialized.corrupt }
                   yield* touch()
                   if (!(yield* validateTree(snapshot))) return { value: undefined, corrupt: true }
                  yield* Effect.logInfo("restore", { commit: snapshot })
                  const result = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
                  if (result.code !== 0) {
                    yield* Effect.logError("failed to restore snapshot", {
                      snapshot,
                      exitCode: result.code,
                      stderr: result.stderr,
                    })
                    return { value: undefined, corrupt: isCorruptionFailure(result) }
                  }
                  const checkout = yield* git([...core, ...args(["checkout-index", "-a", "-f"])], {
                    cwd: state.worktree,
                  })
                  if (checkout.code === 0) return { value: undefined, corrupt: false }
                  yield* Effect.logError("failed to restore snapshot", {
                    snapshot,
                    exitCode: checkout.code,
                    stderr: checkout.stderr,
                  })
                  return { value: undefined, corrupt: isCorruptionFailure(checkout) }
                }),
              )
            }),
          )
        })

        const revert = Effect.fnUntraced(function* (patches: RevertPatch[]) {
          return yield* locked(
            undefined,
            Effect.gen(function* () {
              yield* touch()
              const ops: { hash: string; after?: string; file: string; rel: string }[] = []
              const seen = new Map<string, (typeof ops)[number]>()
              for (const item of patches) {
                for (const file of item.files) {
                  const hit = seen.get(file)
                  if (hit) {
                    if (item.after) hit.after = item.after
                    continue
                  }
                  const op = {
                    hash: item.hash,
                    after: item.after,
                    file,
                    rel: path.relative(state.worktree, file).replaceAll("\\", "/"),
                  }
                  seen.set(file, op)
                  ops.push(op)
                }
              }

              const treeText = Effect.fnUntraced(function* (hash: string, rel: string) {
                const result = yield* git([...core, ...args(["show", `${hash}:${rel}`])], { cwd: state.worktree })
                if (result.code !== 0) return undefined
                return result.text
              })

              const reverseApply = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                if (!op.after) return false
                const patch = yield* git(
                  [...quote, ...args(["diff", "--binary", "--no-ext-diff", op.hash, op.after, "--", op.rel])],
                  { cwd: state.worktree },
                )
                if (patch.code !== 0 || !patch.text.trim()) return false
                const result = yield* git([...core, "apply", "--reverse", "--binary", "--whitespace=nowarn", "-"], {
                  cwd: state.worktree,
                  stdin: patch.text,
                })
                if (result.code === 0) return true
                yield* Effect.logInfo("reverse patch apply failed, falling back to merge revert", {
                  file: op.file,
                  hash: op.hash,
                  after: op.after,
                  stderr: result.stderr,
                })
                return false
              })

              const mergeText = Effect.fnUntraced(function* (op: (typeof ops)[number], base: string, other: string) {
                const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
                const baseFile = path.join(state.gitdir, `opencode-revert-base-${nonce}`)
                const otherFile = path.join(state.gitdir, `opencode-revert-other-${nonce}`)
                return yield* Effect.acquireUseRelease(
                  Effect.gen(function* () {
                    yield* fs.writeFileString(baseFile, base).pipe(Effect.orDie)
                    yield* fs.writeFileString(otherFile, other).pipe(Effect.orDie)
                    return { baseFile, otherFile }
                  }),
                  ({ baseFile, otherFile }) =>
                    git([...core, "merge-file", "-p", "--diff3", op.file, baseFile, otherFile], {
                      cwd: state.worktree,
                    }),
                  ({ baseFile, otherFile }) =>
                    Effect.all([remove(baseFile), remove(otherFile)], { discard: true, concurrency: 2 }),
                ).pipe(
                  Effect.map((result) => {
                    if (result.code === 0 || result.code === 1) return result.text
                    return undefined
                  }),
                )
              })

              const mergedRevert = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                if (!op.after) return false
                const before = yield* treeText(op.hash, op.rel)
                const after = yield* treeText(op.after, op.rel)
                const current = (yield* exists(op.file)) ? yield* read(op.file) : undefined
                if (before === undefined && after === undefined) return false
                const text = (value: string | undefined): value is string =>
                  value !== undefined && !value.includes("\0") && !value.includes("\uFFFD")

                if (text(before) && text(after) && text(current) && after && current.includes(after)) {
                  const index = current.indexOf(after)
                  yield* fs
                    .writeWithDirs(op.file, current.slice(0, index) + before + current.slice(index + after.length))
                    .pipe(Effect.orDie)
                  return true
                }

                if (yield* reverseApply(op)) return true

                if (before === undefined) {
                  if (current === undefined) return true
                  if (current === after) yield* remove(op.file)
                  return true
                }

                if (after === undefined) {
                  if (!text(before) || (current !== undefined && !text(current))) return false
                  if (current === undefined) {
                    yield* fs.writeWithDirs(op.file, before).pipe(Effect.orDie)
                    return true
                  }
                  const merged = yield* mergeText(op, "", before)
                  if (merged === undefined) return false
                  yield* fs.writeWithDirs(op.file, merged).pipe(Effect.orDie)
                  return true
                }

                if (current === undefined) return true
                if (!text(before) || !text(after) || !text(current)) return false
                if (current === after) {
                  yield* fs.writeWithDirs(op.file, before).pipe(Effect.orDie)
                  return true
                }
                const merged = yield* mergeText(op, after, before)
                if (merged === undefined) return false
                yield* fs.writeWithDirs(op.file, merged).pipe(Effect.orDie)
                return true
              })

              const single = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                if (yield* mergedRevert(op)) return
                yield* Effect.logInfo("reverting", { file: op.file, hash: op.hash })
                const result = yield* git([...core, ...args(["checkout", op.hash, "--", op.file])], {
                  cwd: state.worktree,
                })
                if (result.code === 0) return
                const tree = yield* git([...core, ...args(["ls-tree", op.hash, "--", op.rel])], {
                  cwd: state.worktree,
                })
                if (tree.code === 0 && tree.text.trim()) {
                  yield* Effect.logInfo("file existed in snapshot but checkout failed, keeping", {
                    file: op.file,
                    hash: op.hash,
                  })
                  return
                }
                yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                yield* remove(op.file)
              })

              const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

              for (let i = 0; i < ops.length;) {
                const first = ops[i]!
                if (first.after) {
                  yield* single(first)
                  i += 1
                  continue
                }
                const run = [first]
                let j = i + 1
                // Only batch adjacent files when their paths cannot affect each other.
                while (j < ops.length && run.length < 100) {
                  const next = ops[j]!
                  if (next.after) break
                  if (next.hash !== first.hash) break
                  if (run.some((item) => clash(item.rel, next.rel))) break
                  run.push(next)
                  j += 1
                }

                if (run.length === 1) {
                  yield* single(first)
                  i = j
                  continue
                }

                const tree = yield* git(
                  [...core, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
                  {
                    cwd: state.worktree,
                  },
                )

                if (tree.code !== 0) {
                  yield* Effect.logInfo("batched ls-tree failed, falling back to single-file revert", {
                    hash: first.hash,
                    files: run.length,
                  })
                  for (const op of run) {
                    yield* single(op)
                  }
                  i = j
                  continue
                }

                const have = new Set(
                  tree.text
                    .trim()
                    .split("\n")
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
                const list = run.filter((item) => have.has(item.rel))
                if (list.length) {
                  yield* Effect.logInfo("reverting", { hash: first.hash, files: list.length })
                  const result = yield* git(
                    [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
                    {
                      cwd: state.worktree,
                    },
                  )
                  if (result.code !== 0) {
                    yield* Effect.logInfo("batched checkout failed, falling back to single-file revert", {
                      hash: first.hash,
                      files: list.length,
                    })
                    for (const op of run) {
                      yield* single(op)
                    }
                    i = j
                    continue
                  }
                }

                for (const op of run) {
                  if (have.has(op.rel)) continue
                  yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                  yield* remove(op.file)
                }

                i = j
              }
            }),
          )
        })

        const diff = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            "",
            Effect.gen(function* () {
              yield* touch()
              if (!(yield* add()).ok) return ""
              const result = yield* git([...quote, ...args(["diff", "--cached", "--no-ext-diff", hash, "--", "."])], {
                cwd: state.worktree,
              })
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", {
                  hash,
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return ""
              }
              return result.text.trim()
            }),
          )
        })

        const diffFull = Effect.fnUntraced(function* (from: string, to: string) {
          return yield* locked(
            [],
            Effect.gen(function* () {
              yield* touch()
              type Row = {
                file: string
                status: "added" | "deleted" | "modified"
                binary: boolean
                additions: number
                deletions: number
              }

              type Ref = {
                file: string
                side: "before" | "after"
                ref: string
              }

              const show = Effect.fnUntraced(function* (row: Row) {
                if (row.binary) return ["", ""]
                if (row.status === "added") {
                  return [
                    "",
                    yield* git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ]
                }
                if (row.status === "deleted") {
                  return [
                    yield* git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(
                      Effect.map((item) => item.text),
                    ),
                    "",
                  ]
                }
                return yield* Effect.all(
                  [
                    git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                    git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ],
                  { concurrency: 2 },
                )
              })

              const load = Effect.fnUntraced(
                function* (rows: Row[]) {
                  const refs = rows.flatMap((row) => {
                    if (row.binary) return []
                    if (row.status === "added")
                      return [{ file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref]
                    if (row.status === "deleted") {
                      return [{ file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref]
                    }
                    return [
                      { file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref,
                      { file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref,
                    ]
                  })
                  if (!refs.length) return new Map<string, { before: string; after: string }>()

                  const batch = yield* appProcess.run(
                    ChildProcess.make("git", [...cfg, ...args(["cat-file", "--batch"])], {
                      cwd: state.directory,
                      extendEnv: true,
                    }),
                    { stdin: refs.map((item) => item.ref).join("\n") + "\n" },
                  )
                  if (batch.exitCode !== 0) {
                    yield* Effect.logInfo(
                      "git cat-file --batch failed during snapshot diff, falling back to per-file git show",
                      {
                        stderr: batch.stderr.toString("utf8"),
                        refs: refs.length,
                      },
                    )
                    return
                  }
                  const out = batch.stdout

                  const fail = (msg: string, extra?: Record<string, string>) => {
                    return undefined
                  }

                  const map = new Map<string, { before: string; after: string }>()
                  const dec = new TextDecoder()
                  let i = 0
                  for (const ref of refs) {
                    let end = i
                    while (end < out.length && out[end] !== 10) end += 1
                    if (end >= out.length) {
                      return fail(
                        "git cat-file --batch returned a truncated header during snapshot diff, falling back to per-file git show",
                      )
                    }

                    const head = dec.decode(out.slice(i, end))
                    i = end + 1
                    const hit = map.get(ref.file) ?? { before: "", after: "" }
                    if (head.endsWith(" missing")) {
                      map.set(ref.file, hit)
                      continue
                    }

                    const match = head.match(/^[0-9a-f]+ blob (\d+)$/)
                    if (!match) {
                      return fail(
                        "git cat-file --batch returned an unexpected header during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const size = Number(match[1])
                    if (!Number.isInteger(size) || size < 0 || i + size >= out.length || out[i + size] !== 10) {
                      return fail(
                        "git cat-file --batch returned truncated content during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const text = dec.decode(out.slice(i, i + size))
                    if (ref.side === "before") hit.before = text
                    if (ref.side === "after") hit.after = text
                    map.set(ref.file, hit)
                    i += size + 1
                  }

                  if (i !== out.length) {
                    return fail(
                      "git cat-file --batch returned trailing data during snapshot diff, falling back to per-file git show",
                    )
                  }

                  return map
                },
                Effect.scoped,
                Effect.catch(() =>
                  Effect.succeed<Map<string, { before: string; after: string }> | undefined>(undefined),
                ),
              )

              const result: FileDiff[] = []
              const status = new Map<string, "added" | "deleted" | "modified">()

              const statuses = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--name-status", "--no-renames", from, to, "--", "."])],
                { cwd: state.directory },
              )

              for (const line of statuses.text.trim().split("\n")) {
                if (!line) continue
                const [code, file] = line.split("\t")
                if (!code || !file) continue
                status.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified")
              }

              const numstat = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--no-renames", "--numstat", from, to, "--", "."])],
                {
                  cwd: state.directory,
                },
              )

              const rows = numstat.text
                .trim()
                .split("\n")
                .filter(Boolean)
                .flatMap((line) => {
                  const [adds, dels, file] = line.split("\t")
                  if (!file) return []
                  const binary = adds === "-" && dels === "-"
                  const additions = binary ? 0 : parseInt(adds)
                  const deletions = binary ? 0 : parseInt(dels)
                  return [
                    {
                      file,
                      status: status.get(file) ?? "modified",
                      binary,
                      additions: Number.isFinite(additions) ? additions : 0,
                      deletions: Number.isFinite(deletions) ? deletions : 0,
                    } satisfies Row,
                  ]
                })

              // Hide ignored-file removals from the user-facing diff output.
              const ignored = yield* ignore(rows.map((r) => r.file))
              if (ignored.size > 0) {
                const filtered = rows.filter((r) => !ignored.has(r.file))
                rows.length = 0
                rows.push(...filtered)
              }

              const step = 100
              const patch = (file: string, before: string, after: string) =>
                formatPatch(structuredPatch(file, file, before, after, "", "", { context: Number.MAX_SAFE_INTEGER }))
              const patchBudget = { remaining: MAX_DIFF_PATCH_BYTES }

              for (let i = 0; i < rows.length; i += step) {
                const run = rows.slice(i, i + step)
                if (patchBudget.remaining <= 0) {
                  result.push(
                    ...run.map((row) => ({
                      file: row.file,
                      ...(row.binary ? { patch: "" } : {}),
                      additions: row.additions,
                      deletions: row.deletions,
                      status: row.status,
                    })),
                  )
                  continue
                }
                const text = yield* load(run)

                for (const row of run) {
                  if (!row.binary && patchBudget.remaining <= 0) {
                    result.push({
                      file: row.file,
                      additions: row.additions,
                      deletions: row.deletions,
                      status: row.status,
                    })
                    continue
                  }
                  const hit = text?.get(row.file) ?? { before: "", after: "" }
                  const [before, after] = row.binary ? ["", ""] : text ? [hit.before, hit.after] : yield* show(row)
                  const next = row.binary ? "" : patch(row.file, before, after)
                  const size = Buffer.byteLength(next, "utf8")
                  const included = size <= patchBudget.remaining
                  if (included) patchBudget.remaining -= size
                  result.push({
                    file: row.file,
                    ...(included ? { patch: next } : {}),
                    additions: row.additions,
                    deletions: row.deletions,
                    status: row.status,
                  })
                }
              }

              return result
            }),
          )
        })

        yield* cleanup().pipe(
          Effect.catchCause((cause) => Effect.logError("cleanup loop failed", { cause: Cause.pretty(cause) })),
          Effect.repeat(Schedule.spaced(Duration.hours(1))),
          Effect.delay(Duration.minutes(1)),
          Effect.forkScoped,
        )

        return { cleanup, track, patch, restore, revert, diff, diffFull }
      }),
    )

    return Service.of({
      init: Effect.fn("Snapshot.init")(function* () {
        yield* InstanceState.get(state)
      }),
      cleanup: Effect.fn("Snapshot.cleanup")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.cleanup())
      }),
      track: Effect.fn("Snapshot.track")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.track())
      }),
      patch: Effect.fn("Snapshot.patch")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.patch(hash))
      }),
      restore: Effect.fn("Snapshot.restore")(function* (snapshot: string) {
        return yield* InstanceState.useEffect(state, (s) => s.restore(snapshot))
      }),
      revert: Effect.fn("Snapshot.revert")(function* (patches: Patch[]) {
        return yield* InstanceState.useEffect(state, (s) => s.revert(patches))
      }),
      diff: Effect.fn("Snapshot.diff")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diff(hash))
      }),
      diffFull: Effect.fn("Snapshot.diffFull")(function* (from: string, to: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diffFull(from, to))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
)

export const node = LayerNode.make(layer, [FSUtil.node, AppProcess.node, Config.node, EffectFlock.node])

export * as Snapshot from "."
