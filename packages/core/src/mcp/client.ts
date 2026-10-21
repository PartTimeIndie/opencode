export * as McpClient from "./client"

import path from "node:path"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Context, Deferred, Effect, Exit, Layer, Schedule } from "effect"
import { Config } from "../config"
import { ConfigMCP } from "../config/mcp"
import { InstallationVersion } from "../installation/version"
import { Location } from "../location"

export const DEFAULT_TIMEOUT = 30_000
export const MAX_LIST_PAGES = 1_000
const CONNECT_RETRY_DELAY_MS = 30_000

type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport
type ServerConfig = typeof ConfigMCP.Server.Type
export type MCPClient = Client

type ClientEntry = {
  readonly name: string
  readonly fingerprint: string
  readonly timeout?: number
  readonly startup?: ServerConfig["startup"]
  readonly connect: () => Effect.Effect<MCPClient | undefined>
  client?: MCPClient
  connecting?: Deferred.Deferred<MCPClient | undefined>
  retry_at?: number
  retired?: boolean
}

export interface Interface {
  readonly servers: () => ReadonlyArray<{
    readonly name: string
    readonly timeout?: number
    readonly startup?: ServerConfig["startup"]
  }>
  readonly reconcile: () => Effect.Effect<ReadonlyArray<string>>
  readonly get: (name: string) => Effect.Effect<MCPClient | undefined>
  readonly invalidate: (name: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/McpClient") {}

const clientOptions = { capabilities: { roots: {} } } satisfies ClientOptions

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const clients = new Map<string, ClientEntry>(
      Object.entries(mcpServers(yield* config.entries())).flatMap(([name, server]) => {
        if (server.disabled === true) return []
        return [[name, createClientEntry(name, server, location.directory)] as const]
      }),
    )
    let reconciling: Deferred.Deferred<Exit.Exit<ReadonlyArray<string>, never>> | undefined

    const invalidateEntry = Effect.fn("McpClient.invalidateEntry")(function* (entry: ClientEntry, retire: boolean) {
      if (retire) entry.retired = true
      const client = entry.client
      entry.client = undefined
      if (client) yield* closeClient(client)
    })

    const invalidate = Effect.fn("McpClient.invalidate")(function* (name: string) {
      const entry = clients.get(name)
      if (!entry) return
      yield* invalidateEntry(entry, false)
    })

    const get = Effect.fn("McpClient.get")(function* (name: string) {
      const entry = clients.get(name)
      if (!entry) return
      return yield* reconnect(entry)
    })

    const reconcileEntries = Effect.fn("McpClient.reconcileEntries")(function* () {
      const changed: string[] = []
      const configured = Object.fromEntries(
        Object.entries(mcpServers(yield* config.entries())).filter(([, server]) => server.disabled !== true),
      )

      for (const [name, entry] of clients) {
        const server = configured[name]
        if (server && entry.fingerprint === configFingerprint(server)) continue
        changed.push(name)
        yield* invalidateEntry(entry, true)
        clients.delete(name)
      }

      for (const [name, server] of Object.entries(configured)) {
        if (clients.has(name)) continue
        clients.set(name, createClientEntry(name, server, location.directory))
      }
      return changed
    })

    const reconcile = Effect.fn("McpClient.reconcile")(function* () {
      const pending = reconciling
      if (pending) {
        const result = yield* Deferred.await(pending)
        if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
        return result.value
      }

      const current = Deferred.makeUnsafe<Exit.Exit<ReadonlyArray<string>, never>>()
      reconciling = current
      const result = yield* reconcileEntries().pipe(Effect.orDie, Effect.exit)
      Deferred.doneUnsafe(current, Effect.succeed(result))
      if (reconciling === current) reconciling = undefined
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
      return result.value
    })

    yield* Effect.addFinalizer(() =>
      Effect.forEach(clients.keys(), invalidate, { concurrency: "unbounded", discard: true }),
    )

    return Service.of({
      servers: () => Array.from(clients.values(), ({ name, timeout, startup }) => ({ name, timeout, startup })),
      reconcile,
      get,
      invalidate,
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Config.locationLayer))

function mcpServers(entries: readonly Config.Entry[]) {
  return entries
    .filter((entry): entry is Config.Document => entry.type === "document")
    .reduce<Record<string, ServerConfig>>((servers, entry) => ({ ...servers, ...(entry.info.mcp?.servers ?? {}) }), {})
}

function createClientEntry(name: string, server: ServerConfig, directory: string): ClientEntry {
  return {
    name,
    fingerprint: configFingerprint(server),
    timeout: server.timeout,
    startup: server.startup,
    connect: () =>
      Effect.suspend(() => connect(name, server, directory)).pipe(
        Effect.retry({ times: 1, schedule: Schedule.spaced("50 millis") }),
        Effect.catch((error) =>
          Effect.logWarning("failed to connect MCP server", {
            server: name,
            error: describe(error),
          }).pipe(Effect.as(undefined)),
        ),
      ),
  }
}

function configFingerprint(server: ServerConfig) {
  return stableStringify(server)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined"
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`
}

function reconnect(entry: ClientEntry) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (entry.client) return entry.client
      if (entry.retry_at && entry.retry_at > Date.now()) return
      if (entry.connecting) return yield* restore(Deferred.await(entry.connecting))
      const pending = Deferred.makeUnsafe<MCPClient | undefined>()
      entry.connecting = pending
      const result = yield* restore(entry.connect()).pipe(Effect.exit)
      if (Exit.isFailure(result)) {
        if (entry.connecting === pending) entry.connecting = undefined
        yield* Deferred.done(pending, result)
        return yield* Effect.failCause(result.cause)
      }
      entry.retry_at = result.value ? undefined : Date.now() + CONNECT_RETRY_DELAY_MS
      if (result.value) entry.client = result.value
      if (entry.connecting === pending) entry.connecting = undefined
      const client = entry.retired ? undefined : result.value
      if (entry.retired && result.value) yield* closeClient(result.value)
      yield* Deferred.succeed(pending, client)
      return client
    }),
  )
}

function connect(name: string, server: ServerConfig, directory: string) {
  return server.type === "local" ? connectLocal(server, directory) : connectRemote(name, server, directory)
}

function connectLocal(server: ConfigMCP.Local, directory: string) {
  return connectTransport(
    new StdioClientTransport({
      command: server.command[0] ?? "",
      args: server.command.slice(1),
      cwd: server.cwd ? path.resolve(directory, server.cwd) : directory,
      env: {
        ...process.env,
        ...(server.command[0] === "opencode" ? { BUN_BE_BUN: "1" } : {}),
        ...server.environment,
      },
      stderr: "ignore",
    }),
    server.timeout ?? DEFAULT_TIMEOUT,
    directory,
  )
}

function connectRemote(name: string, server: ConfigMCP.Remote, directory: string) {
  if (!URL.canParse(server.url)) return Effect.fail(new Error(`Invalid MCP URL for "${name}"`))
  const url = new URL(server.url)
  const transports: Transport[] = [
    new StreamableHTTPClientTransport(url, { requestInit: server.headers ? { headers: server.headers } : undefined }),
    new SSEClientTransport(url, { requestInit: server.headers ? { headers: server.headers } : undefined }),
  ]
  return Effect.firstSuccessOf(
    transports.map((transport) => connectTransport(transport, server.timeout ?? DEFAULT_TIMEOUT, directory)),
  )
}

function connectTransport(transport: Transport, timeout: number, directory: string) {
  return Effect.acquireUseRelease(
    Effect.succeed(transport),
    (transport) =>
      Effect.tryPromise({
        try: async () => {
          const client = new Client({ name: "opencode", version: InstallationVersion }, clientOptions)
          client.setRequestHandler(ListRootsRequestSchema, () =>
            Promise.resolve({ roots: [{ uri: pathToFileURL(directory).href }] }),
          )
          await client.connect(transport, { timeout })
          return client
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    (transport, exit) =>
      Exit.isFailure(exit) ? closeTransport(transport) : Effect.void,
  )
}

function closeClient(client: MCPClient) {
  const pid = client.transport instanceof StdioClientTransport ? client.transport.pid : null
  if (process.platform !== "win32" || typeof pid !== "number")
    return Effect.tryPromise(() => client.close()).pipe(Effect.timeout("5 seconds"), Effect.ignore)
  return closeWindowsProcessTree(pid, () => client.close())
}

function closeTransport(transport: Transport) {
  const pid = transport instanceof StdioClientTransport ? transport.pid : null
  if (process.platform !== "win32" || typeof pid !== "number")
    return Effect.tryPromise(() => transport.close()).pipe(Effect.timeout("5 seconds"), Effect.ignore)
  return closeWindowsProcessTree(pid, () => transport.close())
}

function closeWindowsProcessTree(pid: number, close: () => Promise<void>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      })
      const exited = new Promise<void>((resolve) => {
        child.once("error", () => resolve())
        child.once("close", () => resolve())
      })
      return { child, exited, close: close() }
    }),
    (state) =>
      Effect.all(
        [
          Effect.promise(() => state.exited).pipe(Effect.timeout("5 seconds")),
          // taskkill owns process termination; SDK close only gets a bounded window for bookkeeping because
          // taskkill may win before the transport's close listener observes the process exit.
          Effect.promise(() => state.close).pipe(Effect.timeout("500 millis"), Effect.ignore),
        ],
        {
          concurrency: "unbounded",
          discard: true,
        },
      ),
    (state) => Effect.sync(() => state.child.kill()),
  ).pipe(Effect.scoped, Effect.ignore)
}

export async function paginate<T, R extends { nextCursor?: string }>(
  list: (cursor?: string) => Promise<R>,
  items: (result: R) => T[],
) {
  const result: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const response = await list(cursor)
    result.push(...items(response))
    if (response.nextCursor === undefined) return result
    if (cursors.has(response.nextCursor)) throw new Error(`MCP list returned duplicate cursor: ${response.nextCursor}`)
    cursors.add(response.nextCursor)
    cursor = response.nextCursor
  }
  throw new Error(`MCP list exceeded ${MAX_LIST_PAGES} pages`)
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
