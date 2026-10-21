import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { SessionMirror } from "@opencode-ai/core/session/mirror"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const bytes = (text: string) => new TextEncoder().encode(text)
const target = (name: string) => ({ canonical: `/mirror/${name}`, resource: name })

describe("mirror integration preparation", () => {
  test("rejects case-variant duplicate Windows targets before preparing any patch", () => {
    if (process.platform !== "win32") return
    expect(() =>
      SessionMirror.prepareIntegration(
        ["C:/Repo/File.txt", "c:/repo/file.txt"].map((canonical) => ({
          target: { canonical, resource: "file.txt" },
          basis: bytes("old"),
          child: bytes("child"),
          main: bytes("old"),
        })),
      ),
    ).toThrow("Duplicate mirror integration target")
  })

  test("integrates only basis-to-child delta and preserves unrelated current Main edits", () => {
    const result = SessionMirror.prepareIntegration([
      {
        target: target("inherited.txt"),
        basis: bytes("dirty Main"),
        child: bytes("dirty Main"),
        main: bytes("new user edit"),
      },
      { target: target("changed.txt"), basis: bytes("old"), child: bytes("child delta"), main: bytes("old") },
      { target: target("new.txt"), basis: undefined, child: bytes("new"), main: undefined },
      { target: target("removed.txt"), basis: bytes("old"), child: undefined, main: bytes("old") },
      { target: target("already.txt"), basis: bytes("old"), child: bytes("same result"), main: bytes("same result") },
    ])
    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error("Expected ready integration")
    expect(result.changes.map((change) => [change.type, change.target.resource])).toEqual([
      ["update", "changed.txt"],
      ["add", "new.txt"],
      ["delete", "removed.txt"],
    ])
  })

  test("returns no partial patch when a changed, added or deleted user file conflicts", () => {
    for (const entry of [
      { basis: bytes("old"), child: bytes("child"), main: bytes("user") },
      { basis: undefined, child: bytes("child"), main: bytes("user") },
      { basis: bytes("old"), child: undefined, main: bytes("user") },
      { basis: bytes("old"), child: bytes("child"), main: undefined },
    ]) {
      expect(
        SessionMirror.prepareIntegration([
          { target: target("safe.txt"), basis: bytes("old"), child: bytes("new"), main: bytes("old") },
          { target: target("conflict.txt"), ...entry },
        ]),
      ).toEqual({ status: "conflicts", targets: ["/mirror/conflict.txt"] })
    }
  })

  test("freezes child bytes and target values before later application", () => {
    const content = bytes("child")
    const originalTarget = target("file.txt")
    const result = SessionMirror.prepareIntegration([
      { target: originalTarget, basis: bytes("old"), child: content, main: bytes("old") },
    ])
    content.fill(0)
    originalTarget.canonical = "/unrelated"
    if (result.status !== "ready") throw new Error("Expected ready integration")
    expect(result.changes[0]).toMatchObject({ target: target("file.txt"), content: bytes("child") })
    expect(() =>
      SessionMirror.prepareIntegration([
        { target: target("same"), basis: undefined, child: bytes("a"), main: undefined },
        { target: target("same"), basis: undefined, child: bytes("b"), main: undefined },
      ]),
    ).toThrow("Duplicate mirror integration target")
  })

  it.live("uses FileMutation's all-target hash preflight when Main changes after preparation", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = { canonical: path.join(tmp.path, "a.txt"), resource: "a.txt" }
          const second = { canonical: path.join(tmp.path, "b.txt"), resource: "b.txt" }
          yield* Effect.promise(() => fs.writeFile(first.canonical, "old"))
          yield* Effect.promise(() => fs.writeFile(second.canonical, "old"))
          const result = SessionMirror.prepareIntegration(
            [first, second].map((target) => ({
              target,
              basis: bytes("old"),
              child: bytes("child"),
              main: bytes("old"),
            })),
          )
          if (result.status !== "ready") throw new Error("Expected ready integration")
          yield* Effect.promise(() => fs.writeFile(second.canonical, "new user edit"))
          const files = yield* FileMutation.Service
          expect(Exit.isFailure(yield* Effect.exit(files.transact(result.changes)))).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(first.canonical, "utf8"))).toBe("old")
          expect(yield* Effect.promise(() => fs.readFile(second.canonical, "utf8"))).toBe("new user edit")
        }).pipe(Effect.provide(FileMutation.layer.pipe(Layer.provide(FSUtil.defaultLayer)))),
      ),
    ),
  )
})
