import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { FileMutationPendingTable } from "@opencode-ai/core/file-knowledge.sql"
import { FileKnowledge } from "@opencode-ai/core/file-knowledge"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { withKnownFileTools } from "./fixture/known-file-tools"
import { tmpdir } from "./fixture/tmpdir"
import { KnownFileMutation } from "@opencode-ai/core/tool/known-file-mutation"

const run = async <A, E>(body: (directory: string) => Effect.Effect<A, E>) => {
  await using tmp = await tmpdir()
  return await Effect.runPromise(body(tmp.path))
}
const value = (result: { result: { type: string; value: unknown } }) => String(result.result.value)

describe("native file knowledge enforcement", () => {
  test("permission approval and a supplied current hash do not replace a delivered read", () =>
    run((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "a.txt"), "original"))
        yield* withKnownFileTools(directory, ({ call }) =>
          Effect.gen(function* () {
            const result = yield* call({
              name: "write",
              input: { path: "a.txt", content: "replacement", expectedSha256: FileKnowledge.hash("original") },
            })
            expect(result.result.type).toBe("error")
            expect(value(result)).toContain("Read required")
            expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "a.txt"), "utf8"))).toBe("original")
          }),
        )
      }),
    ))

  test("read then edit and own full-write chains need no redundant reads", () =>
    run((directory) =>
      withKnownFileTools(directory, ({ call }) =>
        Effect.gen(function* () {
          expect((yield* call({ name: "write", input: { path: "a.txt", content: "one" } })).result.type).toBe("text")
          expect((yield* call({ name: "write", input: { path: "a.txt", content: "two" } })).result.type).toBe("text")
          expect(
            (yield* call({ name: "edit", input: { path: "a.txt", oldString: "two", newString: "three" } })).result.type,
          ).toBe("text")
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "a.txt"), "utf8"))).toBe("three")
        }),
      ),
    ))

  test("partial edits preserve unknown lines but cannot authorize full replacement", () =>
    run((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "a.txt"), "known\nprivate\n"))
        yield* withKnownFileTools(directory, ({ call }) =>
          Effect.gen(function* () {
            expect((yield* call({ name: "read", input: { path: "a.txt", limit: 1 } })).result.type).toBe("text")
            expect(
              (yield* call({ name: "edit", input: { path: "a.txt", oldString: "known", newString: "changed" } })).result
                .type,
            ).toBe("text")
            expect((yield* call({ name: "write", input: { path: "a.txt", content: "erase" } })).result.type).toBe(
              "error",
            )
            expect(
              (yield* call({ name: "edit", input: { path: "a.txt", oldString: "private", newString: "erase" } })).result
                .type,
            ).toBe("error")
            expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "a.txt"), "utf8"))).toBe(
              "changed\nprivate\n",
            )
          }),
        )
      }),
    ))

  test("an external shell-style write conflicts until a new real read", () =>
    run((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "a.txt"), "old"))
        yield* withKnownFileTools(directory, ({ call }) =>
          Effect.gen(function* () {
            yield* call({ name: "read", input: { path: "a.txt" } })
            yield* Effect.promise(() => fs.writeFile(path.join(directory, "a.txt"), "human"))
            expect((yield* call({ name: "write", input: { path: "a.txt", content: "agent" } })).result.type).toBe(
              "error",
            )
            expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "a.txt"), "utf8"))).toBe("human")
            yield* call({ name: "read", input: { path: "a.txt" } })
            expect((yield* call({ name: "write", input: { path: "a.txt", content: "agent" } })).result.type).toBe(
              "text",
            )
          }),
        )
      }),
    ))

  test("same-request read+write cannot grant knowledge and two writes cannot silently rebase", () =>
    run((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "a.txt"), "old"))
        yield* withKnownFileTools(directory, ({ batch }) =>
          Effect.gen(function* () {
            const first = yield* batch([
              { name: "read", input: { path: "a.txt" } },
              { name: "write", input: { path: "a.txt", content: "not allowed" } },
            ])
            expect(first[1]!.result.type).toBe("error")
            const race = yield* batch([
              { name: "write", input: { path: "a.txt", content: "winner-a" } },
              { name: "write", input: { path: "a.txt", content: "winner-b" } },
            ])
            expect(race.filter((result) => result.result.type === "text")).toHaveLength(1)
            expect(race.filter((result) => result.result.type === "error")).toHaveLength(1)
          }),
        )
      }),
    ))

  test("a preflight conflict rejects all targets in the patch, including earlier adds", () =>
    run((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "a.txt"), "original\n"))
        yield* withKnownFileTools(directory, ({ call }) =>
          Effect.gen(function* () {
            const result = yield* call({
              name: "apply_patch",
              input: {
                patchText:
                  "*** Begin Patch\n*** Add File: b.txt\n+new\n*** Update File: a.txt\n@@\n-original\n+changed\n*** End Patch",
              },
            })
            expect(result.result.type).toBe("error")
            expect(
              yield* Effect.promise(() =>
                fs.access(path.join(directory, "b.txt")).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(false)
            expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "a.txt"), "utf8"))).toBe("original\n")
            yield* call({ name: "read", input: { path: "a.txt" } })
            expect(
              (yield* call({
                name: "apply_patch",
                input: {
                  patchText:
                    "*** Begin Patch\n*** Add File: b.txt\n+new\n*** Update File: a.txt\n@@\n-original\n+changed\n*** End Patch",
                },
              })).result.type,
            ).toBe("text")
          }),
        )
      }),
    ))

  test("a missing frozen request cutoff rejects writes, edits and new creates", () =>
    run((directory) =>
      withKnownFileTools(directory, ({ call }) =>
        Effect.gen(function* () {
          yield* call({ name: "write", input: { path: "a.txt", content: "old" } })
          for (const action of [
            { name: "write" as const, input: { path: "a.txt", content: "bad" } },
            { name: "edit" as const, input: { path: "a.txt", oldString: "old", newString: "bad" } },
            { name: "write" as const, input: { path: "new.txt", content: "bad" } },
          ]) {
            const result = yield* call({ ...action, withoutCutoff: true })
            expect(result.result.type).toBe("error")
            expect(value(result)).toContain("frozen cutoff")
          }
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "a.txt"), "utf8"))).toBe("old")
          expect(
            yield* Effect.promise(() =>
              fs.access(path.join(directory, "new.txt")).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
        }),
      ),
    ))

  test("read receipt storage failure is a tool error, not a drain defect", () =>
    run((directory) =>
      withKnownFileTools(directory, ({ call, database }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "a.txt"), "original"))
          yield* database.db
            .run(
              sql`CREATE TRIGGER fail_read_receipt BEFORE INSERT ON file_knowledge_receipt WHEN NEW.origin = 'pending_read' BEGIN SELECT RAISE(FAIL, 'fixture storage failure'); END`,
            )
            .pipe(Effect.orDie)
          const result = yield* call({ name: "read", input: { path: "a.txt" } })
          expect(result.result.type).toBe("error")
          expect(value(result)).toContain("storage failed")
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "a.txt"), "utf8"))).toBe("original")
        }),
      ),
    ))

  test("a post-commit storage failure preserves uncertainty until a fresh full read and new guarded attempt", () =>
    run((directory) =>
      withKnownFileTools(directory, ({ call, database }) =>
        Effect.gen(function* () {
          yield* database.db
            .run(
              sql`CREATE TRIGGER fail_write_receipt BEFORE INSERT ON file_knowledge_receipt WHEN NEW.origin = 'write' BEGIN SELECT RAISE(FAIL, 'fixture storage failure'); END`,
            )
            .pipe(Effect.orDie)
          const result = yield* call({ name: "write", input: { path: "a.txt", content: "committed but unconfirmed" } })
          expect(result.result.type).toBe("error")
          expect(value(result)).toContain("unconfirmed")
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "a.txt"), "utf8"))).toBe(
            "committed but unconfirmed",
          )
          expect(yield* database.db.select().from(FileMutationPendingTable).all().pipe(Effect.orDie)).toHaveLength(1)
          yield* database.db.run(sql`DROP TRIGGER fail_write_receipt`).pipe(Effect.orDie)
          expect((yield* call({ name: "write", input: { path: "a.txt", content: "unsafe retry" } })).result.type).toBe(
            "error",
          )
          yield* call({ name: "read", input: { path: "a.txt" } })
          expect(
            (yield* call({ name: "write", input: { path: "a.txt", content: "new guarded attempt" } })).result.type,
          ).toBe("text")
          expect(yield* database.db.select().from(FileMutationPendingTable).all().pipe(Effect.orDie)).toHaveLength(0)
        }),
      ),
    ))

  test("directory junction aliases share read knowledge and reject duplicate patch targets", () =>
    run((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(directory, "real"))
          await fs.writeFile(path.join(directory, "real", "a.txt"), "old")
          await fs.symlink(path.join(directory, "real"), path.join(directory, "alias"), "junction")
        })
        yield* withKnownFileTools(directory, ({ call }) =>
          Effect.gen(function* () {
            yield* call({ name: "read", input: { path: "alias/a.txt" } })
            const spelling = process.platform === "win32" ? "real/A.TXT" : "real/a.txt"
            const edited = yield* call({ name: "edit", input: { path: spelling, oldString: "old", newString: "new" } })
            expect(edited.result).toMatchObject({ type: "text" })
            const result = yield* call({
              name: "apply_patch",
              input: {
                patchText:
                  "*** Begin Patch\n*** Add File: real/new.txt\n+first\n*** Add File: alias/new.txt\n+second\n*** End Patch",
              },
            })
            expect(result.result.type).toBe("error")
            expect(
              yield* Effect.promise(() =>
                fs.access(path.join(directory, "real", "new.txt")).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(false)
            expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "real", "a.txt"), "utf8"))).toBe("new")
          }),
        )
      }),
    ))

  test("uncertainty needs fresh full coverage, not an old full receipt plus one fresh line", () =>
    run((directory) =>
      withKnownFileTools(directory, ({ call, database, store }) =>
        Effect.gen(function* () {
          yield* call({ name: "write", input: { path: "a.txt", content: "one\ntwo\n" } })
          const canonical = yield* Effect.promise(() => fs.realpath(path.join(directory, "a.txt")))
          const cutoff = yield* store.deliver(SessionSchema.ID.make("ses_known_tools"), [])
          yield* database.db
            .insert(FileMutationPendingTable)
            .values({
              target: canonical,
              operation_id: "foreign-uncertain-operation",
              session_id: "another-session",
              receipt_id: cutoff,
            })
            .run()
            .pipe(Effect.orDie)
          yield* call({ name: "read", input: { path: "a.txt", limit: 1 } })
          const blocked = yield* call({ name: "write", input: { path: "a.txt", content: "must stay blocked" } })
          expect(blocked.result.type).toBe("error")
          expect(value(blocked)).toContain("Unconfirmed file operation")
          yield* call({ name: "read", input: { path: "a.txt", offset: 2, limit: 1 } })
          expect(
            (yield* call({ name: "write", input: { path: "a.txt", content: "new independently observed attempt" } }))
              .result.type,
          ).toBe("text")
          expect(yield* database.db.select().from(FileMutationPendingTable).all().pipe(Effect.orDie)).toHaveLength(0)
        }),
      ),
    ))

  test("coverage alignment never invents knowledge of untouched lines", () => {
    expect(
      KnownFileMutation.changedCoverage("a\nsecret\nc\n", "x\nsecret\ny\n", {
        ranges: [
          [1, 1],
          [3, 3],
        ],
        end: 3,
      }),
    ).toEqual({
      ranges: [
        [1, 1],
        [3, 3],
      ],
      end: 3,
    })
    expect(
      KnownFileMutation.changedCoverage("a\nsecret\n", "a\nchanged\n", { ranges: [[1, 1]], end: 2 }),
    ).toBeUndefined()
  })

  test("two real sessions isolate knowledge and only one stale-basis writer wins", () =>
    run((directory) =>
      withKnownFileTools(directory, ({ call, newSession }) =>
        Effect.gen(function* () {
          yield* call({ name: "write", input: { path: "a.txt", content: "original" } })
          const other = yield* newSession("ses_other_writer")
          expect(
            (yield* other.call({ name: "write", input: { path: "a.txt", content: "not inherited" } })).result.type,
          ).toBe("error")
          yield* other.call({ name: "read", input: { path: "a.txt" } })
          const results = yield* Effect.all(
            [
              call({ name: "write", input: { path: "a.txt", content: "first" } }),
              other.call({ name: "write", input: { path: "a.txt", content: "second" } }),
            ],
            { concurrency: "unbounded" },
          )
          expect(results.filter((result) => result.result.type === "text")).toHaveLength(1)
          expect(results.filter((result) => result.result.type === "error")).toHaveLength(1)
          expect(["first", "second"]).toContain(
            yield* Effect.promise(() => fs.readFile(path.join(directory, "a.txt"), "utf8")),
          )
        }),
      ),
    ))

  test("two sessions cannot both exclusively create the same target", () =>
    run((directory) =>
      withKnownFileTools(directory, ({ call, newSession }) =>
        Effect.gen(function* () {
          const other = yield* newSession("ses_other_creator")
          const results = yield* Effect.all(
            [
              call({ name: "write", input: { path: "new.txt", content: "first" } }),
              other.call({ name: "write", input: { path: "new.txt", content: "second" } }),
            ],
            { concurrency: "unbounded" },
          )
          expect(results.filter((result) => result.result.type === "text")).toHaveLength(1)
          expect(results.filter((result) => result.result.type === "error")).toHaveLength(1)
          expect(["first", "second"]).toContain(
            yield* Effect.promise(() => fs.readFile(path.join(directory, "new.txt"), "utf8")),
          )
        }),
      ),
    ))

  test("an uncertain missing target stays blocked instead of being silently recreated", () =>
    run((directory) =>
      withKnownFileTools(directory, ({ call, database }) =>
        Effect.gen(function* () {
          const target = path.join(yield* Effect.promise(() => fs.realpath(directory)), "missing.txt")
          yield* database.db
            .insert(FileMutationPendingTable)
            .values({ target, operation_id: "unknown-deletion", session_id: "another-session", receipt_id: 0 })
            .run()
            .pipe(Effect.orDie)
          const result = yield* call({ name: "write", input: { path: "missing.txt", content: "unsafe recreation" } })
          expect(result.result.type).toBe("error")
          expect(value(result)).toContain("manual recovery required")
          expect(
            yield* Effect.promise(() =>
              fs.access(target).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
          expect(yield* database.db.select().from(FileMutationPendingTable).all().pipe(Effect.orDie)).toHaveLength(1)
        }),
      ),
    ))
})
