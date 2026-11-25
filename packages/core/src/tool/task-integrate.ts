export * as TaskIntegrateTool from "./task-integrate"

import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import { Database } from "../database/database"
import { PermissionV2 } from "../permission"
import { ContentStore } from "../content-store"
import { TaskIntegration } from "../session/task-integration"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { WorkspaceCheckout } from "../session/workspace/checkout"
import { SessionFileMutation } from "../session/file-mutation"
import { FileMutation } from "../file-mutation"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "task_integrate"

export const description = `Prepare or apply one reviewed Main update from a finished mirror task.

Phase 1 (omit plan_digest) is read-only: it derives three-way candidates from the terminal child's immutable basis, its private mirror and the current Main checkout, returning the changed files with digests plus a plan digest, or explicit conflicts.

Phase 2 (set plan_digest from phase 1) applies exactly that plan: Main is re-derived first, any drift refuses without partial writes, one fresh single-use host approval is required for this exact plan, changes commit through the guarded multi-target transaction with before/after hashes and modes, and every mutation is recorded in this session's file-mutation journal.

Never use this while the child is still running, never edit Main yourself between the two phases, and never reuse a plan after Main changed. Permission and file knowledge rules for your own writes are unaffected; this operation is the reviewed batch path for a delegated mirror result.`

const Input = Schema.Struct({
  task_id: Schema.String.annotate({
    description: "The terminal child Session ID whose mirror result should update Main. Not a result handle.",
  }),
  paths: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: "Optional repository-relative subset of the child's captured basis. Omit to consider every captured path.",
  }),
  plan_digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(Schema.optional).annotate({
    description: "The plan digest from a previous read-only preparation. Setting this requests the reviewed application.",
  }),
}).annotate({ identifier: "TaskIntegrateTool.Input" })

const Change = Schema.Struct({
  path: Schema.String,
  operation: Schema.Literals(["write", "delete"]),
  sha256: Schema.NullOr(Schema.String),
  bytes: Schema.NullOr(Schema.Int),
  mode: Schema.NullOr(Schema.Int),
  main_sha256: Schema.NullOr(Schema.String),
})

const Output = Schema.Struct({
  status: Schema.Literals(["conflicts", "ready", "applied"]),
  plan_digest: Schema.String.pipe(Schema.optional),
  changes: Schema.Array(Change).pipe(Schema.optional),
  conflicts: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })).pipe(Schema.optional),
  applied: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.NullOr(Schema.String) }))
    .pipe(Schema.optional),
}).annotate({ identifier: "TaskIntegrateTool.Output" })
export type Output = typeof Output.Type

const failure = (error: unknown) =>
  new ToolFailure({ message: error instanceof Error ? error.message : `Task integration refused: ${String(error)}` })

export const layerWith = <R>(dependencies: Effect.Effect<TaskIntegration.Dependencies, never, R>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const tools = yield* Tools.Service
      const permission = yield* PermissionV2.Service
      const integration = yield* dependencies
      const registered = tools.register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) =>
            permission
              .assert({
                action: name,
                resources: [input.task_id],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${name}` })))
              .pipe(Effect.andThen(Effect.gen(function* () {
                const childID = SessionSchema.ID.make(input.task_id)
                if (input.plan_digest === undefined) {
                  const plan = yield* TaskIntegration.prepare(integration, {
                    parentID: context.sessionID, childID, ...(input.paths === undefined ? {} : { paths: input.paths }),
                  }).pipe(Effect.mapError(failure))
                  return plan.status === "conflicts"
                    ? { status: "conflicts" as const, conflicts: plan.conflicts }
                    : {
                        status: "ready" as const,
                        plan_digest: plan.planDigest,
                        changes: plan.changes.map((change) => ({
                          path: change.path, operation: change.operation, sha256: change.sha256,
                          bytes: change.bytes, mode: change.mode, main_sha256: change.mainSha256,
                        })),
                      }
                }
                const applied = yield* TaskIntegration.apply(integration, {
                  parentID: context.sessionID, childID, parentAgent: context.agent, planDigest: input.plan_digest,
                  ...(input.paths === undefined ? {} : { paths: input.paths }),
                  assistantMessageID: context.assistantMessageID, callID: context.toolCallID,
                }).pipe(Effect.mapError(failure))
                return { status: "applied" as const, applied: applied.applied }
              }))),
        }),
      })
      yield* registered.pipe(Effect.orDie)
    }),
  )

export const locationLayer = layerWith(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const store = yield* SessionStore.Service
    const content = yield* ContentStore.Service
    const permission = yield* PermissionV2.Service
    const checkouts = yield* WorkspaceCheckout.Service.pipe(Effect.provide(WorkspaceCheckout.layer))
    const journal = yield* SessionFileMutation.Service
    const files = yield* FileMutation.Service
    return { db, store, content, permission, checkouts, files, journal }
  }),
)
