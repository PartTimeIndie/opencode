import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { location } from "./fixture/location"
import { it } from "./lib/effect"

function provide(directory: string) {
  return Effect.provide(
    LocationMutation.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          FSUtil.defaultLayer,
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ),
      ),
    ),
  )
}

function withTmp<A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))
}

describe("LocationMutation", () => {
  it.live("resolves an active relative existing file target", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "hello.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "hello"))
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "hello.txt" })

        expect(target).toMatchObject({
          canonical: yield* Effect.promise(() => fs.realpath(targetPath)),
          resource: "hello.txt",
        })
        expect(target.externalDirectory).toBeUndefined()
      }).pipe(provide(directory)),
    ),
  )

  it.live("resolves an active relative prospective file target", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "src")))
        const target = yield* (yield* LocationMutation.Service).resolve({ path: path.join("src", "new.txt") })
        const root = yield* Effect.promise(() => fs.realpath(directory))

        expect(target).toMatchObject({
          canonical: path.join(root, "src", "new.txt"),
          resource: "src/new.txt",
        })
      }).pipe(provide(directory)),
    ),
  )

  it.live("classifies a relative lexical escape as external when requested by a guarded tool", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const mutation = yield* LocationMutation.Service
        const input = { path: "../outside.txt" }
        const error = yield* Effect.flip(mutation.resolve(input))
        expect(error).toMatchObject({ _tag: "LocationMutation.PathError", reason: "relative_escape" })
        const outside = yield* Effect.promise(() => fs.realpath(path.dirname(directory)))
        expect(yield* mutation.resolve(input, { authorizeExternalAliases: true })).toMatchObject({
          canonical: path.join(outside, "outside.txt"),
          resource: path.join(outside, "outside.txt").replaceAll("\\", "/"),
          externalDirectory: { directory: outside, resource: path.join(outside, "*").replaceAll("\\", "/") },
        })
      }).pipe(provide(directory)),
    ),
  )

  it.live("classifies a prospective target below an external symlink or junction using its canonical directory", () =>
    withTmp((directory) => withTmp((outside) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.symlink(outside, path.join(directory, "escape"), process.platform === "win32" ? "junction" : "dir"))
        const mutation = yield* LocationMutation.Service
        const input = { path: path.join("escape", "new.txt") }
        const error = yield* Effect.flip(mutation.resolve(input))
        expect(error).toMatchObject({ _tag: "LocationMutation.PathError", reason: "location_escape" })
        const root = yield* Effect.promise(() => fs.realpath(outside))
        expect(yield* mutation.resolve(input, { authorizeExternalAliases: true })).toMatchObject({
          canonical: path.join(root, "new.txt"),
          externalDirectory: { directory: root, resource: path.join(root, "*").replaceAll("\\", "/") },
        })
      }).pipe(provide(directory)),
    )),
  )

  it.live("does not treat a dangling symlink or junction as a prospective directory", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.symlink(path.join(directory, "missing"), path.join(directory, "dangling"), process.platform === "win32" ? "junction" : "dir"))
        const mutation = yield* LocationMutation.Service
        for (const target of ["dangling", "dangling/new.txt"]) {
          const error = yield* Effect.flip(mutation.resolve({ path: target }, { authorizeExternalAliases: true }))
          expect(error).toMatchObject({ _tag: "LocationMutation.PathError", reason: "unresolved_identity" })
        }
      }).pipe(provide(directory)),
    ),
  )

  it.live("follows an in-location symlink using ordinary filesystem semantics", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(directory, "actual"))
          await fs.symlink(path.join(directory, "actual"), path.join(directory, "linked"))
        })

        expect(yield* (yield* LocationMutation.Service).resolve({ path: "linked/new.txt" })).toMatchObject({
          canonical: path.join(yield* Effect.promise(() => fs.realpath(directory)), "actual", "new.txt"),
          resource: "actual/new.txt",
        })
      }).pipe(provide(directory)),
    ),
  )

  it.live("accepts an explicit absolute in-location target without external approval", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "new.txt")
        const target = yield* (yield* LocationMutation.Service).resolve({ path: targetPath })
        expect(target).toMatchObject({
          canonical: path.join(yield* Effect.promise(() => fs.realpath(directory)), "new.txt"),
          resource: "new.txt",
        })
        expect(target.externalDirectory).toBeUndefined()
      }).pipe(provide(directory)),
    ),
  )

  it.live("requires external-directory authorization for an explicit external absolute target", () =>
    withTmp((directory) =>
      withTmp((outside) =>
        Effect.gen(function* () {
          const targetPath = path.join(outside, "new.txt")
          const target = yield* (yield* LocationMutation.Service).resolve({ path: targetPath })
          const root = yield* Effect.promise(() => fs.realpath(outside))
          expect(target).toMatchObject({
            canonical: path.join(root, "new.txt"),
            resource: path.join(root, "new.txt").replaceAll("\\", "/"),
          })
          expect(target.externalDirectory).toMatchObject({
            directory: root,
            resource: path.join(root, "*").replaceAll("\\", "/"),
          })
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("resolves an existing external file target", () =>
    withTmp((directory) =>
      withTmp((outside) =>
        Effect.gen(function* () {
          const targetPath = path.join(outside, "existing.txt")
          yield* Effect.promise(() => fs.writeFile(targetPath, "existing"))
          const target = yield* (yield* LocationMutation.Service).resolve({ path: targetPath })
          const root = yield* Effect.promise(() => fs.realpath(outside))
          expect(target).toMatchObject({ canonical: path.join(root, "existing.txt") })
          expect(target.externalDirectory?.directory).toBe(root)
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("anchors prospective external descendants at their stable existing directory", () =>
    withTmp((directory) =>
      withTmp((outside) =>
        Effect.gen(function* () {
          const targetPath = path.join(outside, "new", "nested", "file.txt")
          const target = yield* (yield* LocationMutation.Service).resolve({ path: targetPath })
          const root = yield* Effect.promise(() => fs.realpath(outside))
          expect(target.externalDirectory).toMatchObject({
            directory: root,
            resource: path.join(root, "*").replaceAll("\\", "/"),
          })
        }).pipe(provide(directory)),
      ),
    ),
  )

  test("ignores unknown mutation input fields", () => {
    expect(Object.keys(LocationMutation.ResolveInput.fields)).toEqual(["path", "kind"])
    expect(Schema.decodeUnknownSync(LocationMutation.ResolveInput)({ path: "README.md", reference: "docs" })).toEqual({
      path: "README.md",
    })
  })
})
