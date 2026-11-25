export * as MirrorIntegrateTool from "./mirror-integrate"

import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import { Database } from "../database/database"
import { PermissionV2 } from "../permission"
import { MirrorClose } from "../session/workspace/mirror-close"
import { MirrorSession } from "../session/workspace/mirror-session"
import { SessionStore } from "../session/store"
import { WorkspaceCheckout } from "../session/workspace/checkout"
import { SessionFileMutation } from "../session/file-mutation"
import { FileMutation } from "../file-mutation"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "mirror_integrate"

export const description = `Prepare or apply one reviewed source update from this Session's standalone mirror.

Phase 1 (omit plan_digest) is read-only: it derives three-way candidates from the mirror's captured basis, its private workspace and the current source checkout, returning the changed files with digests plus a plan digest, or explicit conflicts.

Phase 2 (set plan_digest from phase 1) applies exactly that plan: the source is re-derived first, any drift refuses without partial writes, one fresh single-use host approval is required for this exact plan, changes commit through the guarded multi-target transaction with before/after hashes and modes, and every mutation is recorded in this session's file-mutation journal. Afterwards the mirror is marked integrated; deleting it stays a separate explicit discard.

This is the only supported route from a standalone mirror back into the source; the mirror CLI never writes the source. Never edit the source yourself between the two phases and never reuse a plan after the source changed.`

const Input = Schema.Struct({
  plan_digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(Schema.optional).annotate({
    description: "The plan digest from a previous read-only preparation. Setting this requests the reviewed application.",
  }),
}).annotate({ identifier: "MirrorIntegrateTool.Input" })

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
  integrated: Schema.Boolean.pipe(Schema.optional),
  marker_error: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "MirrorIntegrateTool.Output" })
export type Output = typeof Output.Type

const failure = (error: unknown) =>
  new ToolFailure({ message: error instanceof Error ? error.message : `Mirror integration refused: ${String(error)}` })

export const layerWith = <R>(dependencies: Effect.Effect<MirrorClose.Dependencies, never, R>) =>
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
                resources: [context.sessionID],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${name}` })))
              .pipe(Effect.andThen(Effect.gen(function* () {
                const session = yield* integration.store.get(context.sessionID)
                if (!session || session.revert || session.time.archived)
                  return yield* new ToolFailure({ message: "No live Session for a standalone mirror integration" })
                const root = MirrorSession.defaultRoot(process.env.XDG_DATA_HOME)
                if (input.plan_digest === undefined) {
                  const plan = yield* Effect.tryPromise({
                    try: () => MirrorClose.close({ directory: session.location.directory, sessionID: context.sessionID, root }),
                    catch: (cause) => failure(cause),
                  })
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
                const applied = yield* MirrorClose.integrate(integration, {
                  sessionID: context.sessionID, agent: context.agent, planDigest: input.plan_digest, root,
                  assistantMessageID: context.assistantMessageID, callID: context.toolCallID,
                }).pipe(Effect.mapError(failure))
                return { status: "applied" as const, applied: applied.applied, integrated: applied.integrated,
                  ...(applied.markerError === undefined ? {} : { marker_error: applied.markerError }) }
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
    const permission = yield* PermissionV2.Service
    const checkouts = yield* WorkspaceCheckout.Service.pipe(Effect.provide(WorkspaceCheckout.layer))
    const journal = yield* SessionFileMutation.Service
    const files = yield* FileMutation.Service
    return { db, store, permission, checkouts, files, journal }
  }),
)
