export * as MemoryTool from "./memory"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Config } from "../config"
import { ConfigCapabilities } from "../config/capabilities"
import { Location } from "../location"
import { Memory } from "../memory"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { Tool } from "./tool"
import { Tools } from "./tools"

const Input = Schema.Struct({
  operation: Schema.Literals(["propose", "import_night_run", "pending", "search", "approve", "reject", "delete"]),
  id: Schema.String.pipe(Schema.optional),
  content: Schema.String.pipe(Schema.optional),
  query: Schema.String.pipe(Schema.optional),
  scope: Memory.Scope.pipe(Schema.optional),
  artifact: Schema.String.pipe(Schema.optional),
  candidates: Schema.Array(
    Schema.Struct({
      content: Schema.NonEmptyString,
      captured_at: Schema.Number,
      session_id: Schema.String.pipe(Schema.optional),
      message_id: Schema.String.pipe(Schema.optional),
    }),
  ).pipe(Schema.optional),
  provenance: Memory.Provenance.pipe(Schema.optional),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(200)).pipe(Schema.optional),
})

const Output = Schema.Struct({
  operation: Input.fields.operation,
  items: Schema.Array(Memory.Info),
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const config = yield* Config.Service
    if (!ConfigCapabilities.resolve(yield* config.entries()).reviewed_memory) return
    const memories = yield* Memory.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        memory: Tool.withPermission(
          Tool.make({
            description:
              "Propose provenance-bearing memory candidates, list pending review, search approved memories, approve or reject candidates, and delete memories. Proposed memories are never recalled until explicitly approved.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                yield* permission.assert({
                  action: `memory_${input.operation}`,
                  resources: [input.id ?? input.scope ?? "memory"],
                  save: [input.id ?? input.scope ?? "memory"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                if (input.operation === "pending")
                  return { operation: input.operation, items: yield* memories.list({ state: "pending", limit: input.limit }) }
                if (input.operation === "search")
                  return {
                    operation: input.operation,
                    items: yield* memories.recall({
                      projectID: location.project.id,
                      ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }),
                      sessionID: context.sessionID,
                      ...(input.query === undefined ? {} : { query: input.query }),
                      limit: input.limit,
                    }),
                  }
                if (input.operation === "import_night_run") {
                  if (!input.artifact || !input.candidates?.length)
                    return yield* new ToolFailure({ message: "Night Run import requires artifact and candidates" })
                  const artifact = input.artifact
                  return {
                    operation: input.operation,
                    items: yield* Effect.forEach(input.candidates, (candidate) =>
                      memories.propose({
                        scope: "project",
                        scopeKey: location.project.id,
                        content: candidate.content,
                        source: "night_run",
                        provenance: {
                          origin: artifact,
                          artifact,
                          captured_at: candidate.captured_at,
                          ...(candidate.session_id === undefined ? {} : { session_id: candidate.session_id }),
                          ...(candidate.message_id === undefined ? {} : { message_id: candidate.message_id }),
                        },
                      }),
                    ),
                  }
                }
                if (input.operation === "propose") {
                  if (!input.content || !input.provenance)
                    return yield* new ToolFailure({ message: "Memory proposals require content and provenance" })
                  const scope = input.scope ?? "project"
                  const scopeKey =
                    scope === "global"
                      ? ""
                      : scope === "project"
                        ? location.project.id
                        : scope === "workspace"
                          ? location.workspaceID
                          : context.sessionID
                  if (scopeKey === undefined)
                    return yield* new ToolFailure({ message: "Workspace-scoped memory requires a workspace" })
                  return {
                    operation: input.operation,
                    items: [
                      yield* memories.propose({
                        scope,
                        scopeKey,
                        content: input.content,
                        source: "manual",
                        provenance: input.provenance,
                      }),
                    ],
                  }
                }
                if (!input.id) return yield* new ToolFailure({ message: `${input.operation} requires id` })
                const reviewedBy = `${context.agent}:${context.sessionID}`
                const item =
                  input.operation === "delete"
                    ? yield* memories.remove(input.id, reviewedBy)
                    : yield* memories.review({
                        id: input.id,
                        decision: input.operation === "approve" ? "approved" : "rejected",
                        reviewedBy,
                      })
                return { operation: input.operation, items: item ? [item] : [] }
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure ? error : new ToolFailure({ message: `Memory ${input.operation} failed` }),
                ),
              ),
          }),
          "memory",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const locationLayer = layer
