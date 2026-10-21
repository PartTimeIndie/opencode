export * as ToolRegistry from "./registry"

import { ToolDefinition, ToolOutput, type ToolCall, type ToolResultValue } from "@opencode-ai/llm"
import { Context, Effect, Layer, Option, Scope } from "effect"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { ConfigOptimization } from "../config/optimization"
import { ConfigAgent } from "../config/agent"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { PluginV2 } from "../plugin"
import { Perf } from "../observability/perf"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { CapabilityLease } from "../capability/lease"
import { ShellCommandAccess } from "../permission/shell-command-access"
import {
  Tool,
  capabilities,
  contractMarker,
  definition,
  catalog as catalogMetadata,
  isAlwaysVisible,
  isDefaultDisabled,
  permission,
  RegistrationError,
  settle,
  validateName,
  type AnyTool,
} from "./tool"
import { Tools } from "./tools"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
  readonly skillGroupOutputs?: ReadonlyArray<string>
  readonly fileKnowledgeCutoff?: number
}

export interface Interface {
  readonly materialize: (
    permissions?: PermissionV2.Ruleset,
    policy?: AgentV2.Info["tools"],
    context?: MaterializationContext,
  ) => Effect.Effect<Materialization>
  readonly catalog: (
    permissions?: PermissionV2.Ruleset,
    context?: MaterializationContext,
  ) => Effect.Effect<ReadonlyArray<CatalogEntry>>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export type MaterializationContext = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  /**
   * Text of the current turn's latest user prompt. Contract-scoped tools
   * (for example the scheduler result tool) are only advertised when this
   * text carries their marker, so ordinary chat turns never see them.
   */
  readonly lastUserText?: string
}

export interface CatalogEntry {
  readonly id: string
  readonly description: string
  readonly scope: "application" | "location"
  readonly project?: string
  readonly source?: string
  readonly version?: string
  readonly visible: boolean
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly budgetCategory: (call: Pick<ToolCall, "name" | "input">) => Tool.BudgetCategory
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolRegistry") {}

export function budgetCategory(toolName: string, tool: AnyTool | undefined, input: unknown): Tool.BudgetCategory {
  if (tool && Tool.hasBudgetCategory(tool)) return Tool.budgetCategory(tool, input)
  if (
    toolName === "read" ||
    toolName === "grep" ||
    toolName === "glob" ||
    toolName === "websearch" ||
    toolName === "webfetch"
  )
    return "read"
  if (toolName === "bash") {
    const command =
      typeof input === "object" && input !== null && "command" in input
        ? (input as { readonly command?: unknown }).command
        : undefined
    return typeof command === "string" && ShellCommandAccess.classify(command) === "read" ? "read" : "poll"
  }
  return "other"
}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    const config = yield* Effect.serviceOption(Config.Service)
    const location = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
    const plugin = Option.getOrUndefined(yield* Effect.serviceOption(PluginV2.Service))
    const capabilityLeases = Option.getOrUndefined(yield* Effect.serviceOption(CapabilityLease.Service))
    // Location config is static for this layer; toggling the feature requires reopening the location.
    const materializationCacheEnabled = Option.isSome(config)
      ? ConfigOptimization.resolve(
          yield* config.value.entries().pipe(Effect.catch(() => Effect.succeed([] as Config.Entry[]))),
        ).features.tool_materialization_cache
      : false
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()
    const materializationCache = new Map<string, Materialization>()
    const identityIDs = new WeakMap<object, number>()
    let identityCounter = 0

    const identityID = (identity: object) => {
      const cached = identityIDs.get(identity)
      if (cached !== undefined) return cached
      identityCounter++
      identityIDs.set(identity, identityCounter)
      return identityCounter
    }

    const cacheKey = (
      registrations: ReadonlyMap<string, Registration>,
      permissions: PermissionV2.Ruleset,
      pluginGeneration: number,
      capabilitySnapshot: CapabilityLease.Snapshot,
    ) =>
      JSON.stringify({
        tools: Array.from(registrations, ([name, registration]) => [
          name,
          identityID(registration.identity),
          permission(registration.tool, name),
          isAlwaysVisible(registration.tool),
          isDefaultDisabled(registration.tool),
          capabilities(registration.tool),
        ]),
        permissions,
        pluginGeneration,
        capabilitySnapshot,
      })

    const remember = (key: string, materialization: Materialization) => {
      materializationCache.set(key, materialization)
      if (materializationCache.size <= 64) return materialization
      const oldest = materializationCache.keys().next().value
      if (oldest !== undefined) materializationCache.delete(oldest)
      return materialization
    }

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (
      input: ExecuteInput,
      advertised?: object,
      policy?: AgentV2.Info["tools"],
    ) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ?? applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
        fileKnowledgeCutoff: input.fileKnowledgeCutoff,
        ...(policy ? { toolPolicy: policy } : {}),
        ...(input.skillGroupOutputs ? { skillGroupOutputs: input.skillGroupOutputs } : {}),
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources.bound({
        sessionID: input.sessionID,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
        tool: input.call.name,
        output,
      })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths }
        : { result, output: bounded.output }
    })

    const materializeDefinitions = Effect.fn("ToolRegistry.materializeDefinitions")(function* (
      registrations: ReadonlyMap<string, Registration>,
      capabilitySnapshot: CapabilityLease.Snapshot,
      policy?: AgentV2.Info["tools"],
    ) {
      const definitions = yield* Effect.forEach(
        Array.from(registrations),
        Effect.fnUntraced(function* ([name, registration]) {
          const base = definition(name, registration.tool)
          if (!plugin) return base
          const output = yield* plugin.trigger(
            "tool.definition",
            { toolID: name },
            {
              description: base.description,
              parameters: base.inputSchema,
              outputSchema: base.outputSchema,
              cache: base.cache,
              metadata: base.metadata,
              native: base.native,
            },
          )
          return ToolDefinition.make({
            name: base.name,
            description: output.description,
            inputSchema: output.inputSchema ?? output.parameters,
            outputSchema: output.outputSchema,
            cache: output.cache,
            metadata: output.metadata,
            native: output.native,
          })
        }),
        { concurrency: "unbounded" },
      )
      return {
        definitions,
        budgetCategory: (call: Pick<ToolCall, "name" | "input">) =>
          budgetCategory(call.name, registrations.get(call.name)?.tool, call.input),
        settle: (input: ExecuteInput) => {
          const registration = registrations.get(input.call.name)
          if (registration)
            return Effect.gen(function* () {
              for (const capability of capabilities(registration.tool)) {
                const expected = capabilitySnapshot[capability]
                if (
                  expected === undefined ||
                  !capabilityLeases ||
                  !(yield* capabilityLeases.valid(input.sessionID, input.agent, capability, expected))
                )
                  return {
                    result: {
                      type: "error" as const,
                      value: `Capability lease is not active for tool: ${input.call.name}`,
                    },
                  }
              }
              return yield* settleWith(input, registration.identity, policy)
            })
          return Effect.succeed({ result: { type: "error" as const, value: `Unknown tool: ${input.call.name}` } })
        },
      }
    })

    const effective = (
      permissions?: PermissionV2.Ruleset,
      policy?: AgentV2.Info["tools"],
      capabilitySnapshot: CapabilityLease.Snapshot = {},
      lastUserText?: string,
    ) => {
      const registrations = new Map(applications.entries())
      for (const [name, entries] of local) {
        const registration =
          entries.findLast((entry) => !catalogMetadata(entry.registration.tool)?.project)?.registration ??
          entries.at(-1)?.registration
        if (!registration) continue
        if (catalogMetadata(registration.tool)?.project && applications.entries().has(name)) continue
        registrations.set(name, registration)
      }
      if (policy)
        for (const [name, registration] of registrations) {
          if (!ConfigAgent.projectScopeAllows(policy.entries[name]?.scope, location?.project.directory ?? "")) {
            registrations.delete(name)
            continue
          }
          if (isAlwaysVisible(registration.tool) && policy.mode !== "explicit") continue
          const entry = Wildcard.all(name, policy.entries)
          if (
            (policy.mode === "explicit" && !entry) ||
            entry?.visible === false ||
            entry?.permission === "deny" ||
            !ConfigAgent.projectScopeAllows(entry?.scope, location?.project.directory ?? "")
          )
            registrations.delete(name)
        }
      // Contract-scoped tools stay registered for eviction safety, but they are
      // only advertised for turns whose current prompt carries their marker
      // (for example scheduled job runs). Ordinary user turns never see them,
      // so history echo can no longer trigger stray result calls.
      for (const [name, registration] of registrations) {
        const marker = contractMarker(registration.tool)
        if (marker !== undefined && !lastUserText?.includes(marker)) registrations.delete(name)
      }
      for (const [name, registration] of registrations)
        if (capabilities(registration.tool).some((capability) => capabilitySnapshot[capability] === undefined))
          registrations.delete(name)
      if (!permissions) return registrations
      for (const [name, registration] of registrations)
        if (
          !isAlwaysVisible(registration.tool) &&
          (whollyDisabled(permission(registration.tool, name), permissions) ||
            (isDefaultDisabled(registration.tool) &&
              !explicitlyEnabled(permission(registration.tool, name), permissions)))
        )
          registrations.delete(name)
      return registrations
    }

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        for (const [name, tool] of entries) {
          const metadata = catalogMetadata(tool)
          if (metadata?.scope !== "location" || !metadata.project) continue
          if (!applications.entries().has(name) && !local.has(name)) continue
          return yield* new RegistrationError({
            name,
            message: `Project tool '${name}' is blocked because that ID is already registered outside this project.`,
          })
        }
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries) {
              const registrations = local.get(name) ?? []
              const protectedIndex = registrations.findIndex((entry) => isAlwaysVisible(entry.registration.tool))
              const registration = { token, registration: { identity: {}, tool } }
              local.set(
                name,
                protectedIndex === -1 || isAlwaysVisible(tool)
                  ? [...registrations, registration]
                  : [...registrations.slice(0, protectedIndex), registration, ...registrations.slice(protectedIndex)],
              )
            }
            // Always-visible protocol tools (for example the scheduler result tool)
            // must survive the registering plugin host's scope: instance reloads
            // otherwise silently drop them and contracted scheduled jobs then fail
            // closed with "completed without the required explicit result".
            const mortal = entries.filter(([, tool]) => !isAlwaysVisible(tool))
            if (mortal.length > 0)
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  for (const [name] of mortal) {
                    const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                    if (registrations.length > 0) local.set(name, registrations)
                    else local.delete(name)
                  }
                }),
              )
          }),
        )
      }),
      catalog: Effect.fn("ToolRegistry.catalog")(function* (permissions, context) {
        const capabilitySnapshot =
          context && capabilityLeases ? yield* capabilityLeases.snapshot(context.sessionID, context.agent) : {}
        const registrations = effective(permissions, undefined, capabilitySnapshot)
        return yield* Effect.forEach(
          Array.from(registrations),
          Effect.fnUntraced(function* ([id, registration]) {
            const resolved = definition(id, registration.tool)
            const metadata = catalogMetadata(registration.tool)
            return {
              id,
              description: resolved.description,
              scope: metadata?.scope ?? (applications.entries().get(id) === registration ? "application" : "location"),
              project: metadata?.project,
              source: metadata?.source,
              version: metadata?.version,
              visible: true,
            } satisfies CatalogEntry
          }),
          { concurrency: "unbounded" },
        )
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions, policy, context) {
        const capabilitySnapshot =
          context && capabilityLeases ? yield* capabilityLeases.snapshot(context.sessionID, context.agent) : {}
        const registrations = effective(permissions, policy, capabilitySnapshot, context?.lastUserText)
        if (materializationCacheEnabled) {
          const key =
            JSON.stringify(policy) +
            "\0" +
            cacheKey(registrations, permissions ?? [], plugin ? yield* plugin.generation() : 0, capabilitySnapshot)
          const cached = materializationCache.get(key)
          yield* Perf.record(
            {
              kind: "optimization",
              feature: "tool_materialization_cache",
              hit: cached !== undefined,
              cache_size: materializationCache.size,
              tool_count: registrations.size,
              permissions_count: permissions?.length ?? 0,
            },
            "optimization",
          )
          if (cached) return cached
          return remember(
            key,
            withBudgetCategory(yield* materializeDefinitions(registrations, capabilitySnapshot, policy), registrations),
          )
        }
        return withBudgetCategory(
          yield* materializeDefinitions(registrations, capabilitySnapshot, policy),
          registrations,
        )
      }),
    })
  }),
)

export const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

function explicitlyEnabled(action: string, rules: PermissionV2.Ruleset) {
  return rules.some(
    (rule) =>
      rule.action !== "*" &&
      Wildcard.match(action, rule.action) &&
      rule.effect !== "deny" &&
      PermissionV2.evaluate(action, rule.resource, rules).effect !== "deny",
  )
}

function withBudgetCategory(
  materialization: Materialization,
  registrations: ReadonlyMap<string, { readonly tool: AnyTool }>,
): Materialization {
  return {
    ...materialization,
    budgetCategory: (call) => budgetCategory(call.name, registrations.get(call.name)?.tool, call.input),
  }
}

export const defaultLayer = layer.pipe(
  Layer.provide(ApplicationTools.layer),
  Layer.provide(ToolOutputStore.defaultLayer),
)
