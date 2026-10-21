import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { Database } from "@opencode-ai/core/database/database"
import { fileKnowledgeBaseline } from "./fixture/file-knowledge-baseline"
import { Config } from "@opencode-ai/core/config"
import { ConfigCapabilities } from "@opencode-ai/core/config/capabilities"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ApplyPatchTool } from "@opencode-ai/core/tool/apply-patch"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_apply_patch_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let denyAction: string | undefined
let failRemoveTarget: string | undefined
let readsBeforeEditApproval = 0
let editApproved = false
let blockRemoveTarget: string | undefined
let removeStarted: Deferred.Deferred<void> | undefined
let releaseRemove: Deferred.Deferred<void> | undefined
let afterEditApproval = (): Effect.Effect<void> => Effect.void
let afterReadFile = (_target: string, _content: Uint8Array): Effect.Effect<void> => Effect.void

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => {
        assertions.push(input)
        if (input.action === "edit") editApproved = true
      }).pipe(
        Effect.andThen(input.action === "edit" ? Effect.suspend(afterEditApproval) : Effect.void),
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.DeniedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const reset = () => {
  assertions.length = 0
  denyAction = undefined
  failRemoveTarget = undefined
  readsBeforeEditApproval = 0
  editApproved = false
  blockRemoveTarget = undefined
  removeStarted = undefined
  releaseRemove = undefined
  afterEditApproval = () => Effect.void
  afterReadFile = () => Effect.void
}

const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      readFile: (target) =>
        Effect.sync(() => {
          if (!editApproved) readsBeforeEditApproval++
        }).pipe(
          Effect.andThen(fs.readFile(target)),
          Effect.tap((content) => Effect.suspend(() => afterReadFile(target, content))),
        ),
      remove: (target, options) => {
        if (failRemoveTarget && path.basename(target) === failRemoveTarget) return Effect.die("forced remove failure")
        if (blockRemoveTarget && path.basename(target) === blockRemoveTarget && removeStarted && releaseRemove)
          return Deferred.succeed(removeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRemove)),
            Effect.andThen(fs.remove(target, options)),
          )
        return fs.remove(target, options)
      },
    })
  }),
).pipe(Layer.provide(FSUtil.defaultLayer))

const withTool = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  guarded = false,
  extraFiles: string[] = [],
) => {
  const database = Database.layerFromPath(":memory:")
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  const resolution = LocationMutation.layer.pipe(Layer.provide(filesystem), Layer.provide(activeLocation))
  const mutation = FileMutation.layer.pipe(Layer.provide(filesystem))
  const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({
              capabilities: new ConfigCapabilities.Info({ guarded_mutations: guarded }),
            }),
          }),
        ]),
    }),
  )
  const patch = ApplyPatchTool.layer.pipe(
    Layer.provide(database),
    Layer.provide(registry),
    Layer.provide(permission),
    Layer.provide(resolution),
    Layer.provide(mutation),
    Layer.provide(filesystem),
    Layer.provide(config),
  )
  return Effect.gen(function* () {
    fileKnowledgeCutoff = yield* fileKnowledgeBaseline(
      directory,
      sessionID,
      toolIdentity.assistantMessageID,
      extraFiles,
    )
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(Effect.provide(Layer.mergeAll(database, registry, resolution, mutation, config, patch)))
}

let fileKnowledgeCutoff = 0
const call = (patchText: string, id = "call-apply-patch") => ({
  sessionID,
  fileKnowledgeCutoff,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "apply_patch", input: { patchText } },
})

const exists = (target: string) =>
  Effect.promise(() =>
    fs.stat(target).then(
      () => true,
      () => false,
    ),
  )
const it = testEffect(Layer.empty)
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

describe("ApplyPatchTool", () => {
  it.live("registers and transactionally applies add, update, and delete hunks", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const update = path.join(tmp.path, "update.txt")
        const remove = path.join(tmp.path, "remove.txt")
        return Effect.promise(() =>
          Promise.all([fs.writeFile(update, "before\n"), fs.writeFile(remove, "remove\n")]),
        ).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["apply_patch"])
                expect(yield* toolDefinitions(registry, [{ action: "edit", resource: "*", effect: "deny" }])).toEqual(
                  [],
                )
                const settled = yield* settleTool(
                  registry,
                  call(
                    "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Update File: update.txt\n@@\n-before\n+after\n*** Delete File: remove.txt\n*** End Patch",
                  ),
                )
                expect(settled.result).toEqual({
                  type: "text",
                  value: "Applied patch:\nA nested/new.txt\nM update.txt\nD remove.txt",
                })
                expect(settled.output?.structured).toMatchObject({
                  applied: [
                    { type: "add", resource: "nested/new.txt" },
                    { type: "update", resource: "update.txt" },
                    { type: "delete", resource: "remove.txt" },
                  ],
                })
                expect(assertions).toMatchObject([
                  { sessionID, action: "edit", resources: ["nested/new.txt", "update.txt", "remove.txt"], save: ["*"] },
                ])
                expect(readsBeforeEditApproval).toBe(0)
                expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "nested/new.txt"), "utf8"))).toBe(
                  "created\n",
                )
                expect(yield* Effect.promise(() => fs.readFile(update, "utf8"))).toBe("after\n")
                expect(yield* exists(remove)).toBe(false)
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("atomically applies a fully guarded add, update, and delete patch", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const update = path.join(tmp.path, "update.txt")
        const remove = path.join(tmp.path, "remove.txt")
        return Effect.promise(() =>
          Promise.all([fs.writeFile(update, "before\n"), fs.writeFile(remove, "remove\n")]),
        ).pipe(
          Effect.andThen(
            withTool(
              tmp.path,
              (registry) =>
                settleTool(registry, {
                  sessionID,
                  fileKnowledgeCutoff,
                  ...toolIdentity,
                  call: {
                    type: "tool-call",
                    id: "call-guarded-patch",
                    name: "apply_patch",
                    input: {
                      patchText:
                        "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Update File: update.txt\n@@\n-before\n+after\n*** Delete File: remove.txt\n*** End Patch",
                      expectedStates: {
                        "nested/new.txt": { exists: false },
                        "update.txt": { exists: true, sha256: sha256("before\n") },
                        "remove.txt": { exists: true, sha256: sha256("remove\n") },
                      },
                    },
                  },
                }),
              true,
            ),
          ),
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              expect(settled.output?.structured).toMatchObject({
                applied: [{ type: "add" }, { type: "update" }, { type: "delete" }],
              })
              expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "nested/new.txt"), "utf8"))).toBe(
                "created\n",
              )
              expect(yield* Effect.promise(() => fs.readFile(update, "utf8"))).toBe("after\n")
              expect(yield* exists(remove)).toBe(false)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects oversized patches before requesting edit permission", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const result = yield* executeTool(registry, call("x".repeat(ApplyPatchTool.MAX_PATCH_CHARS + 1)))
            expect(result.type).toBe("error")
            if (result.type === "error") expect(result.value).toContain("at most 1000000")
            expect(assertions).toEqual([])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects moves before applying any hunk", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const source = path.join(tmp.path, "old.txt")
        return Effect.promise(() => fs.writeFile(source, "before\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(
                      "*** Begin Patch\n*** Add File: created.txt\n+created\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-before\n+after\n*** End Patch",
                    ),
                  ),
                ).toEqual({ type: "error", value: "apply_patch moves are not supported yet" })
                expect(yield* exists(path.join(tmp.path, "created.txt"))).toBe(false)
                expect(assertions).toEqual([])
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects repeated targets before applying any hunk", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "same.txt")
        return Effect.promise(() => fs.writeFile(target, "one\ntwo\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(
                      "*** Begin Patch\n*** Update File: same.txt\n@@\n-one\n+ONE\n*** Update File: same.txt\n@@\n-two\n+TWO\n*** End Patch",
                    ),
                  ),
                ).toEqual({
                  type: "error",
                  value: "apply_patch repeated target is not supported: same.txt",
                })
                expect(assertions).toEqual([])
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("one\ntwo\n")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("approves an external directory and the batch before reading external update content", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const target = path.join(outside.path, "external.txt")
        return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
          Effect.andThen(
            withTool(
              active.path,
              (registry) =>
                Effect.gen(function* () {
                  expect(
                    yield* executeTool(
                      registry,
                      call(`*** Begin Patch\n*** Update File: ${target}\n@@\n-before\n+after\n*** End Patch`),
                    ),
                  ).toMatchObject({ type: "text" })
                  expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
                  expect(readsBeforeEditApproval).toBe(0)
                  expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after\n")
                }),
              false,
              [target],
            ),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("approves one external directory scope for multiple files under the same parent", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const first = path.join(outside.path, "first.txt")
        const second = path.join(outside.path, "second.txt")
        return Effect.promise(() =>
          Promise.all([fs.writeFile(first, "before\n"), fs.writeFile(second, "before\n")]),
        ).pipe(
          Effect.andThen(
            withTool(
              active.path,
              (registry) =>
                Effect.gen(function* () {
                  expect(
                    yield* executeTool(
                      registry,
                      call(
                        `*** Begin Patch\n*** Update File: ${first}\n@@\n-before\n+after\n*** Update File: ${second}\n@@\n-before\n+after\n*** End Patch`,
                      ),
                    ),
                  ).toMatchObject({ type: "text" })
                  expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
                  expect(assertions[0]?.resources).toEqual([
                    path.join(yield* Effect.promise(() => fs.realpath(outside.path)), "*").replaceAll("\\", "/"),
                  ])
                }),
              false,
              [first, second],
            ),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not read or apply when edit approval is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        denyAction = "edit"
        const target = path.join(tmp.path, "denied.txt")
        return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call("*** Begin Patch\n*** Update File: denied.txt\n@@\n-before\n+after\n*** End Patch"),
                  ),
                ).toEqual({ type: "error", value: "Unable to apply patch" })
                expect(assertions.map((input) => input.action)).toEqual(["edit"])
                expect(readsBeforeEditApproval).toBe(0)
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before\n")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves BOM and CRLF line endings when updating", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "windows.txt")
        return Effect.promise(() => fs.writeFile(target, "\uFEFFbefore\r\nrest\r\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call("*** Begin Patch\n*** Update File: windows.txt\n@@\n-before\n+after\n*** End Patch"),
                  ),
                ).toMatchObject({ type: "text" })
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("\uFEFFafter\r\nrest\r\n")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects invalid later update before applying an earlier add", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect(
              yield* executeTool(
                registry,
                call(
                  "*** Begin Patch\n*** Add File: created.txt\n+created\n*** Update File: missing.txt\n@@\n-before\n+after\n*** End Patch",
                ),
              ),
            ).toEqual({ type: "error", value: "Unable to apply patch at missing.txt" })
            expect(yield* exists(path.join(tmp.path, "created.txt"))).toBe(false)
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects add hunks targeting an existing file without replacing it", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "existing.txt")
        return Effect.promise(() => fs.writeFile(target, "sentinel\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call("*** Begin Patch\n*** Add File: existing.txt\n+replacement\n*** End Patch"),
                  ),
                ).toEqual({ type: "error", value: "Target already exists: existing.txt" })
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("sentinel\n")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects an add target that appears during permission approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "appeared.txt")
        afterEditApproval = () => Effect.promise(() => fs.writeFile(target, "winner\n")).pipe(Effect.orDie)
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect(
              yield* executeTool(
                registry,
                call("*** Begin Patch\n*** Add File: appeared.txt\n+replacement\n*** End Patch"),
              ),
            ).toEqual({ type: "error", value: "Target already exists: appeared.txt" })
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("winner\n")
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects an update target that changes after patch preparation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "stale.txt")
        afterReadFile = (readTarget) => {
          if (path.basename(readTarget) !== "stale.txt") return Effect.void
          afterReadFile = () => Effect.void
          return Effect.promise(() => fs.writeFile(target, "newer\n"))
        }
        return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call("*** Begin Patch\n*** Update File: stale.txt\n@@\n-before\n+after\n*** End Patch"),
                  ),
                ).toEqual({
                  type: "error",
                  value: `File changed while waiting: ${target}; current SHA-256: ${createHash("sha256").update("newer\n").digest("hex")}. Read the file again. No files were changed.`,
                })
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("newer\n")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rolls back earlier effects while preserving a later commit defect", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const first = path.join(tmp.path, "first.txt")
        const second = path.join(tmp.path, "second.txt")
        failRemoveTarget = path.basename(second)
        return Effect.promise(() => Promise.all([fs.writeFile(first, "first"), fs.writeFile(second, "second")])).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  Exit.isFailure(
                    yield* executeTool(
                      registry,
                      call("*** Begin Patch\n*** Delete File: first.txt\n*** Delete File: second.txt\n*** End Patch"),
                    ).pipe(Effect.exit),
                  ),
                ).toBe(true)
                expect(yield* exists(first)).toBe(true)
                expect(yield* Effect.promise(() => fs.readFile(first, "utf8"))).toBe("first")
                expect(yield* exists(second)).toBe(true)
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("finishes the sequential commit phase when interrupted after the first mutation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const first = path.join(tmp.path, "first.txt")
        const second = path.join(tmp.path, "second.txt")
        blockRemoveTarget = path.basename(second)
        return Effect.gen(function* () {
          removeStarted = yield* Deferred.make<void>()
          releaseRemove = yield* Deferred.make<void>()
          yield* Effect.promise(() => Promise.all([fs.writeFile(first, "first"), fs.writeFile(second, "second")]))
          yield* withTool(tmp.path, (registry) =>
            Effect.gen(function* () {
              const run = yield* executeTool(
                registry,
                call("*** Begin Patch\n*** Delete File: first.txt\n*** Delete File: second.txt\n*** End Patch"),
              ).pipe(Effect.forkChild)
              yield* Deferred.await(removeStarted!)
              const interrupt = yield* Fiber.interrupt(run).pipe(Effect.forkChild)
              yield* Deferred.succeed(releaseRemove!, undefined)
              yield* Fiber.join(interrupt)
              expect(yield* exists(first)).toBe(false)
              expect(yield* exists(second)).toBe(false)
            }),
          )
        })
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
