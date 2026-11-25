/**
 * Model-facing V2 file-write leaf. External targets require separate
 * external_directory approval before edit approval, regardless of path form.
 * Named project references
 * are read-oriented and deliberately are not accepted by mutation tools.
 */
export * as WriteTool from "./write"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { FileMutation } from "../file-mutation"
import { LocationMutation } from "../location-mutation"
import { WorkspaceCheckout } from "../session/workspace/checkout"
import { LegacyDelegationGuard } from "../session/legacy-delegation/guard"
import { PermissionV2 } from "../permission"
import { SessionFileMutation } from "../session/file-mutation"
import { Database } from "../database/database"
import { FSUtil } from "../fs-util"
import { KnownFileMutation } from "./known-file-mutation"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "write"

export const Input = Schema.Struct({
  path: Schema.String.pipe(Schema.optional).annotate({
    description:
      "File path to write. Relative paths resolve from the active Location. External targets, including those reached via links, require external_directory approval.",
  }),
  filePath: Schema.String.pipe(Schema.optional).annotate({
    description: "Legacy provider alias for path",
  }),
  content: Schema.String.annotate({ description: "Content to write to the file" }),
  expectedSha256: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Optional extra SHA-256 check. The session's read evidence is enforced automatically, without manual hashes.",
  }),
  expectedAbsent: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Set true to create only when the target does not exist",
  }),
})

const writePath = (input: Pick<typeof Input.Type, "path" | "filePath">) => input.path ?? input.filePath ?? ""

const validateInput = (input: unknown) => {
  if (typeof input !== "object" || input === null) return
  if (!("path" in input) && !("filePath" in input)) return "path or filePath is required"
  if (
    "path" in input &&
    typeof input.path === "string" &&
    "filePath" in input &&
    typeof input.filePath === "string" &&
    input.path !== input.filePath
  )
    return "path and filePath must match when both are provided"
}

export const Output = Schema.Struct({
  operation: Schema.Literal("write"),
  target: Schema.String,
  resource: Schema.String,
  existed: Schema.Boolean,
  checkpoint: FileMutation.Checkpoint,
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  `${output.existed ? "Wrote" : "Created"} file successfully: ${output.resource}`

/** Deferred V2 write UX integrations remain visible at the model-facing seam. */
// TODO: Add formatter integration after V2 formatter runtime exists.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after design exists.
// TODO: Add LSP notification and diagnostics after V2 LSP runtime exists.

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const permission = yield* PermissionV2.Service
    const journal = Option.getOrUndefined(yield* Effect.serviceOption(SessionFileMutation.Service))
    const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
    const checkouts = Option.getOrUndefined(yield* Effect.serviceOption(WorkspaceCheckout.Service))
    const fs =
      Option.getOrUndefined(yield* Effect.serviceOption(FSUtil.Service)) ??
      (yield* FSUtil.Service.pipe(Effect.provide(FSUtil.defaultLayer)))

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Write one file. Existing files require a prior complete read delivered to this session; stale versions are rejected. Confirmed own writes need no extra read. New files use exclusive creation. User claims or permission approval are not read evidence. Never bypass a conflict using shell, generators or plugins. External targets require external_directory approval before edit approval.",
            input: Input,
            output: Output,
            validateInput,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) => {
              const resource = writePath(input)
              return Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                if (input.expectedSha256 && input.expectedAbsent)
                  return yield* new ToolFailure({
                    message: "Choose either expectedSha256 or expectedAbsent, not both.",
                  })
                const target = yield* mutation.resolve({ path: resource, kind: "file" }, LocationMutation.guardedPaths)
                yield* LegacyDelegationGuard.assertFileWrite(
                  { db: database?.db, checkouts },
                  context.sessionID,
                  target.canonical,
                ).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
                const external = target.externalDirectory
                if (external)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                yield* permission.assert({
                  action: "edit",
                  resources: [target.resource],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                const before = yield* fs
                  .readFile(target.canonical)
                  .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
                const bom =
                  Boolean(before && before[0] === 0xef && before[1] === 0xbb && before[2] === 0xbf) ||
                  input.content.startsWith("\uFEFF")
                const content = `${bom ? "\uFEFF" : ""}${input.content.replace(/^\uFEFF+/, "")}`
                const results = yield* KnownFileMutation.commit({
                  context,
                  database,
                  files,
                  resolution: mutation,
                  journal,
                  checkouts,
                  operations: [
                    {
                      type: "write",
                      path: resource,
                      target,
                      before,
                      content,
                      expected: input.expectedSha256
                        ? { exists: true, sha256: input.expectedSha256 }
                        : input.expectedAbsent
                          ? { exists: false }
                          : undefined,
                    },
                  ],
                })
                const result = results[0]
                if (!result || result.operation !== "write")
                  return yield* new ToolFailure({ message: "Write result was not confirmed." })
                return result
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure
                    ? error
                    : error instanceof FileMutation.StaleContentError
                      ? new ToolFailure({ message: `Stale SHA-256 for ${resource}. Read the file again.` })
                      : error instanceof FileMutation.TargetExistsError
                        ? new ToolFailure({ message: `Target already exists: ${resource}` })
                        : new ToolFailure({ message: `Unable to write ${resource}` }),
                ),
              )
            },
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)
