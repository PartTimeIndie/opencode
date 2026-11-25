import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

function provide(directory: string, filesystem = FSUtil.defaultLayer) {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  const resolution = LocationMutation.layer.pipe(Layer.provide(filesystem), Layer.provide(activeLocation))
  const mutation = FileMutation.layer.pipe(Layer.provide(filesystem))
  return Effect.provide(Layer.mergeAll(resolution, mutation))
}

function withTmp<A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

describe("FileMutation", () => {
  it.live("rejects a stale mode before any transaction target changes", () =>
    withTmp((directory) => Effect.gen(function* () {
      const first = { canonical: path.join(directory, "first.txt"), resource: "first.txt" }
      const second = { canonical: path.join(directory, "second.txt"), resource: "second.txt" }
      yield* Effect.promise(() => Promise.all([fs.writeFile(first.canonical, "first"), fs.writeFile(second.canonical, "second")]))
      const actualMode = (yield* Effect.promise(() => fs.stat(second.canonical))).mode & 0o777
      const result = yield* (yield* FileMutation.Service).transact([
        { type: "update", target: first, content: "changed", expected: { exists: true, sha256: sha256("first") } },
        { type: "delete", target: second, expected: { exists: true, sha256: sha256("second"), mode: actualMode ^ 0o200 } },
      ]).pipe(Effect.flip)
      expect(result).toMatchObject({ _tag: "FileMutation.StaleContentError", path: second.canonical })
      expect(yield* Effect.promise(() => fs.readFile(first.canonical, "utf8"))).toBe("first")
      expect(yield* Effect.promise(() => fs.readFile(second.canonical, "utf8"))).toBe("second")
    }).pipe(provide(directory))),
  )

  it.live("retains observed modes in guarded replacements and checkpoints", () =>
    withTmp((directory) => Effect.gen(function* () {
      const target = { canonical: path.join(directory, "mode.txt"), resource: "mode.txt" }
      yield* Effect.promise(() => fs.writeFile(target.canonical, "before"))
      yield* Effect.promise(() => fs.chmod(target.canonical, 0o666))
      const mode = (yield* Effect.promise(() => fs.stat(target.canonical))).mode & 0o777
      const result = yield* (yield* FileMutation.Service).transact([
        { type: "update", target, content: "after", expected: { exists: true, sha256: sha256("before"), mode } },
      ])
      expect((yield* Effect.promise(() => fs.stat(target.canonical))).mode & 0o777).toBe(mode)
      expect(result[0]?.checkpoint).toMatchObject({ before: { mode }, after: { mode } })
      expect(result[0]?.mutation).toMatchObject({ before: { mode }, after: { mode } })
    }).pipe(provide(directory))),
  )

  it.live("applies explicit transaction modes before reporting success", () =>
    withTmp((directory) => Effect.gen(function* () {
      const target = { canonical: path.join(directory, "readonly.txt"), resource: "readonly.txt" }
      const result = yield* (yield* FileMutation.Service).transact([{ type: "add", target, content: "created", mode: 0o444 }])
      expect((yield* Effect.promise(() => fs.stat(target.canonical))).mode & 0o777).toBe(0o444)
      expect(result[0]?.checkpoint.after).toMatchObject({ exists: true, mode: 0o444 })
    }).pipe(provide(directory))),
  )

  it.live("rolls journal-commit failure back with the original bytes and mode", () =>
    withTmp((directory) => Effect.gen(function* () {
      const target = { canonical: path.join(directory, "rollback-mode.txt"), resource: "rollback-mode.txt" }
      yield* Effect.promise(() => fs.writeFile(target.canonical, "before"))
      yield* Effect.promise(() => fs.chmod(target.canonical, 0o666))
      const mode = (yield* Effect.promise(() => fs.stat(target.canonical))).mode & 0o777
      const error = yield* (yield* FileMutation.Service).transact([
        { type: "update", target, content: "after", expected: { exists: true, sha256: sha256("before"), mode } },
      ], { journal: () => Effect.fail("journal unavailable") }).pipe(Effect.flip)
      expect(error).toBe("journal unavailable")
      expect(yield* Effect.promise(() => fs.readFile(target.canonical, "utf8"))).toBe("before")
      expect((yield* Effect.promise(() => fs.stat(target.canonical))).mode & 0o777).toBe(mode)
    }).pipe(provide(directory))),
  )

  it.live("does not roll back over an external mode-only edit after commit", () =>
    withTmp((directory) => Effect.gen(function* () {
      const target = { canonical: path.join(directory, "foreign-mode.txt"), resource: "foreign-mode.txt" }
      yield* Effect.promise(() => fs.writeFile(target.canonical, "before"))
      const error = yield* (yield* FileMutation.Service).transact([
        { type: "update", target, content: "after", expected: { exists: true, sha256: sha256("before") } },
      ], { journal: () => Effect.promise(() => fs.chmod(target.canonical, 0o444)).pipe(Effect.andThen(Effect.fail("journal unavailable"))) }).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "FileMutation.TransactionRollbackError", path: target.canonical })
      expect(yield* Effect.promise(() => fs.readFile(target.canonical, "utf8"))).toBe("after")
      expect((yield* Effect.promise(() => fs.stat(target.canonical))).mode & 0o777).toBe(0o444)
    }).pipe(provide(directory))),
  )

  it.live("rechecks all measured bytes and modes after awaited transaction preparation", () =>
    withTmp((directory) => Effect.gen(function* () {
      for (const drift of ["bytes", "mode"] as const) {
        const first = { canonical: path.join(directory, `${drift}-first.txt`), resource: `${drift}-first.txt` }
        const second = { canonical: path.join(directory, `${drift}-second.txt`), resource: `${drift}-second.txt` }
        yield* Effect.promise(() => Promise.all([fs.writeFile(first.canonical, "first"), fs.writeFile(second.canonical, "second")]))
        const error = yield* (yield* FileMutation.Service).transact([
          { type: "update", target: first, content: "ours", expected: { exists: true, sha256: sha256("first") } },
          { type: "update", target: second, content: "ours", expected: { exists: true, sha256: sha256("second") } },
        ], { before: Effect.promise(() => drift === "bytes" ? fs.writeFile(second.canonical, "foreign") : fs.chmod(second.canonical, 0o444)) }).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "FileMutation.StaleContentError", path: second.canonical })
        expect(yield* Effect.promise(() => fs.readFile(first.canonical, "utf8"))).toBe("first")
        expect(yield* Effect.promise(() => fs.readFile(second.canonical, "utf8"))).toBe(drift === "bytes" ? "foreign" : "second")
      }
    }).pipe(provide(directory))),
  )

  it.live("pins transaction targets and bytes before awaited hooks", () =>
    withTmp((directory) => Effect.gen(function* () {
      const original = path.join(directory, "approved.txt")
      const foreign = path.join(directory, "foreign.txt")
      const target = { canonical: original, resource: "approved.txt" }
      const bytes = new TextEncoder().encode("approved")
      yield* (yield* FileMutation.Service).transact([{ type: "add", target, content: bytes }], {
        before: Effect.sync(() => { target.canonical = foreign; bytes.fill(120) }),
      })
      expect(yield* Effect.promise(() => fs.readFile(original, "utf8"))).toBe("approved")
      expect(yield* Effect.promise(() => fs.stat(foreign).then(() => true, () => false))).toBe(false)
    }).pipe(provide(directory))),
  )

  it.live("writes an existing internal file and returns a stable result", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "hello.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "before"))
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "hello.txt" })

        expect(yield* (yield* FileMutation.Service).write({ target, content: "after" })).toMatchObject({
          operation: "write",
          target: target.canonical,
          resource: "hello.txt",
          existed: true,
        })
        expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("after")
      }).pipe(provide(directory)),
    ),
  )

  it.live("captures metadata-only write checkpoints", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "checkpoint.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "before"))
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "checkpoint.txt" })

        expect(yield* (yield* FileMutation.Service).write({ target, content: "after" })).toMatchObject({
          checkpoint: {
            before: { exists: true, bytes: 6, sha256: sha256("before") },
            after: { exists: true, bytes: 5, sha256: sha256("after") },
          },
        })
      }).pipe(provide(directory)),
    ),
  )

  it.live("writes a prospective internal file and creates parent directories", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const target = yield* (yield* LocationMutation.Service).resolve({
          path: path.join("src", "nested", "hello.txt"),
        })
        const result = yield* (yield* FileMutation.Service).write({ target, content: "hello" })

        expect(result).toMatchObject({
          operation: "write",
          target: target.canonical,
          resource: "src/nested/hello.txt",
          existed: false,
        })
        expect(yield* Effect.promise(() => fs.readFile(result.target, "utf8"))).toBe("hello")
      }).pipe(provide(directory)),
    ),
  )

  it.live("preserves exactly one BOM for text writes and normalizes created text", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const preservedPath = path.join(directory, "preserved.txt")
        yield* Effect.promise(() => fs.writeFile(preservedPath, "\uFEFFbefore"))
        const preserved = yield* (yield* LocationMutation.Service).resolve({ path: "preserved.txt" })
        const created = yield* (yield* LocationMutation.Service).resolve({ path: "created.txt" })
        const files = yield* FileMutation.Service

        yield* files.writeTextPreservingBom({ target: preserved, content: "\uFEFFafter" })
        yield* files.writeTextPreservingBom({ target: created, content: "\uFEFF\uFEFF\uFEFFcreated" })

        expect(yield* Effect.promise(() => fs.readFile(preservedPath, "utf8"))).toBe("\uFEFFafter")
        expect(yield* Effect.promise(() => fs.readFile(created.canonical, "utf8"))).toBe("\uFEFFcreated")
      }).pipe(provide(directory)),
    ),
  )

  it.live("rejects create when a prospective target appears after resolution", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "appeared.txt")
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "appeared.txt" })
        yield* Effect.promise(() => fs.writeFile(targetPath, "winner"))

        expect(
          yield* (yield* FileMutation.Service).create({ target, content: "replacement" }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "FileMutation.TargetExistsError",
        })
        expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("winner")
      }).pipe(provide(directory)),
    ),
  )

  it.live("creates when an existing target disappears after resolution", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "removed.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "before"))
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "removed.txt" })
        yield* Effect.promise(() => fs.rm(targetPath))

        expect(yield* (yield* FileMutation.Service).create({ target, content: "after" })).toMatchObject({
          operation: "write",
          target: target.canonical,
          resource: "removed.txt",
          existed: false,
        })
        expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("after")
      }).pipe(provide(directory)),
    ),
  )

  it.live("removes an existing internal file", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "remove.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "remove"))
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "remove.txt" })
        const result = yield* (yield* FileMutation.Service).remove({ target })

        expect(result).toMatchObject({
          operation: "remove",
          target: target.canonical,
          resource: "remove.txt",
          existed: true,
        })
        expect(
          yield* Effect.promise(() =>
            fs.stat(targetPath).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }).pipe(provide(directory)),
    ),
  )

  it.live("writes an explicitly resolved external target", () =>
    withTmp((directory) =>
      withTmp((outside) =>
        Effect.gen(function* () {
          const targetPath = path.join(outside, "external.txt")
          const target = yield* (yield* LocationMutation.Service).resolve({ path: targetPath })
          const result = yield* (yield* FileMutation.Service).write({ target, content: "external" })

          expect(result).toMatchObject({
            operation: "write",
            target: target.canonical,
            resource: target.resource,
            existed: false,
          })
          expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("external")
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("removes an explicitly resolved external target", () =>
    withTmp((directory) =>
      withTmp((outside) =>
        Effect.gen(function* () {
          const targetPath = path.join(outside, "external.txt")
          yield* Effect.promise(() => fs.writeFile(targetPath, "external"))
          const target = yield* (yield* LocationMutation.Service).resolve({ path: targetPath })
          const result = yield* (yield* FileMutation.Service).remove({ target })

          expect(result).toMatchObject({
            operation: "remove",
            target: target.canonical,
            resource: target.resource,
            existed: true,
          })
          expect(
            yield* Effect.promise(() =>
              fs.stat(targetPath).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("reports a missing target as not removed without checking existence first", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "missing.txt" })

        expect(yield* (yield* FileMutation.Service).remove({ target })).toMatchObject({
          operation: "remove",
          target: target.canonical,
          resource: "missing.txt",
          existed: false,
        })
      }).pipe(provide(directory)),
    ),
  )

  it.live("serializes concurrent writes to the same canonical target", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "shared.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "initial"))
        const firstStarted = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let writes = 0
        const filesystem = instrumentWrites((write) =>
          Effect.gen(function* () {
            writes++
            if (writes === 1) {
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(releaseFirst)
            } else {
              yield* Deferred.succeed(secondStarted, undefined)
            }
            yield* write
          }),
        )

        yield* Effect.gen(function* () {
          const mutation = yield* LocationMutation.Service
          const files = yield* FileMutation.Service
          const firstPlan = yield* mutation.resolve({ path: "shared.txt" })
          const secondPlan = yield* mutation.resolve({ path: "shared.txt" })
          const first = yield* files.write({ target: firstPlan, content: "first" }).pipe(Effect.forkChild)
          yield* Deferred.await(firstStarted)
          const second = yield* files.write({ target: secondPlan, content: "second" }).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          expect(yield* Deferred.isDone(secondStarted)).toBe(false)

          yield* Deferred.succeed(releaseFirst, undefined)
          yield* Deferred.await(secondStarted)
          yield* Fiber.join(first)
          yield* Fiber.join(second)
          expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("second")
        }).pipe(provide(directory, filesystem))
      }),
    ),
  )

  it.live("allows only one concurrent conditional write based on the same bytes", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "shared.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "initial"))
        const firstStarted = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        let writes = 0
        const filesystem = instrumentWrites((write) =>
          Effect.gen(function* () {
            writes++
            if (writes === 1) {
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(releaseFirst)
            }
            yield* write
          }),
        )

        yield* Effect.gen(function* () {
          const mutation = yield* LocationMutation.Service
          const files = yield* FileMutation.Service
          const target = yield* mutation.resolve({ path: "shared.txt" })
          const expected = new TextEncoder().encode("initial")
          const first = yield* files.writeIfUnchanged({ target, expected, content: "first" }).pipe(Effect.forkChild)
          yield* Deferred.await(firstStarted)
          const second = yield* files
            .writeIfUnchanged({ target, expected, content: "second" })
            .pipe(Effect.flip, Effect.forkChild)

          yield* Deferred.succeed(releaseFirst, undefined)
          yield* Fiber.join(first)
          expect(yield* Fiber.join(second)).toMatchObject({ _tag: "FileMutation.StaleContentError" })
          expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("first")
          expect(writes).toBe(1)
        }).pipe(provide(directory, filesystem))
      }),
    ),
  )

  it.live("rejects a conditional write when target content is already stale", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "stale.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "current"))
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "stale.txt" })

        expect(
          yield* (yield* FileMutation.Service)
            .writeIfUnchanged({ target, expected: new TextEncoder().encode("older"), content: "replacement" })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "FileMutation.StaleContentError", path: target.canonical })
        expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("current")
      }).pipe(provide(directory)),
    ),
  )

  it.live("guards creates, replacements, and deletes with model-visible expected state", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const files = yield* FileMutation.Service
        const mutation = yield* LocationMutation.Service
        const target = yield* mutation.resolve({ path: "guarded.txt" })

        yield* files.writeGuarded({ target, content: "first", expected: { exists: false } })
        expect(
          yield* files
            .writeGuarded({ target, content: "stale", expected: { exists: true, sha256: sha256("other") } })
            .pipe(Effect.flip),
        ).toBeInstanceOf(FileMutation.StaleContentError)
        yield* files.writeGuarded({
          target,
          content: "second",
          expected: { exists: true, sha256: sha256("first") },
        })
        yield* files.removeGuarded({ target, expected: { exists: true, sha256: sha256("second") } })
        expect(
          yield* Effect.promise(() =>
            fs.stat(target.canonical).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }).pipe(provide(directory)),
    ),
  )

  it.live("opposite multi-target orders cannot deadlock or silently rebase", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const files = yield* FileMutation.Service
        const mutation = yield* LocationMutation.Service
        const a = yield* mutation.resolve({ path: "a.txt" })
        const b = yield* mutation.resolve({ path: "b.txt" })
        yield* Effect.promise(() => Promise.all([fs.writeFile(a.canonical, "old"), fs.writeFile(b.canonical, "old")]))
        const results = yield* Effect.forEach(
          [
            [a, b],
            [b, a],
          ],
          (targets) =>
            files
              .transact(
                targets.map((target) => ({
                  type: "update" as const,
                  target,
                  content: "new",
                  expected: { exists: true as const, sha256: sha256("old") },
                })),
              )
              .pipe(Effect.exit),
          { concurrency: "unbounded" },
        )
        expect(results.map((result) => result._tag).sort()).toEqual(["Failure", "Success"])
        expect(yield* Effect.promise(() => fs.readFile(a.canonical, "utf8"))).toBe("new")
        expect(yield* Effect.promise(() => fs.readFile(b.canonical, "utf8"))).toBe("new")
      }).pipe(provide(directory)),
    ),
  )

  it.live("rollback refuses to overwrite an external change after an earlier commit", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const first = path.join(directory, "a.txt")
        const second = path.join(directory, "b.txt")
        yield* Effect.promise(() => Promise.all([fs.writeFile(first, "old"), fs.writeFile(second, "old")]))
        const filesystem = instrumentWrites((write, target) =>
          target.startsWith(second)
            ? Effect.promise(() => fs.writeFile(first, "human")).pipe(
                Effect.andThen(Effect.die("second commit failed")),
              )
            : write,
        )
        yield* Effect.gen(function* () {
          const files = yield* FileMutation.Service
          const mutation = yield* LocationMutation.Service
          const a = yield* mutation.resolve({ path: "a.txt" })
          const b = yield* mutation.resolve({ path: "b.txt" })
          const result = yield* files
            .transact(
              [a, b].map((target) => ({
                type: "update" as const,
                target,
                content: "new",
                expected: { exists: true as const, sha256: sha256("old") },
              })),
            )
            .pipe(Effect.flip)
          expect(result).toBeInstanceOf(FileMutation.TransactionRollbackError)
          expect(result).toMatchObject({ path: a.canonical, paths: [a.canonical, b.canonical] })
          expect(yield* Effect.promise(() => fs.readFile(first, "utf8"))).toBe("human")
          expect(yield* Effect.promise(() => fs.readFile(second, "utf8"))).toBe("old")
        }).pipe(provide(directory, filesystem))
      }),
    ),
  )

  it.live("a failed exclusive create with partial bytes never confirms rollback", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const filesystem = instrumentWrites((write) =>
          write.pipe(Effect.andThen(Effect.die("failed after bytes reached disk"))),
        )
        yield* Effect.gen(function* () {
          const files = yield* FileMutation.Service
          const target = yield* (yield* LocationMutation.Service).resolve({ path: "partial.txt" })
          let cleared = false
          const result = yield* files
            .transact([{ type: "add", target, content: "partial effect" }], {
              rolledBack: Effect.sync(() => {
                cleared = true
              }),
            })
            .pipe(Effect.flip)
          expect(result).toMatchObject({
            _tag: "FileMutation.TransactionRollbackError",
            path: target.canonical,
            paths: [target.canonical],
          })
          expect(cleared).toBe(false)
          expect(yield* Effect.promise(() => fs.readFile(target.canonical, "utf8"))).toBe("partial effect")
        }).pipe(provide(directory, filesystem))
      }),
    ),
  )

  it.live("preflights a multi-file transaction before applying any change", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const files = yield* FileMutation.Service
        const mutation = yield* LocationMutation.Service
        const added = yield* mutation.resolve({ path: "added.txt" })
        const updated = yield* mutation.resolve({ path: "updated.txt" })
        yield* Effect.promise(() => fs.writeFile(updated.canonical, "current"))

        expect(
          yield* files
            .transact([
              { type: "add", target: added, content: "new" },
              {
                type: "update",
                target: updated,
                content: "changed",
                expected: { exists: true, sha256: sha256("stale") },
              },
            ])
            .pipe(Effect.flip),
        ).toBeInstanceOf(FileMutation.StaleContentError)
        expect(
          yield* Effect.promise(() =>
            fs.stat(added.canonical).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
        expect(yield* Effect.promise(() => fs.readFile(updated.canonical, "utf8"))).toBe("current")
      }).pipe(provide(directory)),
    ),
  )

  it.live("allows distinct canonical targets to proceed independently", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const secondFinished = yield* Deferred.make<void>()
        const secondPath = path.join(directory, "second.txt")
        let writes = 0
        const filesystem = instrumentWrites((write) =>
          ++writes === 1
            ? Deferred.succeed(firstStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirst)),
                Effect.andThen(write),
              )
            : write.pipe(Effect.andThen(Deferred.succeed(secondFinished, undefined))),
        )

        yield* Effect.gen(function* () {
          const mutation = yield* LocationMutation.Service
          const files = yield* FileMutation.Service
          const firstPlan = yield* mutation.resolve({ path: "first.txt" })
          const secondPlan = yield* mutation.resolve({ path: "second.txt" })
          const first = yield* files.write({ target: firstPlan, content: "first" }).pipe(Effect.forkChild)
          yield* Deferred.await(firstStarted)
          const second = yield* files.write({ target: secondPlan, content: "second" }).pipe(Effect.forkChild)
          yield* Deferred.await(secondFinished)
          expect(yield* Effect.promise(() => fs.readFile(secondPath, "utf8"))).toBe("second")

          yield* Deferred.succeed(releaseFirst, undefined)
          yield* Fiber.join(first)
          yield* Fiber.join(second)
        }).pipe(provide(directory, filesystem))
      }),
    ),
  )
})

function instrumentWrites(run: <E>(write: Effect.Effect<void, E>, target: string) => Effect.Effect<void, E>) {
  return Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const filesystem = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...filesystem,
        writeWithDirs: (target, content, mode) => run(filesystem.writeWithDirs(target, content, mode), target),
        writeFile: (target, content, options) => run(filesystem.writeFile(target, content, options), target),
        writeFileString: (target, content, options) =>
          run(filesystem.writeFileString(target, content, options), target),
      })
    }),
  ).pipe(Layer.provide(FSUtil.defaultLayer))
}
