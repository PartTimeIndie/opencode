export * as LSPTool from "./lsp"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { CodeIntelligence } from "../code-intelligence"
import { Config } from "../config"
import { ConfigCapabilities } from "../config/capabilities"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt, PositiveInt } from "../schema"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_RESULTS = 100
const MAX_OUTLINE_RESULTS = 500

const Position = Schema.Struct({ line: NonNegativeInt, character: NonNegativeInt })
const Range = Schema.Struct({ start: Position, end: Position })
const Symbol = Schema.Struct({
  name: Schema.String,
  detail: Schema.String.pipe(Schema.optional),
  kind: NonNegativeInt,
  file: Schema.String,
  range: Range,
  selectionRange: Range.pipe(Schema.optional),
  depth: NonNegativeInt,
  container: Schema.String.pipe(Schema.optional),
})

const Input = Schema.Struct({
  operation: Schema.Literals([
    "symbols",
    "hover",
    "definition",
    "references",
    "implementation",
    "diagnostics",
    "incoming_calls",
    "outgoing_calls",
    "status",
  ]),
  file: Schema.String.pipe(Schema.optional),
  query: Schema.String.pipe(Schema.optional),
  line: NonNegativeInt.pipe(Schema.optional),
  character: NonNegativeInt.pipe(Schema.optional),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_RESULTS)).pipe(Schema.optional),
})

const Output = Schema.Struct({
  operation: Input.fields.operation,
  items: Schema.Array(Schema.Unknown),
  truncated: Schema.Boolean,
  unavailable: Schema.String.pipe(Schema.optional),
})

const OutlineInput = Schema.Struct({
  file: Schema.String,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_OUTLINE_RESULTS)).pipe(Schema.optional),
})

const OutlineOutput = Schema.Struct({
  source: Schema.Literal("lsp"),
  symbols: Schema.Array(Symbol),
  truncated: Schema.Boolean,
  unavailable: Schema.String.pipe(Schema.optional),
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const config = yield* Config.Service
    const intelligence = yield* CodeIntelligence.Service
    const location = yield* Location.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const capabilities = ConfigCapabilities.resolve(yield* config.entries())
    const registered: Record<string, Tool.AnyTool> = {}

    if (capabilities.lsp_tools)
      registered.lsp = Tool.withPermission(
        Tool.make({
          description:
            "Query the active language server for bounded symbols, hover, definitions, references, implementations, diagnostics, status, and call hierarchy. Lines and characters are zero-based.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const provider = yield* intelligence.get(location.directory)
              if (!provider)
                return { operation: input.operation, items: [], truncated: false, unavailable: "no_lsp_provider" }
              if (input.operation === "status")
                return { operation: input.operation, items: [...(yield* provider.status())], truncated: false }

              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const authorized = new Set<string>()
              const authorize = Effect.fnUntraced(function* (resolved: LocationMutation.Target) {
                if (authorized.has(resolved.canonical)) return
                if (resolved.externalDirectory)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(resolved.externalDirectory),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                yield* permission.assert({
                  action: "read",
                  resources: [resolved.resource],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                authorized.add(resolved.canonical)
              })
              const target = input.file ? yield* mutation.resolve({ path: input.file, kind: "file" }) : undefined
              if (target) yield* authorize(target)

              const position =
                input.line === undefined || input.character === undefined
                  ? undefined
                  : { line: input.line, character: input.character }
              const requiredFile = () =>
                target
                  ? Effect.succeed(target.canonical)
                  : Effect.fail(new ToolFailure({ message: `${input.operation} requires file` }))
              const requiredPosition = () =>
                position
                  ? Effect.succeed(position)
                  : Effect.fail(new ToolFailure({ message: `${input.operation} requires line and character` }))

              const items = yield* Effect.gen(function* () {
                if (input.operation === "symbols") {
                  if (target) return yield* provider.documentSymbols(target.canonical)
                  if (!input.query) return yield* new ToolFailure({ message: "workspace symbols require query" })
                  return yield* provider.workspaceSymbols(input.query)
                }
                if (input.operation === "diagnostics") return yield* provider.diagnostics(target?.canonical)
                const file = yield* requiredFile()
                const at = yield* requiredPosition()
                if (input.operation === "hover") return yield* provider.hover(file, at)
                if (input.operation === "definition") return yield* provider.definition(file, at)
                if (input.operation === "references") return yield* provider.references(file, at)
                if (input.operation === "implementation") return yield* provider.implementation(file, at)
                if (input.operation === "incoming_calls") return yield* provider.incomingCalls(file, at)
                return yield* provider.outgoingCalls(file, at)
              })
              const resultFiles = [...new Set(items.flatMap((item) => itemFile(item)))]
              yield* Effect.forEach(resultFiles, (file) =>
                mutation.resolve({ path: file, kind: "file" }).pipe(Effect.flatMap(authorize)),
              )
              const limit = input.limit ?? 50
              return {
                operation: input.operation,
                items: [...items].slice(0, limit),
                truncated: items.length > limit,
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: `LSP ${input.operation} failed` }),
              ),
            ),
        }),
        "lsp",
      )

    if (capabilities.structural_outline)
      registered.outline = Tool.withPermission(
        Tool.make({
          description:
            "Return a compact LSP-first structural outline for one file, preserving symbol depth and source ranges.",
          input: OutlineInput,
          output: OutlineOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const target = yield* mutation.resolve({ path: input.file, kind: "file" })
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
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
              const provider = yield* intelligence.get(location.directory)
              if (!provider)
                return { source: "lsp" as const, symbols: [], truncated: false, unavailable: "no_lsp_provider" }
              const symbols = yield* provider.documentSymbols(target.canonical)
              const limit = input.limit ?? 200
              return {
                source: "lsp" as const,
                symbols: [...symbols].slice(0, limit),
                truncated: symbols.length > limit,
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to outline ${input.file}` }))),
        }),
        "lsp",
      )

    if (Object.keys(registered).length > 0) yield* tools.register(registered).pipe(Effect.orDie)
  }),
)

export const locationLayer = layer.pipe(Layer.provide(CodeIntelligence.defaultLayer))

function itemFile(item: unknown) {
  if (typeof item !== "object" || item === null || !("file" in item) || typeof item.file !== "string") return []
  return [item.file]
}
