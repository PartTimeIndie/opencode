export * as FileMutation from "./file-mutation"

import { Context, Effect, Layer, Schema } from "effect"
import { createHash, randomUUID } from "crypto"
import { dirname } from "path"
import { KeyedMutex } from "./effect/keyed-mutex"
import { FSUtil } from "./fs-util"
import { EffectFlock } from "./util/effect-flock"

export interface Target {
  readonly canonical: string
  readonly resource: string
}

export interface WriteInput {
  readonly target: Target
  readonly content: string | Uint8Array
}

export interface TextWriteInput {
  readonly target: Target
  readonly content: string
}

export interface ConditionalWriteInput extends WriteInput {
  readonly expected: Uint8Array
}

export interface RemoveInput {
  readonly target: Target
}

export type ExpectedState = { readonly exists: false } | { readonly exists: true; readonly sha256: string }

export interface GuardedWriteInput extends WriteInput {
  readonly expected: ExpectedState
}

export interface GuardedRemoveInput extends RemoveInput {
  readonly expected: Extract<ExpectedState, { readonly exists: true }>
}

export type TransactionChange =
  | { readonly type: "add"; readonly target: Target; readonly content: string | Uint8Array }
  | {
      readonly type: "update"
      readonly target: Target
      readonly content: string | Uint8Array
      readonly expected: Extract<ExpectedState, { readonly exists: true }>
    }
  | {
      readonly type: "delete"
      readonly target: Target
      readonly expected: Extract<ExpectedState, { readonly exists: true }>
    }

// Checkpoints are model-visible tool output, so they intentionally carry metadata rather than file bytes.
export const CheckpointState = Schema.Struct({
  exists: Schema.Boolean,
  bytes: Schema.Number.pipe(Schema.optional),
  sha256: Schema.String.pipe(Schema.optional),
})
export type CheckpointState = typeof CheckpointState.Type

export const Checkpoint = Schema.Struct({
  target: Schema.String,
  resource: Schema.String,
  before: CheckpointState,
  after: CheckpointState,
})
export type Checkpoint = typeof Checkpoint.Type

export interface ContentState extends CheckpointState {
  readonly content?: Uint8Array
}

export interface RecordedMutation {
  readonly target: string
  readonly resource: string
  readonly before: ContentState
  readonly after: ContentState
}

export class StaleContentError extends Schema.TaggedErrorClass<StaleContentError>()("FileMutation.StaleContentError", {
  path: Schema.String,
  sha256: Schema.String.pipe(Schema.optional),
}) {}

export class TargetExistsError extends Schema.TaggedErrorClass<TargetExistsError>()("FileMutation.TargetExistsError", {
  path: Schema.String,
}) {}

export class TransactionRollbackError extends Schema.TaggedErrorClass<TransactionRollbackError>()(
  "FileMutation.TransactionRollbackError",
  { path: Schema.String, paths: Schema.optional(Schema.Array(Schema.String)) },
) {}

export interface WriteResult {
  readonly operation: "write"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
  readonly checkpoint: Checkpoint
  readonly mutation: RecordedMutation
}

export interface RemoveResult {
  readonly operation: "remove"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
  readonly checkpoint: Checkpoint
  readonly mutation: RecordedMutation
}

export interface TransactionHooks<E> {
  readonly before?: Effect.Effect<void, E>
  readonly committed?: (results: ReadonlyArray<WriteResult | RemoveResult>) => Effect.Effect<void, E>
  readonly rolledBack?: Effect.Effect<void, E>
}

export interface Interface {
  /** Create without replacing an existing target. */
  readonly create: (
    input: WriteInput,
  ) => Effect.Effect<WriteResult, TargetExistsError | EffectFlock.LockError | FSUtil.Error>
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, EffectFlock.LockError | FSUtil.Error>
  /** Write text while retaining an existing UTF-8 BOM and emitting at most one BOM. */
  readonly writeTextPreservingBom: (
    input: TextWriteInput,
  ) => Effect.Effect<WriteResult, EffectFlock.LockError | FSUtil.Error>
  /** Commit only if an existing target still has the expected bytes. */
  readonly writeIfUnchanged: (
    input: ConditionalWriteInput,
  ) => Effect.Effect<WriteResult, StaleContentError | EffectFlock.LockError | FSUtil.Error>
  readonly writeGuarded: (
    input: GuardedWriteInput,
  ) => Effect.Effect<WriteResult, StaleContentError | TargetExistsError | EffectFlock.LockError | FSUtil.Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<RemoveResult, EffectFlock.LockError | FSUtil.Error>
  readonly removeGuarded: (
    input: GuardedRemoveInput,
  ) => Effect.Effect<RemoveResult, StaleContentError | TargetExistsError | EffectFlock.LockError | FSUtil.Error>
  readonly transact: <E = never>(
    changes: readonly TransactionChange[],
    hooks?: TransactionHooks<E>,
  ) => Effect.Effect<
    ReadonlyArray<WriteResult | RemoveResult>,
    E | StaleContentError | TargetExistsError | TransactionRollbackError | EffectFlock.LockError | FSUtil.Error
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileMutation") {}

/**
 * Serialize file changes by canonical target. Conditional writes compare and
 * write under the same process-local lock so cooperating OpenCode mutations do
 * not overwrite changes made from the same stale content.
 */
const baseLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const withTargetLocks =
      (targets: readonly Target[]) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | EffectFlock.LockError, R> => {
        const ordered = [...new Map(targets.map((target) => [target.canonical, target])).values()].toSorted(
          (left, right) => (left.canonical < right.canonical ? -1 : left.canonical > right.canonical ? 1 : 0),
        )
        const acquire = (index: number): Effect.Effect<A, E | EffectFlock.LockError, R> => {
          const target = ordered[index]
          if (!target) return Effect.uninterruptible(effect)
          return locks.withLock(target.canonical)(
            flock.withLock(acquire(index + 1), `file-mutation:${target.canonical}`),
          )
        }
        return acquire(0)
      }
    const withTargetLock = (target: Target) => withTargetLocks([target])

    const contentState = (content: Uint8Array): ContentState => ({
      exists: true,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      content,
    })

    const fileState = (target: Target): Effect.Effect<ContentState, FSUtil.Error> =>
      fs.readFile(target.canonical).pipe(
        Effect.map(contentState),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed({ exists: false } satisfies ContentState)),
      )

    const requireExpected = (
      target: Target,
      expected: ExpectedState,
      actual: ContentState,
    ): Effect.Effect<ContentState, StaleContentError | TargetExistsError> => {
      if (!expected.exists)
        return actual.exists ? Effect.fail(new TargetExistsError({ path: target.canonical })) : Effect.succeed(actual)
      if (!actual.exists || actual.sha256 !== expected.sha256)
        return Effect.fail(new StaleContentError({ path: target.canonical, sha256: actual.sha256 }))
      return Effect.succeed(actual)
    }

    const atomicReplace = Effect.fn("FileMutation.atomicReplace")(function* (
      target: Target,
      content: string | Uint8Array,
    ) {
      yield* fs.ensureDir(dirname(target.canonical))
      const staged = `${target.canonical}.opencode-stage-${randomUUID()}`
      yield* typeof content === "string"
        ? fs.writeFileString(staged, content, { flag: "wx" })
        : fs.writeFile(staged, content, { flag: "wx" })
      yield* fs.rename(staged, target.canonical).pipe(Effect.ensuring(fs.remove(staged).pipe(Effect.ignore)))
    })

    const checkpointState = (state: ContentState): CheckpointState =>
      state.exists ? { exists: true, bytes: state.bytes, sha256: state.sha256 } : { exists: false }

    const checkpoint = (target: Target, before: ContentState, after: ContentState): Checkpoint => ({
      target: target.canonical,
      resource: target.resource,
      before: checkpointState(before),
      after: checkpointState(after),
    })

    const mutation = (target: Target, before: ContentState, after: ContentState): RecordedMutation => ({
      target: target.canonical,
      resource: target.resource,
      before,
      after,
    })

    const writeResult = (target: Target, before: ContentState, after: ContentState): WriteResult => ({
      operation: "write",
      target: target.canonical,
      resource: target.resource,
      existed: before.exists,
      checkpoint: checkpoint(target, before, after),
      mutation: mutation(target, before, after),
    })

    const removeResult = (target: Target, before: ContentState, after: ContentState): RemoveResult => ({
      operation: "remove",
      target: target.canonical,
      resource: target.resource,
      existed: before.exists,
      checkpoint: checkpoint(target, before, after),
      mutation: mutation(target, before, after),
    })

    const write = Effect.fn("FileMutation.write")((input: WriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const before = yield* fileState(input.target)
          yield* fs.writeWithDirs(input.target.canonical, input.content)
          return writeResult(input.target, before, yield* fileState(input.target))
        }),
      ),
    )

    const writeTextPreservingBom = Effect.fn("FileMutation.writeTextPreservingBom")((input: TextWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const next = splitBom(input.content)
          const current = yield* fs
            .readFile(input.target.canonical)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
          const before: ContentState = current ? contentState(current) : { exists: false }
          yield* fs.writeWithDirs(
            input.target.canonical,
            joinBom(next.text, Boolean(current && hasUtf8Bom(current)) || next.bom),
          )
          return writeResult(input.target, before, yield* fileState(input.target))
        }),
      ),
    )

    const create = Effect.fn("FileMutation.create")((input: WriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const before = yield* fileState(input.target)
          const write =
            typeof input.content === "string"
              ? fs.writeFileString(input.target.canonical, input.content, { flag: "wx" })
              : fs.writeFile(input.target.canonical, input.content, { flag: "wx" })
          yield* write.pipe(
            Effect.catchReason("PlatformError", "NotFound", () =>
              fs.ensureDir(dirname(input.target.canonical)).pipe(Effect.andThen(write)),
            ),
            Effect.catchReason("PlatformError", "AlreadyExists", () =>
              Effect.fail(new TargetExistsError({ path: input.target.canonical })),
            ),
          )
          return writeResult(input.target, before, yield* fileState(input.target))
        }),
      ),
    )

    const writeIfUnchanged = Effect.fn("FileMutation.writeIfUnchanged")((input: ConditionalWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const current = yield* fs.readFile(input.target.canonical)
          if (!sameBytes(current, input.expected)) {
            return yield* new StaleContentError({ path: input.target.canonical })
          }
          const before = contentState(current)
          yield* typeof input.content === "string"
            ? fs.writeFileString(input.target.canonical, input.content)
            : fs.writeFile(input.target.canonical, input.content)
          return writeResult(input.target, before, yield* fileState(input.target))
        }),
      ),
    )

    const writeGuarded = Effect.fn("FileMutation.writeGuarded")((input: GuardedWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const before = yield* fileState(input.target)
          yield* requireExpected(input.target, input.expected, before)
          const next =
            typeof input.content === "string"
              ? joinBom(
                  splitBom(input.content).text,
                  splitBom(input.content).bom || Boolean(before.content && hasUtf8Bom(before.content)),
                )
              : input.content
          if (!input.expected.exists) {
            const write =
              typeof next === "string"
                ? fs.writeFileString(input.target.canonical, next, { flag: "wx" })
                : fs.writeFile(input.target.canonical, next, { flag: "wx" })
            yield* write.pipe(
              Effect.catchReason("PlatformError", "NotFound", () =>
                fs.ensureDir(dirname(input.target.canonical)).pipe(Effect.andThen(write)),
              ),
              Effect.catchReason("PlatformError", "AlreadyExists", () =>
                Effect.fail(new TargetExistsError({ path: input.target.canonical })),
              ),
            )
          } else yield* atomicReplace(input.target, next)
          return writeResult(input.target, before, yield* fileState(input.target))
        }),
      ),
    )

    const remove = Effect.fn("FileMutation.remove")((input: RemoveInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const before = yield* fileState(input.target)
          const existed = yield* fs.remove(input.target.canonical).pipe(
            Effect.as(true),
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
          )
          const after = yield* fileState(input.target)
          return removeResult(input.target, existed ? before : { exists: false }, after)
        }),
      ),
    )

    const removeGuarded = Effect.fn("FileMutation.removeGuarded")((input: GuardedRemoveInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const before = yield* fileState(input.target)
          yield* requireExpected(input.target, input.expected, before)
          yield* fs.remove(input.target.canonical)
          return removeResult(input.target, before, yield* fileState(input.target))
        }),
      ),
    )

    const transact = <E = never>(changes: readonly TransactionChange[], hooks?: TransactionHooks<E>) =>
      withTargetLocks(changes.map((change) => change.target))(
        Effect.gen(function* () {
          const states = yield* Effect.forEach(changes, (change) => fileState(change.target))
          yield* Effect.forEach(
            changes,
            (change, index) =>
              requireExpected(
                change.target,
                change.type === "add" ? { exists: false } : change.expected,
                states[index] ?? { exists: false },
              ),
            { discard: true },
          )

          if (hooks?.before) yield* hooks.before
          const applied: Array<{
            readonly change: TransactionChange
            readonly before: ContentState
            readonly expected: ExpectedState
          }> = []
          let uncertain: string | undefined
          const commit = Effect.forEach(
            changes,
            (change, index) =>
              Effect.gen(function* () {
                const before = states[index] ?? { exists: false }
                if (change.type === "add") {
                  const write =
                    typeof change.content === "string"
                      ? fs.writeFileString(change.target.canonical, change.content, { flag: "wx" })
                      : fs.writeFile(change.target.canonical, change.content, { flag: "wx" })
                  yield* write.pipe(
                    Effect.catchReason("PlatformError", "NotFound", () =>
                      fs.ensureDir(dirname(change.target.canonical)).pipe(Effect.andThen(write)),
                    ),
                    Effect.catchReason("PlatformError", "AlreadyExists", () =>
                      Effect.fail(new TargetExistsError({ path: change.target.canonical })),
                    ),
                  )
                  applied.push({
                    change,
                    before,
                    expected: {
                      exists: true,
                      sha256: contentState(
                        typeof change.content === "string" ? new TextEncoder().encode(change.content) : change.content,
                      ).sha256!,
                    },
                  })
                  return writeResult(change.target, before, yield* fileState(change.target))
                }
                if (change.type === "delete") {
                  yield* fs.remove(change.target.canonical)
                  applied.push({ change, before, expected: { exists: false } })
                  return removeResult(change.target, before, yield* fileState(change.target))
                }
                yield* atomicReplace(change.target, change.content)
                applied.push({
                  change,
                  before,
                  expected: {
                    exists: true,
                    sha256: contentState(
                      typeof change.content === "string" ? new TextEncoder().encode(change.content) : change.content,
                    ).sha256!,
                  },
                })
                return writeResult(change.target, before, yield* fileState(change.target))
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    // A failed syscall can already have changed bytes (notably an
                    // exclusive create). Never clear uncertainty for that target.
                    if (!applied.some((item) => item.change === change)) {
                      const current = yield* fileState(change.target).pipe(
                        Effect.catchCause(() => Effect.succeed(undefined)),
                      )
                      const before = states[index] ?? { exists: false }
                      if (!current || current.exists !== before.exists || current.sha256 !== before.sha256)
                        uncertain = change.target.canonical
                    }
                    return yield* Effect.failCause(cause)
                  }),
                ),
              ),
            { concurrency: 1 },
          )

          const results = yield* commit.pipe(
            Effect.catchCause((cause) =>
              Effect.forEach(
                applied.toReversed(),
                (item) =>
                  Effect.gen(function* () {
                    // A rollback is another write: never replace an intervening
                    // external change with our older before-image.
                    yield* requireExpected(item.change.target, item.expected, yield* fileState(item.change.target))
                    yield* item.before.exists && item.before.content
                      ? atomicReplace(item.change.target, item.before.content)
                      : fs
                          .remove(item.change.target.canonical)
                          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void))
                  }).pipe(
                    Effect.catchCause(() =>
                      Effect.fail(
                        new TransactionRollbackError({
                          path: item.change.target.canonical,
                          paths: changes.map((change) => change.target.canonical),
                        }),
                      ),
                    ),
                  ),
                { discard: true, concurrency: 1 },
              ).pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    uncertain
                      ? Effect.fail(
                          new TransactionRollbackError({
                            path: uncertain,
                            paths: changes.map((change) => change.target.canonical),
                          }),
                        )
                      : Effect.void,
                  ),
                ),
                Effect.andThen(hooks?.rolledBack ?? Effect.void),
                Effect.andThen(Effect.failCause(cause)),
              ),
            ),
          )
          if (hooks?.committed) yield* hooks.committed(results)
          return results
        }),
      )

    return Service.of({
      create,
      write,
      writeTextPreservingBom,
      writeIfUnchanged,
      writeGuarded,
      remove,
      removeGuarded,
      transact,
    })
  }),
)

export const layer = baseLayer.pipe(Layer.provide(EffectFlock.defaultLayer))

function splitBom(text: string) {
  const stripped = text.replace(/^\uFEFF+/, "")
  return { bom: stripped.length !== text.length, text: stripped }
}

function joinBom(text: string, bom: boolean) {
  const stripped = splitBom(text).text
  return bom ? `\uFEFF${stripped}` : stripped
}

function hasUtf8Bom(content: Uint8Array) {
  return content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  return left.every((byte, index) => byte === right[index])
}

export const locationLayer = layer

/**
 * Deferred until the corresponding V2 integrations exist.
 */
// TODO: Add formatter integration after V2 formatter runtime exists.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after V2 snapshot design exists.
// TODO: Notify LSP and collect diagnostics after V2 LSP runtime exists.
// TODO: Design multi-file transactions / rollback if apply_patch needs atomic edits.
// Until then, edits are sequential and report partial application.
// TODO: Define crash recovery and idempotency for side effects between Tool.Called and durable settlement.
