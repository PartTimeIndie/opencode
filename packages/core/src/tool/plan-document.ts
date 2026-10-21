export * as PlanDocumentTool from "./plan-document"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { NonNegativeInt } from "../schema"
import { SessionPlanDocument } from "../session/plan-document"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "plan_document"

export const Input = Schema.Struct({
  operation: Schema.Literals(["read", "replace", "patch", "status"]),
  markdown: Schema.String.pipe(Schema.optional),
  expected: Schema.String.pipe(Schema.optional),
  replacement: Schema.String.pipe(Schema.optional),
  revision: NonNegativeInt.pipe(Schema.optional),
})

export const Output = Schema.Struct({
  operation: Schema.Literals(["read", "replace", "patch", "status"]),
  exists: Schema.Boolean,
  revision: NonNegativeInt,
  updatedAt: Schema.Finite.pipe(Schema.optional),
  markdown: Schema.String.pipe(Schema.optional),
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const documents = yield* SessionPlanDocument.Service
    const permission = yield* PermissionV2.Service
    yield* tools.register({
      [name]: Tool.make({
        description:
          "Read or atomically update the single Markdown planning document owned by this session. No filesystem path can be chosen.",
        input: Input,
        output: Output,
        toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output, null, 2) }],
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* permission.assert({
              action: name,
              resources: ["*"],
              save: ["*"],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            if (input.operation === "read" || input.operation === "status") {
              const current = yield* documents.read(context.sessionID)
              return {
                operation: input.operation,
                exists: current !== undefined,
                revision: current?.revision ?? 0,
                updatedAt: current?.updatedAt,
                markdown: input.operation === "read" ? current?.markdown : undefined,
              }
            }
            if (input.operation === "replace") {
              if (input.markdown === undefined) return yield* new ToolFailure({ message: "replace requires markdown" })
              const current = yield* documents.replace({
                sessionID: context.sessionID,
                markdown: input.markdown,
                expectedRevision: input.revision,
              })
              return {
                operation: input.operation,
                exists: true,
                revision: current.revision,
                updatedAt: current.updatedAt,
                markdown: current.markdown,
              }
            }
            if (input.expected === undefined || input.replacement === undefined)
              return yield* new ToolFailure({ message: "patch requires expected and replacement" })
            const current = yield* documents.patch({
              sessionID: context.sessionID,
              expected: input.expected,
              replacement: input.replacement,
              expectedRevision: input.revision,
            })
            return {
              operation: input.operation,
              exists: true,
              revision: current.revision,
              updatedAt: current.updatedAt,
              markdown: current.markdown,
            }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof ToolFailure ? error : new ToolFailure({ message: error.message }),
            ),
          ),
      }),
    }).pipe(Effect.orDie)
  }),
)
