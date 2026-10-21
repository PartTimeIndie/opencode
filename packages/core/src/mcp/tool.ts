export * as McpTool from "./tool"

import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolListChangedNotificationSchema,
  ToolSchema,
  type CallToolResult,
  type Tool as MCPToolDefinition,
} from "@modelcontextprotocol/sdk/types.js"
import { Context, Deferred, Effect, Exit, JsonSchema, Layer, Schema, Scope } from "effect"
import { ConfigAgent } from "../config/agent"
import { McpClient } from "./client"
import { McpNaming } from "./naming"
import { PermissionV2 } from "../permission"
import { Tool } from "../tool/tool"
import { Tools } from "../tool/tools"

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

type Registration = { readonly fingerprint: string; readonly scope: Scope.Closeable }
type AgentToolPolicy = typeof ConfigAgent.Tools.Type
const DISCOVERY_RETRY_COOLDOWN_MS = 30_000

export interface Interface {
  /** Discover configured servers needed by the current location without re-listing known servers. */
  readonly ensureAvailable: () => Effect.Effect<void>
  /** Discover only servers newly made available by an agent tool policy. */
  readonly ensurePolicy: (policy?: AgentToolPolicy) => Effect.Effect<void>
  /** Force discovery for maintenance, notifications, or an explicit manual refresh. */
  readonly refresh: (policy?: AgentToolPolicy) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/McpTool") {}

const makeLayer = (deferInitialRefresh: boolean) => Layer.effect(
  Service,
  Effect.gen(function* () {
    const clients = yield* McpClient.Service
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const scope = yield* Scope.Scope
    const registrations = new Map<string, Registration>()
    const watched = new WeakSet<McpClient.MCPClient>()
    const discovering = new Set<string>()
    const scheduled = new Set<string>()
    // A failed discovery must not put every provider turn back on the same
    // MCP timeout path. The periodic refresh still retries in the background,
    // while a newly selected on-demand policy gets one immediate attempt.
    const unavailableUntil = new Map<string, number>()
    const policyRequired = new Set<string>()

    const refreshServerImplementation = Effect.fn("McpTool.refreshServerImplementation")(function* (server: {
      readonly name: string
      readonly timeout?: number
    }) {
      const firstClient = yield* clients.get(server.name)
      if (!firstClient)
        return yield* Effect.fail(new Error(`MCP server '${server.name}' is unavailable during tool discovery`))
      const first = yield* listTools(firstClient, server.timeout).pipe(Effect.exit)
      const discovered = yield* Effect.gen(function* () {
        if (Exit.isSuccess(first)) return { client: firstClient, definitions: first.value }

        // Discovery is safe to retry because it has no side effects. Invalidate
        // the failed transport first so the retry cannot reuse a stale client.
        yield* clients.invalidate(server.name)
        yield* Effect.sleep("50 millis")
        const retryClient = yield* clients.get(server.name)
        if (!retryClient)
          return yield* Effect.fail(new Error(`MCP server '${server.name}' is unavailable during tool discovery`))
        const definitions = yield* listTools(retryClient, server.timeout).pipe(
          Effect.tapError(() => clients.invalidate(server.name)),
        )
        return { client: retryClient, definitions }
      })
      const { client, definitions } = discovered
      if (!watched.has(client)) {
        watched.add(client)
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          await Effect.runPromise(
            refreshServer(server).pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to refresh MCP tools after notification", {
                  server: server.name,
                  error: describe(error),
                }).pipe(Effect.asVoid),
              ),
            ),
          )
        })
      }
      const converted = new Map<string, { readonly original: string; readonly tool: Tool.AnyTool }>()
      const collisions = new Set<string>()
      for (const definition of definitions) {
        const id = McpNaming.tool(server.name, definition.name)
        if (converted.has(id)) {
          collisions.add(id)
          converted.delete(id)
          continue
        }
        converted.set(id, {
          original: definition.name,
          tool: convert(id, server.name, definition, clients, server.timeout, permission),
        })
      }
      for (const id of collisions)
        yield* Effect.logWarning("skipping colliding MCP tool names", { server: server.name, toolID: id })

      const fingerprint = JSON.stringify(
        Array.from(converted, ([id, value]) => [id, value.original]).toSorted(([a], [b]) => a.localeCompare(b)),
      )
      const previous = registrations.get(server.name)
      if (previous?.fingerprint === fingerprint) {
        unavailableUntil.delete(server.name)
        return
      }

      const scope = yield* Scope.make()
      const registered = yield* tools
        .register(Object.fromEntries(Array.from(converted, ([id, value]) => [id, value.tool])))
        .pipe(Scope.provide(scope), Effect.exit)
      if (Exit.isFailure(registered)) {
        yield* Scope.close(scope, Exit.void)
        return yield* Effect.fail(
          new Error(`failed to register MCP tools for '${server.name}': ${String(registered.cause)}`),
        )
      }
      registrations.set(server.name, { fingerprint, scope })
      unavailableUntil.delete(server.name)
      if (previous) yield* Scope.close(previous.scope, Exit.void)
    })

    const refreshing = new Map<string, Deferred.Deferred<Exit.Exit<void, Error>>>()
    const refreshServer = Effect.fn("McpTool.refreshServer")((server: {
      readonly name: string
      readonly timeout?: number
    }) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const pending = refreshing.get(server.name)
          if (pending) {
            const result = yield* Deferred.await(pending)
            if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
            return result.value
          }

          const current = Deferred.makeUnsafe<Exit.Exit<void, Error>>()
          refreshing.set(server.name, current)
          discovering.add(server.name)
          const result = yield* restore(refreshServerImplementation(server)).pipe(
            Effect.exit,
            Effect.ensuring(Effect.sync(() => discovering.delete(server.name))),
          )
          if (refreshing.get(server.name) === current) {
            refreshing.delete(server.name)
            Deferred.doneUnsafe(current, Effect.succeed(result))
          }
          if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
          return result.value
        }),
      ),
    )

    const refreshServerSafe = (server: { readonly name: string; readonly timeout?: number }) =>
      refreshServer(server).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            unavailableUntil.set(server.name, Date.now() + DISCOVERY_RETRY_COOLDOWN_MS)
          }).pipe(
            Effect.andThen(
              Effect.logWarning("failed to refresh MCP tools", {
                server: server.name,
                error: describe(error),
              }),
            ),
            Effect.asVoid,
          ),
        ),
      )

    const refreshServerInBackground = (server: { readonly name: string; readonly timeout?: number }) =>
      Effect.sync(() => scheduled.add(server.name)).pipe(
        Effect.andThen(
          refreshServerSafe(server).pipe(
            Effect.ensuring(Effect.sync(() => scheduled.delete(server.name))),
            Effect.forkIn(scope, { startImmediately: true }),
            Effect.asVoid,
          ),
        ),
      )

    const reconcile = Effect.fn("McpTool.reconcile")(function* () {
      const changed = yield* clients.reconcile()
      yield* Effect.forEach(
        changed,
        (name) => {
          const previous = registrations.get(name)
          if (!previous) return Effect.void
          registrations.delete(name)
          return Scope.close(previous.scope, Exit.void)
        },
        { concurrency: "unbounded", discard: true },
      )
      for (const name of changed) {
        policyRequired.delete(name)
        unavailableUntil.delete(name)
      }
    })

    const refreshEager = Effect.fn("McpTool.refreshEager")(function* () {
      yield* reconcile()
      yield* Effect.forEach(
        clients.servers().filter((server) => server.startup !== "on_demand"),
        refreshServerSafe,
        { concurrency: "unbounded", discard: true },
      )
    })

    const ensure = Effect.fn("McpTool.ensure")(function* (policy: AgentToolPolicy | undefined, availableOnly: boolean) {
      yield* reconcile()
      const requiredOnDemand = new Set(
        policy === undefined || availableOnly
          ? []
          : clients
              .servers()
              .filter((server) => server.startup === "on_demand" && shouldStartOnDemand(policy, server.name))
              .map((server) => server.name),
      )
      for (const name of policyRequired) if (!requiredOnDemand.has(name)) policyRequired.delete(name)
      const missingEager = clients
        .servers()
        .filter((server) => server.startup !== "on_demand")
        .filter((server) => !registrations.has(server.name))
      const missingOnDemand = clients
        .servers()
        .filter((server) => server.startup === "on_demand" && requiredOnDemand.has(server.name))
        .filter((server) => !registrations.has(server.name))
      const newlyRequiredOnDemand = missingOnDemand.filter((server) => !policyRequired.has(server.name))
      const newlyRequiredNames = new Set(newlyRequiredOnDemand.map((server) => server.name))
      for (const name of requiredOnDemand) policyRequired.add(name)

      // Eager discovery is advisory for provider turns. Even a missing or
      // cooled-down registration must never make the provider await listTools.
      const background = [
        ...missingEager,
        ...missingOnDemand.filter((server) => !newlyRequiredNames.has(server.name)),
      ].filter(
        (server) =>
          !discovering.has(server.name) &&
          !scheduled.has(server.name) &&
          (unavailableUntil.get(server.name) ?? 0) <= Date.now(),
      )
      yield* Effect.forEach(background, refreshServerInBackground, { concurrency: "unbounded", discard: true })

      // The first explicit enablement is the only provider-critical discovery
      // that may be awaited. Later turns use the registered snapshot while a
      // retry runs in the background.
      yield* Effect.forEach(newlyRequiredOnDemand, refreshServerSafe, { concurrency: "unbounded", discard: true })
    })

    const ensureAvailable = Effect.fn("McpTool.ensureAvailable")(function* () {
      yield* ensure(undefined, true)
    })

    const ensurePolicy = Effect.fn("McpTool.ensurePolicy")(function* (policy?: AgentToolPolicy) {
      yield* ensure(policy, false)
    })

    const refresh = Effect.fn("McpTool.refresh")(function* (policy?: AgentToolPolicy) {
      yield* reconcile()
      const servers =
        policy === undefined
          ? clients.servers()
          : clients
              .servers()
              .filter((server) => server.startup !== "on_demand" || shouldStartOnDemand(policy, server.name))
      yield* Effect.forEach(servers, refreshServerSafe, { concurrency: "unbounded", discard: true })
    })

    const safeRefresh = refreshEager().pipe(
      Effect.catchCause((cause) => Effect.logWarning("failed to refresh MCP tools", { cause }).pipe(Effect.asVoid)),
    )
    if (deferInitialRefresh) yield* safeRefresh.pipe(Effect.forkScoped)
    if (!deferInitialRefresh) yield* safeRefresh
    // A server may start after the location opens or miss a notification. Keep
    // discovery eventually consistent without creating another settlement or
    // persistence path. Fingerprints make successful refreshes no-ops.
    yield* Effect.forever(Effect.sleep("30 seconds").pipe(Effect.andThen(safeRefresh))).pipe(Effect.forkScoped)
    yield* Effect.addFinalizer(() =>
      Effect.forEach(registrations.values(), (entry) => Scope.close(entry.scope, Exit.void), {
        concurrency: "unbounded",
        discard: true,
      }),
    )
    return Service.of({ ensureAvailable, ensurePolicy, refresh })
  }),
)

export const layer = makeLayer(false)
export const locationLayer = makeLayer(true)

function convert(
  id: string,
  server: string,
  definition: MCPToolDefinition,
  clients: McpClient.Interface,
  timeout: number | undefined,
  permission: PermissionV2.Interface,
) {
  const inputSchema = normalizeInputSchema(definition.inputSchema)
  const base = Tool.make({
    description: [`MCP server ${server} tool.`, definition.description ?? ""].filter(Boolean).join(" "),
    input: Schema.Record(Schema.String, Schema.Unknown),
    output: Schema.Unknown,
    inputSchema,
    outputSchema: definition.outputSchema as JsonSchema.JsonSchema | undefined,
    execute: (input, context) =>
      permission
        .assert({
          action: id,
          resources: ["*"],
          save: ["*"],
          metadata: { server, tool: definition.name, inputKeys: Object.keys(input).toSorted() },
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
        })
        .pipe(
          Effect.mapError((error) => new Tool.Failure({ message: describe(error), error })),
          Effect.andThen(
            Effect.gen(function* () {
              const client = yield* clients.get(server)
              if (!client)
                return yield* new Tool.Failure({ message: `MCP server '${server}' is unavailable` })
              return yield* Effect.tryPromise({
                try: (signal) =>
                  client.callTool(
                    { name: definition.name, arguments: input },
                    CallToolResultSchema,
                    {
                      timeout: timeout ?? McpClient.DEFAULT_TIMEOUT,
                      resetTimeoutOnProgress: true,
                      signal,
                      onprogress: () => {},
                    },
                  ),
                catch: (error) => new Tool.Failure({ message: describe(error), error }),
              }).pipe(
                // Never replay a possibly executed call. Discard the failed
                // transport so only a later, distinct call can reconnect.
                Effect.tapError(() => clients.invalidate(server)),
              )
            }),
          ),
          Effect.flatMap((result) =>
            result.isError
              ? Effect.fail(new Tool.Failure({ message: errorText(result), error: result }))
              : Effect.succeed(stripLocalPaths(result) as CallToolResult),
          ),
        ),
    toModelOutput: ({ output }) => modelContent(output as CallToolResult),
  })
  return Tool.withCatalog(Tool.withDefaultDisabled(Tool.withPermission(base, id)), {
    scope: "location",
    source: `mcp:${server}`,
  })
}

function shouldStartOnDemand(policy: AgentToolPolicy, server: string) {
  if (policy.mode !== "explicit") return false
  return Object.entries(policy.entries ?? {}).some(
    ([entry, value]) => value.permission !== "deny" && matchesServer(entry, server),
  )
}

function matchesServer(entry: string, server: string) {
  const prefix = `${server}_`
  return entry.startsWith(prefix) && (entry.endsWith("*") || !entry.includes("*"))
}

function normalizeInputSchema(input: MCPToolDefinition["inputSchema"]): JsonSchema.JsonSchema {
  return {
    ...(input as JsonSchema.JsonSchema),
    type: "object",
    properties: (input.properties ?? {}) as JsonSchema.JsonSchema["properties"],
  }
}

function modelContent(result: CallToolResult): Tool.Content[] {
  const content: Tool.Content[] = []
  for (const item of result.content) {
    if (item.type === "text") content.push({ type: "text", text: item.text })
    else if (item.type === "image") content.push({ type: "file", data: item.data, mime: item.mimeType })
    else if (item.type === "audio") content.push({ type: "file", data: item.data, mime: item.mimeType })
    else if (item.type === "resource") {
      const resource = item.resource
      if ("text" in resource) content.push({ type: "text", text: resource.text })
      else if ("blob" in resource)
        content.push({ type: "file", data: resource.blob, mime: resource.mimeType ?? "application/octet-stream" })
    }
  }
  if (content.length === 0 && result.structuredContent !== undefined)
    content.push({ type: "text", text: JSON.stringify(result.structuredContent) })
  return content
}

function errorText(result: CallToolResult) {
  return (
    result.content
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .filter((text) => text.trim())
      .join("\n\n") || "MCP tool returned an error"
  )
}

const LOCAL_PATH_KEYS = new Set(["localPath", "local_path", "absolutePath", "absolute_path"])

function stripLocalPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLocalPaths)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      LOCAL_PATH_KEYS.has(key) ? [] : [[key, stripLocalPaths(entry)] as const],
    ),
  )
}

function listTools(client: McpClient.MCPClient, timeout?: number) {
  return Effect.tryPromise({
    try: () =>
      McpClient.paginate(
        async (cursor) => {
          const params = cursor === undefined ? undefined : { cursor }
          try {
            return await client.listTools(params, { timeout: timeout ?? McpClient.DEFAULT_TIMEOUT })
          } catch (error) {
            if (!(error instanceof Error) || !isOutputSchemaValidationError(error)) throw error
            return client.request({ method: "tools/list", params }, TolerantListToolsResultSchema, {
              timeout: timeout ?? McpClient.DEFAULT_TIMEOUT,
            })
          }
        },
        (result) => result.tools,
      ),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
