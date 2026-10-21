import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { makeEventListener } from "@solid-primitives/event-listener"
import { type Accessor, batch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createSdkForServer } from "@/utils/server"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { ServerConnection, useServer } from "./server"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerScope } from "@/utils/server-scope"
import { directoryKey } from "@/utils/path-key"

const isAbortError = (error: unknown) =>
  error !== null && typeof error === "object" && "name" in error && error.name === "AbortError"

const isStreamClosed = (error: unknown, signal?: AbortSignal) => isAbortError(error) || signal?.aborted === true
type QueuedServerEvent = { directory: string; payload: Event | SyncServerEvent }
export type SyncServerEvent = Extract<GlobalEvent["payload"], { type: "sync" }>

export const serverEventDirectoryKey = (directory: string) => String(directoryKey(directory))

export function coalescibleServerEventKey(directory: string, payload: Event | SyncServerEvent) {
  if (payload.type === "session.status") return `session.status:${directory}:${payload.properties.sessionID}`
  if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
  if (payload.type !== "file.watcher.updated") return
  return `file.watcher.updated:${directory}:${serverEventDirectoryKey(payload.properties.file)}:${payload.properties.event}`
}

export function enqueueCoalescibleServerEvent(
  queue: QueuedServerEvent[],
  slots: Map<string, number>,
  incoming: QueuedServerEvent,
) {
  const eventKey = coalescibleServerEventKey(incoming.directory, incoming.payload)
  if (!eventKey) {
    queue.push(incoming)
    return
  }

  const index = slots.get(eventKey)
  if (index === undefined || (incoming.payload.type === "file.watcher.updated" && index !== queue.length - 1)) {
    slots.set(eventKey, queue.length)
    queue.push(incoming)
    return
  }
  queue[index] = incoming
}

// Transport scope for events published outside any instance. It is a pseudo
// scope, not a project path: session events that arrive here carry no usable
// directory, and every per-directory consumer (store reducers, open session
// timelines, plugin subscriptions) would silently drop them.
export const GLOBAL_SCOPE_DIRECTORY = "global"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export type SessionScopeRef = { directory: string; sessionID?: string } | { sessionID: string }

export function globalScopeSessionRef(payload: Event | SyncServerEvent): SessionScopeRef | undefined {
  const data = payload.type === "sync" ? payload.syncEvent.data : (payload as { properties?: unknown }).properties
  if (!isRecord(data)) return undefined
  const sessionID =
    typeof data.sessionID === "string" && data.sessionID
      ? data.sessionID
      : isRecord(data.info) && typeof data.info.id === "string" && data.info.id
        ? data.info.id
        : undefined
  const info = data.info
  if (
    isRecord(info) &&
    typeof info.directory === "string" &&
    info.directory &&
    info.directory !== GLOBAL_SCOPE_DIRECTORY
  )
    return { directory: info.directory, ...(sessionID ? { sessionID } : {}) }
  if (sessionID) return { sessionID }
  return undefined
}

export function routedEventDirectory(input: {
  directory: string
  payload: Event | SyncServerEvent
  resolveSessionScope?: (payload: Event | SyncServerEvent) => string | undefined
}) {
  if (input.directory !== GLOBAL_SCOPE_DIRECTORY) return input.directory
  return input.resolveSessionScope?.(input.payload) ?? input.directory
}

// Session events that reach the transport on the pseudo "global" scope must be
// re-keyed onto their owning project directory before they reach any emitter.
// Placement learned from session metadata (info.directory) also serves the
// sessionID-only events that follow in the same queue batch, before any store
// could have applied the metadata. Learned entries are bounded and refresh
// whenever a later metadata event carries a different directory.
export const LEARNED_SESSION_SCOPE_LIMIT = 4096

export function createSessionScopeRouting(input: {
  push: (directory: string, payload: Event | SyncServerEvent) => void
}) {
  const learned = new Map<string, string>()
  let resolveSessionScope: ((payload: Event | SyncServerEvent) => string | undefined) | undefined

  const remember = (payload: Event | SyncServerEvent) => {
    const ref = globalScopeSessionRef(payload)
    if (!ref || !("directory" in ref) || !ref.sessionID) return
    if (learned.get(ref.sessionID) === ref.directory) return
    learned.set(ref.sessionID, ref.directory)
    if (learned.size > LEARNED_SESSION_SCOPE_LIMIT) learned.delete(learned.keys().next().value!)
  }

  const resolve = (payload: Event | SyncServerEvent) => {
    const ref = globalScopeSessionRef(payload)
    if (!ref) return undefined
    if ("directory" in ref) return ref.directory
    return learned.get(ref.sessionID) ?? resolveSessionScope?.(payload)
  }

  return {
    push: (directory: string, payload: Event | SyncServerEvent) => {
      remember(payload)
      input.push(routedEventDirectory({ directory, payload, resolveSessionScope: resolve }), payload)
    },
    setResolver: (resolver: ((payload: Event | SyncServerEvent) => string | undefined) | undefined) => {
      resolveSessionScope = resolver
    },
  }
}

const deltaKey = (directory: string, messageID: string, partID: string) =>
  `${serverEventDirectoryKey(directory)}:${messageID}:${partID}`

function coalescibleDelta(event: QueuedServerEvent) {
  const directory = serverEventDirectoryKey(event.directory)
  switch (event.payload.type) {
    case "message.part.delta":
      return {
        key: `${deltaKey(directory, event.payload.properties.messageID, event.payload.properties.partID)}:${event.payload.properties.field}`,
        field: "delta" as const,
        value: event.payload.properties.delta,
      }
    case "session.next.text.delta":
      return {
        key: `${directory}:${event.payload.properties.sessionID}:${event.payload.properties.assistantMessageID}:text:${event.payload.properties.textID}`,
        field: "delta" as const,
        value: event.payload.properties.delta,
      }
    case "session.next.reasoning.delta":
      return {
        key: `${directory}:${event.payload.properties.sessionID}:${event.payload.properties.assistantMessageID}:reasoning:${event.payload.properties.reasoningID}`,
        field: "delta" as const,
        value: event.payload.properties.delta,
      }
    case "session.next.tool.input.delta":
      return {
        key: `${directory}:${event.payload.properties.sessionID}:${event.payload.properties.assistantMessageID}:tool-input:${event.payload.properties.callID}`,
        field: "delta" as const,
        value: event.payload.properties.delta,
      }
    case "session.next.compaction.delta":
      return {
        key: `${directory}:${event.payload.properties.sessionID}:${event.payload.properties.messageID}:compaction`,
        field: "text" as const,
        value: event.payload.properties.text,
      }
  }
}

function mergeDeltaEvent(
  current: QueuedServerEvent,
  incoming: QueuedServerEvent,
  field: "delta" | "text",
  value: string,
) {
  if (current.payload.type === "sync" || incoming.payload.type === "sync") return incoming
  const properties = current.payload.properties as Record<string, unknown>
  return {
    directory: incoming.directory,
    payload: {
      ...incoming.payload,
      properties: {
        ...incoming.payload.properties,
        [field]: `${typeof properties[field] === "string" ? properties[field] : ""}${value}`,
      },
    } as Event,
  }
}

export function coalesceServerEvents(events: QueuedServerEvent[]) {
  const output: QueuedServerEvent[] = []
  const deltas = new Map<string, number>()
  events.forEach((event) => {
    const delta = coalescibleDelta(event)
    if (!delta) {
      deltas.clear()
      output.push(event)
      return
    }
    const index = deltas.get(delta.key)
    if (index === undefined) {
      deltas.set(delta.key, output.length)
      output.push(event)
      return
    }
    const existing = output[index]
    if (!existing) return
    output[index] = mergeDeltaEvent(existing, event, delta.field, delta.value)
  })
  return output
}

export function resumeStreamAfterPageShow(event: PageTransitionEvent, start: () => unknown) {
  if (!event.persisted) return
  start()
}

export function createStreamReconnectTracker(onReconnect: () => void) {
  let connected = false
  return () => {
    if (!connected) {
      connected = true
      return
    }
    onReconnect()
  }
}

export const SERVER_EVENT_HEARTBEAT_TIMEOUT_MS = 30_000

export function serverEventStreamTimedOut(lastEventAt: number, now = Date.now()) {
  return now - lastEventAt >= SERVER_EVENT_HEARTBEAT_TIMEOUT_MS
}

export function createServerEventQueue(input: {
  signal: AbortSignal
  emit(directory: string, payload: Event): void
  sync(directory: string, payload: SyncServerEvent): void
}) {
  type Queued = QueuedServerEvent
  const FLUSH_FRAME_MS = 16
  const FLUSH_BUDGET_MS = 8
  const FLUSH_EVENT_LIMIT = 64
  const MAX_QUEUED_EVENTS = 2048
  const QUEUE_LOW_WATERMARK = 1024

  let queue: Queued[] = []
  let buffer: Queued[] = []
  const coalesced = new Map<string, number>()
  const deltaSlots = new Map<string, number>()
  const queueCapacityWaiters = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0
  const seen = new Set<string>()

  const remember = (payload: Event | SyncServerEvent) => {
    if (!("id" in payload) || typeof payload.id !== "string") return false
    if (seen.has(payload.id)) return true
    seen.add(payload.id)
    if (seen.size > 4096) seen.delete(seen.values().next().value!)
    return false
  }

  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined

    if (queue.length === 0) return

    const events = queue
    queue = buffer
    buffer = events
    queue.length = 0
    if (queue.length <= QUEUE_LOW_WATERMARK) {
      for (const resolve of queueCapacityWaiters) resolve()
      queueCapacityWaiters.clear()
    }
    coalesced.clear()
    deltaSlots.clear()

    last = Date.now()
    const output = coalesceServerEvents(events)
    const started = performance.now()
    let emitted = 0
    batch(() => {
      for (const event of output) {
        if (event.payload.type === "sync") input.sync(serverEventDirectoryKey(event.directory), event.payload)
        else input.emit(serverEventDirectoryKey(event.directory), event.payload)
        emitted++
        if (emitted >= FLUSH_EVENT_LIMIT || performance.now() - started >= FLUSH_BUDGET_MS) break
      }
    })

    const remainder = output.slice(emitted)
    if (remainder.length > 0) {
      queue.push(...remainder)
      queue.forEach((event, index) => {
        const eventKey = coalescibleServerEventKey(event.directory, event.payload)
        if (eventKey) coalesced.set(eventKey, index)
        const delta = coalescibleDelta(event)
        if (delta) deltaSlots.set(delta.key, index)
        else deltaSlots.clear()
      })
      schedule()
    }

    buffer.length = 0
  }

  const schedule = () => {
    if (timer) return
    const elapsed = Date.now() - last
    timer = setTimeout(flush, Math.max(0, FLUSH_FRAME_MS - elapsed))
  }

  const push = (directory: string, payload: Event | SyncServerEvent) => {
    // Durable snapshots and transient deltas share a queue. Emitting sync
    // immediately lets text.ended overtake its buffered deltas and append twice.
    if (remember(payload)) return
    const normalizedDirectory = serverEventDirectoryKey(directory)
    const incoming = { directory: normalizedDirectory, payload }
    const delta = coalescibleDelta(incoming)
    if (delta) {
      const i = deltaSlots.get(delta.key)
      if (i !== undefined) {
        const existing = queue[i]
        if (existing) {
          queue[i] = mergeDeltaEvent(existing, incoming, delta.field, delta.value)
          return
        }
      }
      deltaSlots.set(delta.key, queue.length)
      queue.push(incoming)
      schedule()
      return
    }
    deltaSlots.clear()
    enqueueCoalescibleServerEvent(queue, coalesced, incoming)
    schedule()
  }

  const discardQueuedEvents = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    queue.length = 0
    buffer.length = 0
    coalesced.clear()
    deltaSlots.clear()
    for (const resolve of queueCapacityWaiters) resolve()
    queueCapacityWaiters.clear()
  }

  const waitForQueueCapacity = async () => {
    while (queue.length >= MAX_QUEUED_EVENTS && !input.signal.aborted) {
      await new Promise<void>((resolve) => queueCapacityWaiters.add(resolve))
    }
  }

  return { push, flush, discard: discardQueuedEvents, waitForCapacity: waitForQueueCapacity }
}

function createServerSdkContextBase(server: ServerConnection.Any, scope: ServerScope) {
  const platform = usePlatform()
  const abort = new AbortController()

  const eventFetch = (() => {
    if (!platform.fetch || !server) return
    try {
      const url = new URL(server.http.url)
      const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
      if (url.protocol === "http:" && !loopback) return platform.fetch
    } catch {
      return
    }
  })()

  const eventSdk = createSdkForServer({
    signal: abort.signal,
    fetch: eventFetch,
    server: server.http,
  })
  const emitter = createGlobalEmitter<{
    [key: string]: Event
  }>()
  const syncEmitter = createGlobalEmitter<{
    [key: string]: SyncServerEvent
  }>()

  const STREAM_YIELD_MS = 8
  const RECONNECT_DELAY_MS = 250
  const queue = createServerEventQueue({
    signal: abort.signal,
    emit: (directory, payload) => emitter.emit(directory, payload),
    sync: (directory, payload) => syncEmitter.emit(directory, payload),
  })
  const push = queue.push
  const routing = createSessionScopeRouting({ push })

  let streamErrorLogged = false
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  let attempt: AbortController | undefined
  let run: Promise<void> | undefined
  let started = false
  let generation = 0
  const [reconnect, setReconnect] = createSignal(0)
  const markConnected = createStreamReconnectTracker(() => setReconnect((value) => value + 1))
  let lastEventAt = Date.now()
  let heartbeat: ReturnType<typeof setTimeout> | undefined
  const resetHeartbeat = () => {
    lastEventAt = Date.now()
    if (heartbeat) clearTimeout(heartbeat)
    heartbeat = setTimeout(() => {
      attempt?.abort()
    }, SERVER_EVENT_HEARTBEAT_TIMEOUT_MS)
  }
  const clearHeartbeat = () => {
    if (!heartbeat) return
    clearTimeout(heartbeat)
    heartbeat = undefined
  }

  const start = () => {
    if (started) return run
    started = true
    const active = ++generation
    const previous = run
    const current = (async () => {
      if (previous) await previous
      // oxlint-disable-next-line no-unmodified-loop-condition -- `started` is set to false by stop() which also aborts; both flags are checked to allow graceful exit
      while (!abort.signal.aborted && started && generation === active) {
        attempt = new AbortController()
        lastEventAt = Date.now()
        const onAbort = () => {
          attempt?.abort()
        }
        abort.signal.addEventListener("abort", onAbort)
        try {
          const events = await eventSdk.global.event({
            signal: attempt.signal,
            onSseError: (error) => {
              if (isStreamClosed(error, attempt?.signal)) return
              if (streamErrorLogged) return
              streamErrorLogged = true
              console.error("[global-sdk] event stream error", {
                url: server.http.url,
                fetch: eventFetch ? "platform" : "webview",
                error,
              })
            },
          })
          let yielded = Date.now()
          resetHeartbeat()
          for await (const event of events.stream) {
            resetHeartbeat()
            streamErrorLogged = false
            if (event.payload.type === "server.connected") markConnected()
            const directory = event.directory ?? "global"
            await queue.waitForCapacity()
            if (abort.signal.aborted || attempt.signal.aborted) break
            routing.push(directory, event.payload)

            if (Date.now() - yielded < STREAM_YIELD_MS) continue
            yielded = Date.now()
            await wait(0)
          }
        } catch (error) {
          if (!isStreamClosed(error, attempt?.signal) && !streamErrorLogged) {
            streamErrorLogged = true
            console.error("[global-sdk] event stream failed", {
              url: server.http.url,
              fetch: eventFetch ? "platform" : "webview",
              error,
            })
          }
        } finally {
          abort.signal.removeEventListener("abort", onAbort)
          attempt = undefined
          clearHeartbeat()
        }

        if (abort.signal.aborted || !started || generation !== active) return
        await wait(RECONNECT_DELAY_MS)
      }
    })().finally(() => {
      if (run !== current) return
      run = undefined
      queue.flush()
    })
    run = current
    return run
  }

  const stop = () => {
    started = false
    generation++
    attempt?.abort()
    clearHeartbeat()
  }

  onMount(() => {
    makeEventListener(window, "pagehide", stop)
    makeEventListener(window, "pageshow", (event) => resumeStreamAfterPageShow(event, start))
    makeEventListener(document, "visibilitychange", () => {
      if (document.visibilityState !== "visible") return
      if (!started) return
      if (!serverEventStreamTimedOut(lastEventAt)) return
      attempt?.abort()
    })
  })

  onCleanup(() => {
    stop()
    abort.abort()
    queue.discard()
  })

  const sdk = createSdkForServer({
    server: server.http,
    fetch: platform.fetch,
    throwOnError: true,
  })

  return {
    scope,
    server,
    url: server.http.url,
    client: sdk,
    event: {
      on: (directory: string, handler: (event: Event) => void) =>
        emitter.on(serverEventDirectoryKey(directory), handler),
      listen: emitter.listen.bind(emitter),
      start,
      push: routing.push,
      reconnect,
      // server-sync installs the known-session lookup so scope-less session
      // events are re-keyed onto their owning project directory before they
      // reach any emitter. Must stay optional: standalone SDK contexts keep
      // delivering events under their original transport scope.
      resolveSessionScope: routing.setResolver,
    },
    sync: {
      on: (directory: string, handler: (event: SyncServerEvent) => void) =>
        syncEmitter.on(serverEventDirectoryKey(directory), handler),
      listen: syncEmitter.listen.bind(syncEmitter),
    },
    createClient(opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">) {
      return createSdkForServer({
        server: server.http,
        fetch: platform.fetch,
        ...opts,
      })
    },
  }
}

type ServerSDKBase = ReturnType<typeof createServerSdkContextBase>
export type ServerSDK = ServerSDKBase & {
  createDirSdkContext: (directory: string) => ReturnType<typeof createDirSdkContext>
}

export function createServerSdkContext(server: ServerConnection.Any, scope: ServerScope): ServerSDK {
  const sdk = createServerSdkContextBase(server, scope)
  return Object.assign(sdk, {
    createDirSdkContext: createRefCountMap((dir) => createDirSdkContext(dir, sdk)),
  })
}

export const { use: useServerSDK, provider: ServerSDKProvider } = createSimpleContext({
  name: "ServerSDK",
  // Returns an accessor so the resolved server can change reactively (e.g. a
  // /new-session draft retargeting its server) without re-instantiating the subtree.
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSDK>(() => {
      const conn = props.server?.() ?? server.current
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.createServerCtx(conn).sdk
    })
  },
})

type SDKEventMap = {
  [key in Event["type"]]: Extract<Event, { type: key }>
}

export function createDirSdkContext(directory: string, serverSDK: ServerSDKBase) {
  const client = serverSDK.createClient({
    directory,
    throwOnError: true,
  })

  const emitter = createGlobalEmitter<SDKEventMap>()

  const unsub = serverSDK.event.on(serverEventDirectoryKey(directory), (event) => {
    emitter.emit(event.type, event)
  })
  onCleanup(unsub)

  return {
    scope: serverSDK.scope,
    directory,
    client,
    event: emitter,
    get url() {
      return serverSDK.url
    },
    createClient(opts: Parameters<typeof serverSDK.createClient>[0]) {
      return serverSDK.createClient(opts)
    },
  }
}
