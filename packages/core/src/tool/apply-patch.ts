export * as ApplyPatchTool from "./apply-patch"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { Database } from "../database/database"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { Patch } from "../patch"
import { WorkspaceCheckout } from "../session/workspace/checkout"
import { LegacyDelegationGuard } from "../session/legacy-delegation/guard"
import { PermissionV2 } from "../permission"
import { SessionFileMutation } from "../session/file-mutation"
import { KnownFileMutation } from "./known-file-mutation"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "apply_patch"
export const MAX_PATCH_CHARS = 1_000_000
const ExpectedState = Schema.Union([
  Schema.Struct({ exists: Schema.Literal(false) }),
  Schema.Struct({ exists: Schema.Literal(true), sha256: Schema.String }),
])
export const Input = Schema.Struct({
  patchText: Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_PATCH_CHARS))).annotate({
    description: "One patch with add, update and delete operations, below one million characters.",
  }),
  expectedStates: Schema.Record(Schema.String, ExpectedState).pipe(Schema.optional).annotate({
    description:
      "Optional additional expected-state checks by patch path. Session read evidence is enforced automatically and cannot be replaced by these values.",
  }),
})
export const Applied = Schema.Struct({
  type: Schema.Literals(["add", "update", "delete"]),
  resource: Schema.String,
  target: Schema.String,
  checkpoint: FileMutation.Checkpoint,
})
export const Output = Schema.Struct({ applied: Schema.Array(Applied) })
export type Output = typeof Output.Type
export const toModelOutput = (output: Output) =>
  [
    "Applied patch:",
    ...output.applied.map(
      (item) => `${item.type === "add" ? "A" : item.type === "delete" ? "D" : "M"} ${item.resource}`,
    ),
  ].join("\n")

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const journal = Option.getOrUndefined(yield* Effect.serviceOption(SessionFileMutation.Service))
    const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
    const checkouts = Option.getOrUndefined(yield* Effect.serviceOption(WorkspaceCheckout.Service))
    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Apply one patch. Existing targets require this session's delivered reads (changed lines for updates, whole files for deletes). Stale or unread targets reject the entire patch before any change. New files use exclusive creation. Commit errors attempt guarded rollback; unconfirmed effects remain blocked. Never bypass conflicts through shell, generators or plugins. All external_directory and edit permissions remain required.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                if (!input.patchText.trim()) return yield* new ToolFailure({ message: "patchText is required" })
                const hunks = yield* Effect.try({
                  try: () => Patch.parse(input.patchText),
                  catch: (cause) => new ToolFailure({ message: `apply_patch verification failed: ${String(cause)}` }),
                })
                if (hunks.length === 0) return yield* new ToolFailure({ message: "patch rejected: empty patch" })
                if (hunks.some((hunk) => hunk.type === "update" && hunk.movePath !== undefined))
                  return yield* new ToolFailure({ message: "apply_patch moves are not supported yet" })
                const targets = yield* Effect.forEach(hunks, (hunk) =>
                  mutation
                    .resolve({ path: hunk.path, kind: "file" }, LocationMutation.guardedPaths)
                    .pipe(Effect.map((target) => ({ hunk, target }))),
                )
                const duplicate = targets.find(
                  (item, index) =>
                    targets.findIndex((other) => other.target.canonical === item.target.canonical) !== index,
                )
                if (duplicate)
                  return yield* new ToolFailure({
                    message: `apply_patch repeated target is not supported: ${duplicate.target.resource}`,
                  })
                yield* Effect.forEach(
                  targets,
                  ({ target }) =>
                    LegacyDelegationGuard.assertFileWrite(
                      { db: database?.db, checkouts },
                      context.sessionID,
                      target.canonical,
                    ).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message }))),
                  { discard: true },
                )
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                const external = new Map(
                  targets.flatMap(({ target }) =>
                    target.externalDirectory
                      ? [[target.externalDirectory.resource, target.externalDirectory] as const]
                      : [],
                  ),
                )
                for (const approval of external.values())
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(approval),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                yield* permission.assert({
                  action: "edit",
                  resources: [...new Set(targets.map(({ target }) => target.resource))],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                // Preparation grants no knowledge. Every derived update is subsequently
                // checked against the frozen request basis and committed via one transact.
                const operations = yield* Effect.forEach(targets, ({ hunk, target }) =>
                  Effect.gen(function* () {
                    const expected = input.expectedStates?.[hunk.path]
                    if (hunk.type === "add")
                      return {
                        type: "add",
                        path: hunk.path,
                        target,
                        content:
                          hunk.contents === "" || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`,
                        expected,
                      } satisfies KnownFileMutation.Operation
                    if ((yield* fs.stat(target.canonical)).type !== "File")
                      return yield* new ToolFailure({ message: `Not a file: ${hunk.path}` })
                    const before = yield* fs.readFile(target.canonical)
                    if (hunk.type === "delete")
                      return {
                        type: "delete",
                        path: hunk.path,
                        target,
                        before,
                        expected,
                      } satisfies KnownFileMutation.Operation
                    const update = Patch.derive(
                      hunk.path,
                      hunk.chunks,
                      new TextDecoder("utf-8", { ignoreBOM: true }).decode(before),
                    )
                    return {
                      type: "edit",
                      path: hunk.path,
                      target,
                      before,
                      content: Patch.joinBom(update.content, update.bom),
                      expected,
                    } satisfies KnownFileMutation.Operation
                  }).pipe(
                    Effect.mapError((error) =>
                      error instanceof ToolFailure
                        ? error
                        : new ToolFailure({ message: `Unable to apply patch at ${hunk.path}` }),
                    ),
                  ),
                )
                const results = yield* KnownFileMutation.commit({
                  context,
                  database,
                  files,
                  resolution: mutation,
                  journal,
                  checkouts,
                  operations,
                })
                return {
                  applied: results.map((result, index) => ({
                    type: hunks[index]!.type,
                    resource: result.resource,
                    target: result.target,
                    checkpoint: result.checkpoint,
                  })),
                }
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to apply patch" }),
                ),
              ),
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)
