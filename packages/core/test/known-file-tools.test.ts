import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { FileMutationPendingTable } from "@opencode-ai/core/file-knowledge.sql"
import { FileKnowledge } from "@opencode-ai/core/file-knowledge"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionInputTable } from "@opencode-ai/core/session/sql"
import { WorkspaceCheckout } from "@opencode-ai/core/session/workspace/checkout"
import { SessionOrchestratorTable, SessionOrchestratorTaskTable } from "@opencode-ai/core/session/legacy-delegation/sql"
import { withKnownFileTools } from "./fixture/known-file-tools"
import { tmpdir } from "./fixture/tmpdir"
import { KnownFileMutation } from "@opencode-ai/core/tool/known-file-mutation"

const run = async <A, E>(body: (directory: string) => Effect.Effect<A, E>) => {
  await using tmp = await tmpdir()
  return await Effect.runPromise(body(tmp.path))
}
const value = (result: { result: { type: string; value: unknown } }) => String(result.result.value)

describe("native file knowledge enforcement", () => {
  test("downstream bounding of a full-line page grants no knowledge until a smaller page is delivered", () =>
    run((directory) =>
      Effect.gen(function* () {
        const long = "ü".repeat(25_000)
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "bounded.txt"), `${long}\ntail\n`))
        yield* withKnownFileTools(directory, ({ call }) =>
          Effect.gen(function* () {
            const read = yield* call({ name: "read", input: { path: "bounded.txt", fullLines: true } })
            expect(value(read)).not.toContain(long)
            expect((yield* call({ name: "write", input: { path: "bounded.txt", content: "erase" } })).result.type).toBe(
              "error",
            )
            expect(
              (yield* call({ name: "edit", input: { path: "bounded.txt", oldString: "tail", newString: "changed" } }))
                .result.type,
            ).toBe("error")
            yield* call({ name: "read", input: { path: "bounded.txt", offset: 2, limit: 1, fullLines: true } })
            expect(
              (yield* call({ name: "edit", input: { path: "bounded.txt", oldString: "tail", newString: "changed" } }))
                .result.type,
            ).toBe("text")
            expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "bounded.txt"), "utf8"))).toBe(
              `${long}\nchanged\n`,
            )
          }),
        )
      }),
    ))

  test("explicit full-line reads allow a guarded edit but not unread lines or stale versions", () =>
    run((directory) =>
      Effect.gen(function* () {
        const long = "ü".repeat(3000)
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "long.txt"), `${long}\nhidden\n`))
        yield* withKnownFileTools(directory, ({ call }) =>
          Effect.gen(function* () {
            const ordinary = yield* call({ name: "read", input: { path: "long.txt", limit: 1 } })
            expect(value(ordinary)).toContain("line truncated")
            expect(
              (yield* call({ name: "edit", input: { path: "long.txt", oldString: long, newString: "changed" } })).result
                .type,
            ).toBe("error")
            const full = yield* call({ name: "read", input: { path: "long.txt", limit: 1, fullLines: true } })
            expect(value(full)).toContain(long)
            expect(value(full)).not.toContain("line truncated")
            expect(
              (yield* call({ name: "edit", input: { path: "long.txt", oldString: long, newString: "changed" } })).result
                .type,
            ).toBe("text")
            expect((yield* call({ name: "write", input: { path: "long.txt", content: "erase" } })).result.type).toBe(
              "error",
            )
            yield* call({ name: "read", input: { path: "long.txt", fullLines: true } })
            yield* Effect.promise(() => fs.writeFile(path.join(directory, "long.txt"), "human\nhidden\n"))
            expect((yield* call({ name: "write", input: { path: "long.txt", content: "erase" } })).result.type).toBe(
              "error",
            )
            expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "long.txt"), "utf8"))).toBe(
              "human\nhidden\n",
            )
          }),
        )
      }),
    ))

  test("a delivered complete full-line read permits deletion through the existing patch guard", () =>
    run((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "long.txt"), "x".repeat(4000)))
        yield* withKnownFileTools(directory, ({ call }) =>
          Effect.gen(function* () {
            const read = yield* call({ name: "read", input: { path: "long.txt", fullLines: true } })
            expect(value(read)).toContain("x".repeat(4000))
            expect(
              (yield* call({
                name: "apply_patch",
                input: { patchText: "*** Begin Patch\n*** Delete File: long.txt\n*** End Patch" },
              })).result.type,
            ).toBe("text")
            expect(
              yield* Effect.promise(() =>
                fs.access(path.join(directory, "long.txt")).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(false)
          }),
        )
      }),
    ))

  for (const name of ["write", "edit", "apply_patch"] as const) {
    test(`${name} refuses a historical child before any native file effect`, () =>
      run((directory) => withKnownFileTools(directory, ({ call, database, newSession, afterPermission }) => Effect.gen(function* () {
        yield* call({ name: "write", input: { path: "a.txt", content: "old\n" } })
        const main = SessionSchema.ID.make("ses_guard_main")
        const child = SessionSchema.ID.make("ses_known_tools")
        const origin = SessionMessage.ID.make("msg_guard_origin")
        const checkout = WorkspaceCheckout.pathKey(directory)
        yield* newSession(main)
        const db = database.db
        yield* db.insert(SessionInputTable).values({ id: origin, session_id: main, prompt: { text: "guard" }, delivery: "steer", admitted_seq: 1, promoted_seq: 2 }).run().pipe(Effect.orDie)
        yield* db.insert(SessionOrchestratorTable).values({ main_session_id: main, checkout_id: checkout, workspace_mode: "shared" }).run().pipe(Effect.orDie)
        yield* db.insert(SessionOrchestratorTaskTable).values({ id: "guard-task", main_session_id: main, request_id: "guard-request", checkout_id: checkout,
          origin_input_id: origin, origin_user_message_id: origin, goal: "guard", acceptance: "guard", resources: ["project:*"], dependencies: [],
          state: "running", slot_claimed: true, workspace_mode: "shared", child_session_id: child,
        }).run().pipe(Effect.orDie)
        afterPermission(db.update(SessionOrchestratorTaskTable).set({ state: "paused" }).run().pipe(Effect.orDie, Effect.asVoid))
        const input = name === "write" ? { path: "a.txt", content: "new\n" }
          : name === "edit" ? { path: "a.txt", oldString: "old", newString: "new" }
          : { patchText: "*** Begin Patch\n*** Add File: b.txt\n+not allowed\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch" }
        expect((yield* call({ name, input })).result.type).toBe("error")
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "a.txt"), "utf8"))).toBe("old\n")
        expect(yield* Effect.promise(() => fs.access(path.join(directory, "b.txt")).then(() => true, () => false))).toBe(false)
        expect(yield* db.select().from(FileMutationPendingTable).all().pipe(Effect.orDie)).toHaveLength(0)
        afterPermission(Effect.void)
        yield* db.update(SessionOrchestratorTaskTable).set({ state: "running" }).run().pipe(Effect.orDie)
        const retired = yield* call({ name, input })
        expect(retired.result.type).toBe("error")
        expect(value(retired)).toContain("Legacy Main-Orchestrator execution has been removed")
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "a.txt"), "utf8"))).toBe("old\n")
        expect(yield* Effect.promise(() => fs.access(path.join(directory, "b.txt")).then(() => true, () => false))).toBe(false)
        expect(yield* db.select().from(FileMutationPendingTable).all().pipe(Effect.orDie)).toHaveLength(0)
      }))),
    )
  }

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

  test("reads through an external junction and refuses a write if the junction is retargeted during permission", () =>
    run((directory) => Effect.gen(function* () {
      const outside = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const active = path.join(directory, "active")
      const second = path.join(directory, "second")
      const link = path.join(active, "linked")
      const kind = process.platform === "win32" ? "junction" : "dir"
      yield* Effect.promise(async () => {
        await fs.mkdir(active)
        await fs.mkdir(second)
        await fs.writeFile(path.join(outside.path, "a.txt"), "outside original")
        await fs.writeFile(path.join(second, "a.txt"), "second original")
        await fs.symlink(outside.path, link, kind)
      })
      yield* withKnownFileTools(active, ({ call, afterPermission }) => Effect.gen(function* () {
        const alias = "linked/a.txt"
        expect(value(yield* call({ name: "read", input: { path: alias } }))).toContain("outside original")
        expect((yield* call({ name: "write", input: { path: alias, content: "confirmed" } })).result.type).toBe("text")

        let moved = false
        afterPermission(Effect.promise(async () => {
          if (moved) return
          moved = true
          await fs.unlink(link)
          await fs.symlink(second, link, kind)
        }))
        const rejected = yield* call({ name: "write", input: { path: alias, content: "not written" } })
        expect(rejected.result.type).toBe("error")
        expect(value(rejected)).toContain("File target changed")
        expect(yield* Effect.promise(() => fs.readFile(path.join(outside.path, "a.txt"), "utf8"))).toBe("confirmed")
        expect(yield* Effect.promise(() => fs.readFile(path.join(second, "a.txt"), "utf8"))).toBe("second original")
      }))
    }).pipe(Effect.scoped)),
  )

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
