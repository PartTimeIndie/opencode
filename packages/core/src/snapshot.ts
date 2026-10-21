export * as Snapshot from "./snapshot"

import path from "path"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "./process"
import { Config } from "./config"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { Global } from "./global"
import { Location } from "./location"
import { EffectFlock } from "./util/effect-flock"
import { Hash } from "./util/hash"
import { LayerNode } from "./effect/layer-node"
import { SnapshotActivity } from "./snapshot-activity"

export type FileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.Array(Schema.String),
})
export type Patch = typeof Patch.Type
export type RevertPatch = Patch & { readonly after?: string }

export interface Interface {
  readonly track: (location: Location.Ref) => Effect.Effect<string | undefined>
  readonly changedFiles: (input: {
    readonly location: Location.Ref
    readonly from: string
    readonly to: string
  }) => Effect.Effect<string[]>
  readonly patch: (input: { readonly location: Location.Ref; readonly hash: string }) => Effect.Effect<Patch>
  readonly restore: (input: { readonly location: Location.Ref; readonly snapshot: string }) => Effect.Effect<void>
  readonly revert: (input: { readonly location: Location.Ref; readonly patches: RevertPatch[] }) => Effect.Effect<void>
  readonly diff: (input: { readonly location: Location.Ref; readonly hash: string }) => Effect.Effect<string | undefined>
  readonly diffFull: (input: {
    readonly location: Location.Ref
    readonly from: string
    readonly to: string
  }) => Effect.Effect<FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Snapshot") {}

type State = {
  readonly directory: string
  readonly worktree: string
  readonly gitdir: string
}

type GitResult = {
  readonly code: number
  readonly text: string
  readonly stderr: string
}

const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const cfg = ["-c", "core.autocrlf=false", ...core]
const quote = [...cfg, "-c", "core.quotepath=false"]

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const global = yield* Global.Service
    const appProcess = yield* AppProcess.Service
    const effectFlock = yield* EffectFlock.Service
    const locks = new Map<string, Semaphore.Semaphore>()
    const states = new Map<string, State>()

    const lock = (key: string) => {
      const existing = locks.get(key)
      if (existing) return existing
      const semaphore = Semaphore.makeUnsafe(1)
      locks.set(key, semaphore)
      return semaphore
    }

    const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false))
    const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
    const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
    const touch = (current: State) =>
      Effect.promise(() => SnapshotActivity.record(current.gitdir)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to update snapshot activity", { gitdir: current.gitdir, cause }),
        ),
      )

    const indexLock = (current: State) => path.join(current.gitdir, "index.lock")
    const lockStat = (file: string) =>
      fs.stat(file).pipe(
        Effect.map((info) => ({
          mtime: info.mtime.pipe(Option.getOrElse(() => new Date(0))).getTime(),
          size: Number(info.size),
        })),
        Effect.catch(() => Effect.succeed(undefined)),
      )

    const prepareIndex = Effect.fnUntraced(function* (current: State) {
      const file = indexLock(current)
      const first = yield* lockStat(file)
      if (!first) return true
      if (Date.now() - first.mtime <= 60_000) {
        yield* Effect.logWarning("preserving fresh snapshot index lock", { gitdir: current.gitdir, file })
        return false
      }
      const second = yield* lockStat(file)
      if (!second || second.mtime !== first.mtime || second.size !== first.size) return false
      const removed = yield* fs.remove(file).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)))
      if (!removed || (yield* lockStat(file))) {
        yield* Effect.logWarning("failed to recover snapshot index lock", { gitdir: current.gitdir, file })
        return false
      }
      return true
    })

    const withSnapshotLock = <A>(current: State, fallback: A, body: Effect.Effect<A>) =>
      effectFlock.withLock(
        current.gitdir,
      )(
        lock(current.gitdir).withPermits(1)(
          Effect.gen(function* () {
            if (!(yield* prepareIndex(current))) return fallback
            return yield* body
          }),
        ),
      ).pipe(
        Effect.catchTags({
          LockTimeoutError: (error) =>
            Effect.logWarning("snapshot cross-process lock timed out", { gitdir: current.gitdir, key: error.key }).pipe(Effect.as(fallback)),
          LockCompromisedError: (error) =>
            Effect.logWarning("snapshot cross-process lock was compromised", { gitdir: current.gitdir, detail: error.detail }).pipe(Effect.as(fallback)),
        }),
      )

    const state = Effect.fnUntraced(function* (location: Location.Ref) {
      const cached = states.get(location.directory)
      if (cached) return cached
      const repo = yield* git.find(location.directory)
      if (!repo) return undefined
      const current = {
        directory: location.directory,
        worktree: repo.directory,
        gitdir: path.join(global.data, "snapshot", Hash.fast(repo.directory)),
      } satisfies State
      states.set(location.directory, current)
      return current
    })

    const args = (state: State, cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

    const runOnce = Effect.fnUntraced(function* (
      state: State,
      cmd: string[],
      options?: { readonly cwd?: string; readonly env?: Record<string, string>; readonly stdin?: string },
    ) {
      const result = yield* appProcess
        .run(
          ChildProcess.make("git", cmd, {
            cwd: options?.cwd ?? state.directory,
            env: options?.env,
            extendEnv: true,
          }),
          { stdin: options?.stdin },
        )
        .pipe(
          Effect.catch((error) =>
            Effect.succeed({
              exitCode: error.exitCode ?? 1,
              stdout: Buffer.alloc(0),
              stderr: Buffer.from(error.stderr ?? String(error.cause ?? error.command)),
            }),
          ),
        )
      return {
        code: result.exitCode,
        text: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      } satisfies GitResult
    })

    const run = Effect.fnUntraced(function* (
      state: State,
      cmd: string[],
      options?: { readonly cwd?: string; readonly env?: Record<string, string>; readonly stdin?: string },
    ) {
      const result = yield* runOnce(state, cmd, options)
      if (result.code === 0 || !result.stderr.toLowerCase().includes("index.lock")) return result
      if (!(yield* prepareIndex(state))) return result
      return yield* runOnce(state, cmd, options)
    })

    const initialize = Effect.fnUntraced(function* (state: State) {
      if (yield* exists(state.gitdir)) {
        const validation = yield* run(state, [...core, ...args(state, ["rev-parse", "--git-dir"])])
        if (validation.code === 0) return true
        yield* Effect.logWarning("reinitializing partial snapshot repository", {
          worktree: state.worktree,
          gitdir: state.gitdir,
          exitCode: validation.code,
          stderr: validation.stderr,
        })
      }
      yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
      const initialized = yield* run(state, ["init"], {
        env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
      })
      if (initialized.code !== 0) {
        yield* Effect.logWarning("failed to initialize snapshot repository", {
          worktree: state.worktree,
          gitdir: state.gitdir,
          exitCode: initialized.code,
          stderr: initialized.stderr,
        })
        return false
      }
      const configured = yield* Effect.all(
        [
          ["core.autocrlf", "false"],
          ["core.longpaths", "true"],
          ["core.symlinks", "true"],
          ["core.fsmonitor", "false"],
        ].map(([key, value]) => run(state, ["--git-dir", state.gitdir, "config", key, value])),
        { concurrency: 1 },
      )
      const failed = configured.find((result) => result.code !== 0)
      if (!failed) return true
      yield* Effect.logWarning("failed to configure snapshot repository", {
        worktree: state.worktree,
        gitdir: state.gitdir,
        exitCode: failed.code,
        stderr: failed.stderr,
      })
      return false
    })

    const add = Effect.fnUntraced(function* (state: State) {
      const result = yield* run(state, [...cfg, ...args(state, ["add", "--all", "--sparse", "--", "."])])
      if (result.code === 0) return
      yield* Effect.logWarning("failed to add snapshot files", { exitCode: result.code, stderr: result.stderr })
    })

    const track = Effect.fn("Snapshot.track")(function* (location: Location.Ref) {
      const current = yield* state(location)
      if (!current) return undefined
      return yield* withSnapshotLock(current, undefined,
        Effect.gen(function* () {
          if (!(yield* initialize(current))) return undefined
          yield* touch(current)
          yield* add(current)
          const result = yield* run(current, [...cfg, ...args(current, ["write-tree"])])
          if (result.code !== 0) {
            yield* Effect.logWarning("failed to write snapshot tree", { exitCode: result.code, stderr: result.stderr })
            return undefined
          }
          return result.text.trim() || undefined
        }),
      )
    })

    const changedFiles = Effect.fn("Snapshot.changedFiles")(function* (input: {
      readonly location: Location.Ref
      readonly from: string
      readonly to: string
    }) {
      const current = yield* state(input.location)
      if (!current) return []
      return yield* withSnapshotLock(current, [],
        Effect.gen(function* () {
          if (!(yield* initialize(current))) return []
          yield* touch(current)
          const result = yield* run(current, [
            ...quote,
            ...args(current, ["diff", "--name-only", "-z", "--no-ext-diff", input.from, input.to, "--", "."]),
          ])
          if (result.code !== 0) return []
          return result.text
            .split("\0")
            .filter(Boolean)
            .map((file) => path.join(current.worktree, file).replaceAll("\\", "/"))
        }),
      )
    })

    const patch = Effect.fn("Snapshot.patch")(function* (input: { readonly location: Location.Ref; readonly hash: string }) {
      const current = yield* state(input.location)
      if (!current) return { hash: input.hash, files: [] }
      return yield* withSnapshotLock(current, { hash: input.hash, files: [] },
        Effect.gen(function* () {
          if (!(yield* initialize(current))) return { hash: input.hash, files: [] }
          yield* touch(current)
          yield* add(current)
          const result = yield* run(current, [
            ...quote,
            ...args(current, ["diff", "--cached", "--no-ext-diff", "--name-only", "-z", input.hash, "--", "."]),
          ])
          if (result.code !== 0) return { hash: input.hash, files: [] }
          return {
            hash: input.hash,
            files: result.text
              .split("\0")
              .filter(Boolean)
              .map((file) => path.join(current.worktree, file).replaceAll("\\", "/")),
          }
        }),
      )
    })

    const restore = Effect.fn("Snapshot.restore")(function* (input: { readonly location: Location.Ref; readonly snapshot: string }) {
      const current = yield* state(input.location)
      if (!current) return
      yield* withSnapshotLock(current, undefined,
        Effect.gen(function* () {
          if (!(yield* initialize(current))) return
          yield* touch(current)
          yield* add(current)
          const tracked = yield* run(current, [...quote, ...args(current, ["ls-files", "-z"])], { cwd: current.worktree })
          const target = yield* run(current, [...quote, ...args(current, ["ls-tree", "-r", "--name-only", "-z", input.snapshot])], {
            cwd: current.worktree,
          })
          const readTree = yield* run(current, [...core, ...args(current, ["read-tree", input.snapshot])], {
            cwd: current.worktree,
          })
          if (readTree.code !== 0) {
            yield* Effect.logWarning("failed to read snapshot tree", {
              snapshot: input.snapshot,
              exitCode: readTree.code,
              stderr: readTree.stderr,
            })
            return
          }
          const checkout = yield* run(current, [...core, ...args(current, ["checkout-index", "-a", "-f"])], {
            cwd: current.worktree,
          })
          if (tracked.code === 0 && target.code === 0) {
            const targetFiles = new Set(target.text.split("\0").filter(Boolean))
            yield* Effect.forEach(
              tracked.text.split("\0").filter((file) => file && !targetFiles.has(file)),
              (file) => remove(path.join(current.worktree, file)),
              { discard: true },
            )
          }
          if (checkout.code === 0) return
          yield* Effect.logWarning("failed to restore snapshot", {
            snapshot: input.snapshot,
            exitCode: checkout.code,
            stderr: checkout.stderr,
          })
        }),
      )
    })

    const revert = Effect.fn("Snapshot.revert")(function* (input: {
      readonly location: Location.Ref
      readonly patches: RevertPatch[]
    }) {
      const current = yield* state(input.location)
      if (!current) return
      yield* withSnapshotLock(current, undefined,
        Effect.gen(function* () {
          if (!(yield* initialize(current))) return
          yield* touch(current)
          const operations = input.patches.flatMap((item) =>
            item.files.map((file) => ({
              hash: item.hash,
              after: item.after,
              file,
              rel: path.relative(current.worktree, file).replaceAll("\\", "/"),
            })),
          )
          const seen = new Map<string, (typeof operations)[number]>()
          const deduped = operations.filter((operation) => {
            const existing = seen.get(operation.file)
            if (existing) {
              if (operation.after) existing.after = operation.after
              return false
            }
            seen.set(operation.file, operation)
            return true
          })

          const treeText = Effect.fnUntraced(function* (hash: string, rel: string) {
            const result = yield* run(current, [...core, ...args(current, ["show", `${hash}:${rel}`])], {
              cwd: current.worktree,
            })
            return result.code === 0 ? result.text : undefined
          })

          const reverseApply = Effect.fnUntraced(function* (operation: (typeof deduped)[number]) {
            if (!operation.after) return false
            const patch = yield* run(
              current,
              [
                ...quote,
                ...args(current, ["diff", "--binary", "--no-ext-diff", operation.hash, operation.after, "--", operation.rel]),
              ],
              { cwd: current.worktree },
            )
            if (patch.code !== 0 || !patch.text.trim()) return false
            const applied = yield* run(current, [...core, "apply", "--reverse", "--binary", "--whitespace=nowarn", "-"], {
              cwd: current.worktree,
              stdin: patch.text,
            })
            return applied.code === 0
          })

          const mergeText = Effect.fnUntraced(function* (
            operation: (typeof deduped)[number],
            base: string,
            other: string,
          ) {
            const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
            const baseFile = path.join(current.gitdir, `opencode-revert-base-${nonce}`)
            const otherFile = path.join(current.gitdir, `opencode-revert-other-${nonce}`)
            return yield* Effect.acquireUseRelease(
              Effect.gen(function* () {
                yield* fs.writeFileString(baseFile, base).pipe(Effect.orDie)
                yield* fs.writeFileString(otherFile, other).pipe(Effect.orDie)
                return { baseFile, otherFile }
              }),
              (files) =>
                run(current, [...core, "merge-file", "-p", "--diff3", operation.file, files.baseFile, files.otherFile], {
                  cwd: current.worktree,
                }),
              (files) => Effect.all([remove(files.baseFile), remove(files.otherFile)], { discard: true, concurrency: 2 }),
            ).pipe(Effect.map((result) => (result.code === 0 || result.code === 1 ? result.text : undefined)))
          })

          const canMergeText = (value: string | undefined): value is string =>
            value !== undefined && !value.includes("\0") && !value.includes("\uFFFD")

          const mergedRevert = Effect.fnUntraced(function* (operation: (typeof deduped)[number]) {
            if (!operation.after) return false
            const before = yield* treeText(operation.hash, operation.rel)
            const after = yield* treeText(operation.after, operation.rel)
            const currentText = yield* read(operation.file)
            if (before === undefined && after === undefined) return false
            if (canMergeText(before) && canMergeText(after) && canMergeText(currentText) && after && currentText.includes(after)) {
              const index = currentText.indexOf(after)
              yield* fs
                .writeWithDirs(operation.file, currentText.slice(0, index) + before + currentText.slice(index + after.length))
                .pipe(Effect.orDie)
              return true
            }
            if (yield* reverseApply(operation)) return true
            if (before === undefined) {
              if (currentText === undefined) return true
              if (currentText === after) yield* remove(operation.file)
              return true
            }
            if (after === undefined) {
              if (!canMergeText(before) || (currentText !== undefined && !canMergeText(currentText))) return false
              if (currentText === undefined) {
                yield* fs.writeWithDirs(operation.file, before).pipe(Effect.orDie)
                return true
              }
              const merged = yield* mergeText(operation, "", before)
              if (merged === undefined) return false
              yield* fs.writeWithDirs(operation.file, merged).pipe(Effect.orDie)
              return true
            }
            if (currentText === undefined) return true
            if (!canMergeText(before) || !canMergeText(after) || !canMergeText(currentText)) return false
            if (currentText === after) {
              yield* fs.writeWithDirs(operation.file, before).pipe(Effect.orDie)
              return true
            }
            const merged = yield* mergeText(operation, after, before)
            if (merged === undefined) return false
            yield* fs.writeWithDirs(operation.file, merged).pipe(Effect.orDie)
            return true
          })

          yield* Effect.forEach(
            deduped,
            Effect.fnUntraced(function* (operation) {
              if (yield* mergedRevert(operation)) return
              const checkout = yield* run(current, [...core, ...args(current, ["checkout", operation.hash, "--", operation.rel])], {
                cwd: current.worktree,
              })
              if (checkout.code === 0) return
              const tree = yield* run(current, [...core, ...args(current, ["ls-tree", operation.hash, "--", operation.rel])], {
                cwd: current.worktree,
              })
              if (tree.code === 0 && tree.text.trim()) return
              yield* remove(operation.file)
            }),
            { discard: true },
          )
        }),
      )
    })

    const diff = Effect.fn("Snapshot.diff")(function* (input: { readonly location: Location.Ref; readonly hash: string }) {
      const current = yield* state(input.location)
      if (!current) return undefined
      return yield* withSnapshotLock(current, undefined,
        Effect.gen(function* () {
          if (!(yield* initialize(current))) return undefined
          yield* touch(current)
          yield* add(current)
          const result = yield* run(current, [
            ...quote,
            ...args(current, ["diff", "--cached", "--no-ext-diff", input.hash, "--", "."]),
          ])
          if (result.code !== 0) return undefined
          return result.text.trim() || undefined
        }),
      )
    })

    const diffFull = Effect.fn("Snapshot.diffFull")(function* (input: {
      readonly location: Location.Ref
      readonly from: string
      readonly to: string
    }) {
      if (input.from === input.to) return []
      const current = yield* state(input.location)
      if (!current) return []
      return yield* withSnapshotLock(current, [],
        Effect.gen(function* () {
          if (!(yield* initialize(current))) return []
          yield* touch(current)
          const statuses = yield* run(current, [
            ...quote,
            ...args(current, ["diff", "--no-ext-diff", "--name-status", "--no-renames", input.from, input.to, "--", "."]),
          ])
          const status = new Map<string, "added" | "deleted" | "modified">()
          for (const line of statuses.text.trim().split("\n")) {
            if (!line) continue
            const [code, file] = line.split("\t")
            if (!code || !file) continue
            status.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified")
          }

          const numstat = yield* run(current, [
            ...quote,
            ...args(current, ["diff", "--no-ext-diff", "--no-renames", "--numstat", input.from, input.to, "--", "."]),
          ])
          if (numstat.code !== 0) return []
          const patch = yield* run(current, [
            ...quote,
            ...args(current, ["diff", "--no-ext-diff", "--no-renames", input.from, input.to, "--", "."]),
          ])
          const patches = splitDiffPatch(patch.code === 0 ? patch.text : "")
          return numstat.text
            .trim()
            .split("\n")
            .filter(Boolean)
            .flatMap((line, index) => {
              const [adds, dels, file] = line.split("\t")
              if (!file) return []
              const binary = adds === "-" && dels === "-"
              const additions = binary ? 0 : Number.parseInt(adds, 10)
              const deletions = binary ? 0 : Number.parseInt(dels, 10)
              return [
                {
                  file,
                  patch: patches.find((item) => patchMatchesFile(item, file)) ?? patches[index] ?? "",
                  additions: Number.isFinite(additions) ? additions : 0,
                  deletions: Number.isFinite(deletions) ? deletions : 0,
                  status: status.get(file) ?? "modified",
                } satisfies FileDiff,
              ]
            })
        }),
      )
    })

    return Service.of({ track, changedFiles, patch, restore, revert, diff, diffFull })
  }),
)

function splitDiffPatch(input: string) {
  return input
    .split(/(?=^diff --git )/m)
    .map((item) => item.trim())
    .filter(Boolean)
}

function patchMatchesFile(patch: string, file: string) {
  return patch.startsWith(`diff --git a/${file} b/${file}\n`) || patch.includes(`\n+++ b/${file}\n`)
}

export const defaultLayer = layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(Global.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
)

export const node = LayerNode.make(layer, [Global.node, FSUtil.node, Git.node, AppProcess.node, EffectFlock.node])
