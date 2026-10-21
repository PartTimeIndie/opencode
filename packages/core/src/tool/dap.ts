export * as DAPTool from "./dap"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Config } from "../config"
import { ConfigCapabilities } from "../config/capabilities"
import { DebugAdapter } from "../debug-adapter"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt, PositiveInt } from "../schema"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_RESULTS = 100
const Arguments = Schema.Record(Schema.String, Schema.Unknown)
const Input = Schema.Struct({
  operation: Schema.Literals([
    "launch",
    "attach",
    "set_breakpoints",
    "configuration_done",
    "threads",
    "stack_trace",
    "scopes",
    "variables",
    "evaluate",
    "continue",
    "next",
    "step_in",
    "step_out",
    "pause",
    "events",
    "disconnect",
  ]),
  adapter: Schema.String.pipe(Schema.optional),
  session: Schema.String.pipe(Schema.optional),
  arguments: Arguments.pipe(Schema.optional),
  file: Schema.String.pipe(Schema.optional),
  lines: Schema.Array(PositiveInt).pipe(Schema.optional),
  thread_id: NonNegativeInt.pipe(Schema.optional),
  frame_id: NonNegativeInt.pipe(Schema.optional),
  variables_reference: NonNegativeInt.pipe(Schema.optional),
  expression: Schema.String.pipe(Schema.optional),
  context: Schema.Literals(["watch", "repl", "hover", "clipboard", "variables"]).pipe(Schema.optional),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_RESULTS)).pipe(Schema.optional),
})
const Output = Schema.Struct({
  operation: Input.fields.operation,
  session: Schema.String.pipe(Schema.optional),
  result: Schema.Unknown,
  events: Schema.Array(Schema.Unknown),
  truncated: Schema.Boolean,
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const config = yield* Config.Service
    if (!ConfigCapabilities.resolve(yield* config.entries()).dap) return
    const dap = yield* DebugAdapter.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        dap: Tool.withPermission(
          Tool.make({
            description:
              "Control a configured Debug Adapter Protocol session. Supports launch and attach, breakpoints, stack/scopes/variables, evaluation, execution control, events, and disconnect. Result lists are bounded.",
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
                const required = (value: string | number | undefined, name: string) => {
                  if (value === undefined) return Effect.fail(new ToolFailure({ message: `${input.operation} requires ${name}` }))
                  return Effect.succeed(value)
                }
                const authorizeFile = Effect.fnUntraced(function* (file: string) {
                  const target = yield* mutation.resolve({ path: file, kind: "file" })
                  if (target.externalDirectory)
                    yield* permission.assert({
                      ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source,
                    })
                  yield* permission.assert({
                    action: "read",
                    resources: [target.resource],
                    save: ["*"],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                  return target.canonical
                })
                const bounded = (value: unknown) => {
                  if (!Array.isArray(value)) return { result: value, truncated: false }
                  const limit = input.limit ?? 50
                  return { result: value.slice(0, limit), truncated: value.length > limit }
                }

                if (input.operation === "launch" || input.operation === "attach") {
                  const adapter = yield* required(input.adapter, "adapter")
                  const args = { ...(input.arguments ?? {}) }
                  if (typeof args.program === "string") args.program = yield* authorizeFile(args.program)
                  const started = yield* dap.start({ adapter: String(adapter), mode: input.operation, arguments: args })
                  return { operation: input.operation, session: started.session, result: started.capabilities, events: [], truncated: false }
                }
                const session = String(yield* required(input.session, "session"))
                if (input.operation === "disconnect") {
                  yield* dap.disconnect(session)
                  return { operation: input.operation, session, result: null, events: [], truncated: false }
                }
                if (input.operation === "events") {
                  const values = bounded(yield* dap.events(session))
                  return { operation: input.operation, session, ...values, events: [], }
                }
                const request = (command: string, args?: Readonly<Record<string, unknown>>) =>
                  dap.request({ session, command, arguments: args })
                const result =
                  input.operation === "set_breakpoints"
                    ? yield* request("setBreakpoints", {
                        source: { path: yield* authorizeFile(String(yield* required(input.file, "file"))) },
                        breakpoints: (input.lines ?? []).map((line) => ({ line })),
                        sourceModified: false,
                      })
                    : input.operation === "configuration_done"
                      ? yield* request("configurationDone")
                      : input.operation === "threads"
                        ? yield* request("threads")
                        : input.operation === "stack_trace"
                          ? yield* request("stackTrace", { threadId: yield* required(input.thread_id, "thread_id"), startFrame: 0, levels: input.limit ?? 50 })
                          : input.operation === "scopes"
                            ? yield* request("scopes", { frameId: yield* required(input.frame_id, "frame_id") })
                            : input.operation === "variables"
                              ? yield* request("variables", { variablesReference: yield* required(input.variables_reference, "variables_reference"), start: 0, count: input.limit ?? 50 })
                              : input.operation === "evaluate"
                                ? yield* request("evaluate", {
                                    expression: yield* required(input.expression, "expression"),
                                    ...(input.frame_id === undefined ? {} : { frameId: input.frame_id }),
                                    context: input.context ?? "repl",
                                  })
                                : yield* request(
                                    input.operation === "step_in" ? "stepIn" : input.operation === "step_out" ? "stepOut" : input.operation,
                                    { threadId: yield* required(input.thread_id, "thread_id") },
                                  )
                const values = bounded(result)
                return { operation: input.operation, session, ...values, events: [...(yield* dap.events(session))].slice(-20) }
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure ? error : new ToolFailure({ message: `DAP ${input.operation} failed: ${error.message}` }),
                ),
              ),
          }),
          "dap",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const locationLayer = layer.pipe(Layer.provide(DebugAdapter.layer))
