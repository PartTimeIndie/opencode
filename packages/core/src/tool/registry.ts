export * as ToolRegistry from "./registry"

import { ToolDefinition, ToolOutput, type ToolCall, type ToolResultValue } from "@opencode-ai/llm"
import { Context, Effect, Layer, Option, Scope } from "effect"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { ConfigOptimization } from "../config/optimization"
import { ConfigAgent } from "../config/agent"
import { Database } from "../database/database"
import { ExplicitInvocation } from "./explicit-invocation"
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
  explicitInvocation,
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
  readonly progress?: Tool.Context["progress"]
}

export interface Interface {
  readonly materialize: (
    permissions?: PermissionV2.Ruleset,
    policy?: AgentV2.Info["tools"],
    context?: MaterializationContext,
  ) => Effect.Effect<Materialization>
  /** Configurable registrations, not the tools currently executable by a Session. */
  readonly catalog: () => Effect.Effect<ReadonlyArray<CatalogEntry>>
  /** Name-to-marker pairs of registered contract-scoped tools, for open-run visibility computation. */
  readonly contractTools: () => Effect.Effect<ReadonlyArray<ContractToolBinding>>
  /** Metadata lookup only, for retaining command identity across template expansion; grants nothing. */
  readonly hasExplicitCommand: (command: string) => Effect.Effect<boolean>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export type ContractToolBinding = {
  readonly name: string
  readonly marker: string
}

export type MaterializationContext = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  /**
   * Text of the current turn's latest user prompt. Contract-scoped tools
   * (for example the scheduler result tool) are advertised when this text
   * carries their marker, so ordinary chat turns never see them.
   */
  readonly lastUserText?: string
  /**
   * Markers whose latest host-injected contracted prompt in this session is
   * still unsettled (no completed result call after it). An open scheduled
   * run keeps its result tool advertised across ordinary interjected user
   * inputs and allowed agent switches; once the result call completes, the
   * gate closes for that run.
   */
  readonly openContractMarkers?: ReadonlyArray<string>
}

export interface CatalogEntry {
  readonly id: string
  readonly description: string
  readonly parameters: ToolDefinition["inputSchema"]
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

export type ContractGateMessage = {
  readonly type: string
  readonly text?: string
  readonly content?: ReadonlyArray<{
    readonly type: string
    readonly name?: string
    readonly state?: { readonly status?: string }
  }>
}

/**
 * Contract-scoped tool visibility follows the open scheduled run, not the
 * latest prompt text: for each binding, the latest user message carrying its
 * marker opens the gate until a completed call of that tool settles the run.
 * Only host-injected user prompts are evidence; assistant echoes, compaction
 * summaries and other non-user text never open the gate.
 */
export const openContractMarkers = (
  messages: ReadonlyArray<ContractGateMessage>,
  bindings: ReadonlyArray<ContractToolBinding>,
): ReadonlyArray<string> =>
  bindings.flatMap(({ name, marker }) => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.type !== "user" || !message.text?.includes(marker)) continue
      const settled = messages
        .slice(index + 1)
        .some((entry) =>
          entry.content?.some((part) => part.type === "tool" && part.name === name && part.state?.status === "completed"),
        )
      return settled ? [] : [marker]
    }
    return []
  })

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
    const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
    const permissions = Option.getOrUndefined(yield* Effect.serviceOption(PermissionV2.Service))
    const invocations = database && permissions ? ExplicitInvocation.make(database.db, permissions) : undefined
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
          explicitInvocation(registration.tool),
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
      invocation?: ExplicitInvocation.Grant,
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
      let progressActive = true
      const publishProgress = input.progress
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
        fileKnowledgeCutoff: input.fileKnowledgeCutoff,
        // Delivery stays opt-in per call; emission vs. capture is decided by the
        // publisher so fanout receipts persist even when the live-progress
        // display toggle is off.
        ...(publishProgress
          ? {
              progress: (snapshot: Tool.Progress) =>
                Effect.suspend(() => (progressActive ? publishProgress(snapshot) : Effect.void)),
            }
          : {}),
        ...(policy ? { toolPolicy: policy } : {}),
        ...(invocation
          ? {
              explicitInvocation: {
                command: invocation.command,
                inputID: invocation.inputID,
                activityID: invocation.activityID,
              },
            }
          : {}),
        ...(input.skillGroupOutputs ? { skillGroupOutputs: input.skillGroupOutputs } : {}),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            progressActive = false
          }),
        ),
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

    const resolveDefinition = Effect.fn("ToolRegistry.resolveDefinition")(function* (name: string, tool: AnyTool) {
      const base = definition(name, tool)
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
    })

    const materializeDefinitions = Effect.fn("ToolRegistry.materializeDefinitions")(function* (
      registrations: ReadonlyMap<string, Registration>,
      capabilitySnapshot: CapabilityLease.Snapshot,
      policy?: AgentV2.Info["tools"],
      grants: ReadonlyMap<string, ExplicitInvocation.Grant> = new Map(),
    ) {
      const definitions = yield* Effect.forEach(
        Array.from(registrations),
        ([name, registration]) => resolveDefinition(name, registration.tool),
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
              const invocation = grants.get(input.call.name)
              if (
                explicitInvocation(registration.tool) !== undefined &&
                (!invocation ||
                  !invocations ||
                  input.sessionID !== invocation.sessionID ||
                  input.agent !== invocation.agent ||
                  !(yield* invocations.valid(invocation)))
              )
                return {
                  result: {
                    type: "error" as const,
                    value: `Explicit invocation is no longer active for tool: ${input.call.name}`,
                  },
                }
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
              return yield* settleWith(input, registration.identity, policy, invocation)
            })
          return Effect.succeed({ result: { type: "error" as const, value: `Unknown tool: ${input.call.name}` } })
        },
      }
    })

    const registered = () => {
      const registrations = new Map(applications.entries())
      for (const [name, entries] of local) {
        const registration =
          entries.findLast((entry) => !catalogMetadata(entry.registration.tool)?.project)?.registration ??
          entries.at(-1)?.registration
        if (!registration) continue
        if (catalogMetadata(registration.tool)?.project && applications.entries().has(name)) continue
        registrations.set(name, registration)
      }
      return registrations
    }

    const effective = (
      permissions?: PermissionV2.Ruleset,
      policy?: AgentV2.Info["tools"],
      capabilitySnapshot: CapabilityLease.Snapshot = {},
      lastUserText?: string,
      openContractMarkers?: ReadonlyArray<string>,
    ) => {
      const registrations = registered()
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
      // only advertised for open scheduled runs: either the current prompt
      // carries their marker (job start and recovery re-submission), or the
      // session's latest contracted prompt is still unsettled, so ordinary
      // interjected user inputs and allowed agent switches cannot drop the
      // result tool mid-run. A completed result call closes the gate again.
      for (const [name, registration] of registrations) {
        const marker = contractMarker(registration.tool)
        if (marker === undefined) continue
        if (!lastUserText?.includes(marker) && !openContractMarkers?.includes(marker)) registrations.delete(name)
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
      hasExplicitCommand: (command) => Effect.sync(() => Array.from(registered().values()).some(registration => explicitInvocation(registration.tool)?.includes(command) === true)),
      catalog: Effect.fn("ToolRegistry.catalog")(function* () {
        // Settings must be able to configure inactive and denied tools without
        // activating a capability or granting execution permission. Turn-only
        // protocol tools still do not belong in this user-configurable catalog.
        const registrations = Array.from(registered()).filter(
          ([, registration]) => contractMarker(registration.tool) === undefined,
        )
        return yield* Effect.forEach(
          registrations,
          Effect.fnUntraced(function* ([id, registration]) {
            const resolved = yield* resolveDefinition(id, registration.tool)
            const metadata = catalogMetadata(registration.tool)
            return {
              id,
              description: resolved.description,
              parameters: resolved.inputSchema,
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
      contractTools: () =>
        Effect.sync(() =>
          Array.from(registered()).flatMap(([name, registration]) => {
            const marker = contractMarker(registration.tool)
            return marker === undefined ? [] : [{ name, marker }]
          }),
        ),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions, policy, context) {
        const capabilitySnapshot =
          context && capabilityLeases ? yield* capabilityLeases.snapshot(context.sessionID, context.agent) : {}
        const registrations = effective(
          permissions,
          policy,
          capabilitySnapshot,
          context?.lastUserText,
          context?.openContractMarkers,
        )
        const grants = new Map<string, ExplicitInvocation.Grant>()
        for (const [name, registration] of registrations) {
          const command = explicitInvocation(registration.tool)
          if (command === undefined) continue
          const grant =
            context && invocations
              ? yield* invocations.authorize(context, name, command, identityID(registration.identity))
              : undefined
          if (grant) grants.set(name, grant)
          else registrations.delete(name)
        }
        if (materializationCacheEnabled) {
          const key =
            JSON.stringify(policy) +
            "\0" +
            JSON.stringify([...grants]) +
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
            withBudgetCategory(
              yield* materializeDefinitions(registrations, capabilitySnapshot, policy, grants),
              registrations,
            ),
          )
        }
        return withBudgetCategory(
          yield* materializeDefinitions(registrations, capabilitySnapshot, policy, grants),
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
