export * as Tool from "./tool"

import { ToolDefinition, ToolFailure, ToolOutput, type ToolCall } from "@opencode-ai/llm"
import { Effect, JsonSchema, Schema } from "effect"
import type { AgentV2 } from "../agent"
import type { ModelV2 } from "../model"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"

export interface Context {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  /** Host-bound observation only; never supplied through model tool arguments. */
  readonly progress?: (snapshot: Progress) => Effect.Effect<void>
  /** Receipt watermark frozen before the provider request, never model input. */
  readonly fileKnowledgeCutoff?: number
  /** Effective materialization policy, supplied by the host, never model input. */
  readonly toolPolicy?: AgentV2.Info["tools"]
  /** Exact group results retained in the prepared model request, after bounds/transforms. */
  readonly skillGroupOutputs?: ReadonlyArray<string>
  readonly explicitInvocation?: { readonly command: string; readonly inputID: string; readonly activityID: string }
  /**
   * Additional models the executing tool may select on top of the enforced
   * agent/parent chain policy. Only trusted server code extends the policy
   * through this field and only with models proven persisted in Settings or
   * agent configuration; it is never derived from model input (for example
   * the multi-agent fanout passes its persisted Settings reviewer models
   * this way).
   */
  readonly allowedModels?: ReadonlyArray<ModelV2.Ref>
}

export type Progress = {
  readonly structured: Record<string, unknown>
  readonly content: ReadonlyArray<Content>
}

export type BudgetCategory = "read" | "poll" | "other"

export type SchemaType<A> = Schema.Codec<A, any, never, never>

declare const TypeId: unique symbol

export interface Definition<Input extends SchemaType<any>, Output extends SchemaType<any>> {
  readonly [TypeId]: {
    readonly _Input: Input
    readonly _Output: Output
  }
}

export type AnyTool = Definition<any, any>
export const Failure = ToolFailure
export type Failure = ToolFailure

export class RegistrationError extends Schema.TaggedErrorClass<RegistrationError>()("Tool.RegistrationError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string }

type Config<Input extends SchemaType<any>, Output extends SchemaType<any>> = {
  readonly description: string
  readonly input: Input
  readonly output: Output
  readonly budgetCategory?: (input: unknown) => BudgetCategory
  readonly inputSchema?: JsonSchema.JsonSchema
  readonly outputSchema?: JsonSchema.JsonSchema
  readonly validateInput?: (input: unknown) => string | undefined
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    context: Context,
  ) => Effect.Effect<Schema.Schema.Type<Output>, ToolFailure>
  readonly toModelOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => ReadonlyArray<Content>
}

type Runtime = {
  readonly budgetCategory?: (input: unknown) => BudgetCategory
  readonly permission?: string
  readonly capabilities?: ReadonlyArray<string>
  readonly alwaysVisible?: boolean
  readonly contractMarker?: string
  readonly explicitInvocation?: ReadonlyArray<string>
  readonly defaultDisabled?: boolean
  readonly definition: (name: string) => ToolDefinition
  readonly settle: (call: ToolCall, context: Context) => Effect.Effect<ToolOutput, ToolFailure>
  readonly catalog?: CatalogMetadata
}

export type CatalogMetadata = {
  readonly scope: "application" | "location"
  readonly project?: string
  readonly source?: string
  readonly version?: string
}

const runtimes = new WeakMap<AnyTool, Runtime>()

export function make<Input extends SchemaType<any>, Output extends SchemaType<any>>(
  config: Config<Input, Output>,
): Definition<Input, Output> {
  const tool = Object.freeze({}) as Definition<Input, Output>
  const definitions = new Map<string, ToolDefinition>()
  runtimes.set(tool, {
    budgetCategory: config.budgetCategory,
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = new ToolDefinition({
        name,
        description: config.description,
        inputSchema: config.inputSchema ?? toJsonSchema(config.input),
        outputSchema: config.outputSchema ?? toJsonSchema(config.output),
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (call, context) =>
      Effect.gen(function* () {
        const inputError = config.validateInput?.(call.input)
        if (inputError) return yield* new ToolFailure({ message: `Invalid tool input: ${inputError}` })
        const input = yield* Schema.decodeUnknownEffect(config.input)(call.input).pipe(
          Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
        )
        const output = yield* config.execute(input, context).pipe(
          Effect.flatMap((output) =>
            Schema.encodeEffect(config.output)(output).pipe(
              Effect.mapError(
                (error) =>
                  new ToolFailure({
                    message: `Tool returned an invalid value for its output schema: ${error.message}`,
                  }),
              ),
            ),
          ),
        )
        return {
          structured: output,
          content:
            config.toModelOutput?.({ input, output }).map((part) =>
              part.type === "text"
                ? { type: "text" as const, text: part.text }
                : {
                    type: "file" as const,
                    uri: `data:${part.mime};base64,${part.data}`,
                    mime: part.mime,
                    name: part.name,
                  },
            ) ?? (typeof output === "string" ? [{ type: "text" as const, text: output }] : []),
        }
      }),
  })
  return tool
}

export const validateName = (name: string) =>
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
    ? Effect.void
    : Effect.fail(new RegistrationError({ name, message: `Invalid tool name: ${name}` }))

export const withPermission = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  permission: string,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), permission })
  return decorated
}

export const withCapabilities = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  capabilities: ReadonlyArray<string>,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), capabilities: [...new Set(capabilities)] })
  return decorated
}

/** Internal built-in policy for pure protocol tools that must survive catalog permission filtering. */
export const withAlwaysVisible = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), alwaysVisible: true })
  return decorated
}

export const isAlwaysVisible = (tool: AnyTool) => runtimeOf(tool).alwaysVisible === true

/**
 * Scopes an always-visible protocol tool to turns whose current prompt carries
 * the given contract marker (for example a scheduled job result contract). The
 * tool stays registered and eviction-safe, but the registry only advertises it
 * when the runner passes turn context whose text contains the marker.
 */
export const withContractMarker = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  marker: string,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), contractMarker: marker })
  return decorated
}

export const contractMarker = (tool: AnyTool): string | undefined => runtimeOf(tool).contractMarker
export const explicitInvocation = (tool: AnyTool): ReadonlyArray<string> | undefined =>
  runtimeOf(tool).explicitInvocation
export const withExplicitInvocation = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  command: string | ReadonlyArray<string>,
) => {
  const commands = typeof command === "string" ? [command] : command
  if (
    !Array.isArray(commands) ||
    !commands.length ||
    commands.some((name) => typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
  )
    throw new Error("Explicit invocation requires exact lowercase slash-command names without /")
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), explicitInvocation: Object.freeze([...new Set(commands)]) })
  return decorated
}
export const isDefaultDisabled = (tool: AnyTool) => runtimeOf(tool).defaultDisabled === true
export const withDefaultDisabled = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), defaultDisabled: true })
  return decorated
}
export const withCatalog = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  catalog: CatalogMetadata,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), catalog })
  return decorated
}
export const catalog = (tool: AnyTool) => runtimeOf(tool).catalog
export const permission = (tool: AnyTool, name: string) => runtimeOf(tool).permission ?? name
export const capabilities = (tool: AnyTool) => runtimeOf(tool).capabilities ?? []
export const hasBudgetCategory = (tool: AnyTool) => runtimeOf(tool).budgetCategory !== undefined
export const budgetCategory = (tool: AnyTool, input: unknown): BudgetCategory =>
  runtimeOf(tool).budgetCategory?.(input) ?? "other"
export const definition = (name: string, tool: AnyTool) => runtimeOf(tool).definition(name)
export const settle = (tool: AnyTool, call: ToolCall, context: Context) => runtimeOf(tool).settle(call, context)

function runtimeOf(tool: AnyTool) {
  const runtime = runtimes.get(tool)
  if (!runtime) throw new TypeError("Invalid Core Tool value")
  return runtime
}

function toJsonSchema(schema: Schema.Top): JsonSchema.JsonSchema {
  const document = Schema.toJsonSchemaDocument(schema)
  if (Object.keys(document.definitions).length === 0) return document.schema
  return { ...document.schema, $defs: document.definitions }
}
