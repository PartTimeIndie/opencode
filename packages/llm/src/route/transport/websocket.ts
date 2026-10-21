import { Cause, Context, Effect, Layer, Queue, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { LLMError, TransportReason } from "../../schema"
import * as HttpTransport from "./http"
import type { Transport } from "./index"

export interface WebSocketRequest {
  readonly url: string
  readonly headers: Headers.Headers
  readonly connectTimeoutMs?: number
  readonly idleTimeoutMs?: number
}

export interface WebSocketConnection {
  readonly sendText: (message: string) => Effect.Effect<void, LLMError>
  readonly messages: Stream.Stream<string | Uint8Array, LLMError>
  readonly close: Effect.Effect<void, never>
}

export interface Interface {
  readonly open: (input: WebSocketRequest) => Effect.Effect<WebSocketConnection, LLMError>
}

type WebSocketConstructorWithHeaders = new (
  url: string,
  options?: { readonly headers?: Headers.Headers },
) => globalThis.WebSocket

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM/WebSocketExecutor") {}

const CONNECT_TIMEOUT_MS = 15_000
const IDLE_TIMEOUT_MS = 60_000

const transportError = (
  method: string,
  message: string,
  input: { readonly url?: string; readonly kind?: string; readonly canRetry?: boolean } = {},
) =>
  new LLMError({
    module: "WebSocketExecutor",
    method,
    reason: new TransportReason({ message, url: input.url, kind: input.kind, canRetry: input.canRetry }),
  })

const eventMessage = (event: Event) => {
  if ("message" in event && typeof event.message === "string") return event.message
  return event.type
}

const closeCanRetry = (event: CloseEvent) => event.code !== 1009

const binaryMessage = (data: unknown) => {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return undefined
}

const waitOpen = (ws: globalThis.WebSocket, input: WebSocketRequest) => {
  if (ws.readyState === globalThis.WebSocket.OPEN) return Effect.void
  if (ws.readyState === globalThis.WebSocket.CLOSING || ws.readyState === globalThis.WebSocket.CLOSED) {
    return Effect.fail(
      transportError("open", `WebSocket closed before opening (state ${ws.readyState})`, {
        url: input.url,
        kind: "open",
        canRetry: true,
      }),
    )
  }
  return Effect.callback<void, LLMError>((resume, signal) => {
    const timer = setTimeout(() => {
      cleanup()
      if (ws.readyState !== globalThis.WebSocket.CLOSED && ws.readyState !== globalThis.WebSocket.CLOSING)
        ws.close(1000)
      resume(
        Effect.fail(
          transportError("open", "WebSocket connection timed out", {
            url: input.url,
            kind: "open",
            canRetry: true,
          }),
        ),
      )
    }, input.connectTimeoutMs ?? CONNECT_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timer)
      ws.removeEventListener("open", onOpen)
      ws.removeEventListener("error", onError)
      ws.removeEventListener("close", onClose)
      signal.removeEventListener("abort", onAbort)
    }
    const onAbort = () => {
      cleanup()
      if (ws.readyState !== globalThis.WebSocket.CLOSED && ws.readyState !== globalThis.WebSocket.CLOSING)
        ws.close(1000)
    }
    const onOpen = () => {
      cleanup()
      resume(Effect.void)
    }
    const onError = (event: Event) => {
      cleanup()
      resume(
        Effect.fail(
          transportError("open", `Failed to open WebSocket: ${eventMessage(event)}`, {
            url: input.url,
            kind: "open",
            canRetry: true,
          }),
        ),
      )
    }
    const onClose = (event: CloseEvent) => {
      cleanup()
      resume(
        Effect.fail(
          transportError("open", `WebSocket closed before opening with code ${event.code}`, {
            url: input.url,
            kind: "open",
            canRetry: closeCanRetry(event),
          }),
        ),
      )
    }
    ws.addEventListener("open", onOpen, { once: true })
    ws.addEventListener("error", onError, { once: true })
    ws.addEventListener("close", onClose, { once: true })
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

const webSocketUrl = (value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value)
      if (url.protocol === "https:") {
        url.protocol = "wss:"
        return url.toString()
      }
      if (url.protocol === "http:") {
        url.protocol = "ws:"
        return url.toString()
      }
      throw new Error(`Unsupported WebSocket URL protocol ${url.protocol}`)
    },
    catch: (error) =>
      transportError("prepare", error instanceof Error ? error.message : "Invalid WebSocket URL", {
        url: value,
        kind: "websocket",
      }),
  })

export const open = (input: WebSocketRequest) =>
  Effect.try({
    try: () =>
      new (globalThis.WebSocket as unknown as WebSocketConstructorWithHeaders)(input.url, { headers: input.headers }),
    catch: (error) =>
      transportError("open", error instanceof Error ? error.message : "Failed to construct WebSocket", {
        url: input.url,
        kind: "open",
        canRetry: true,
      }),
  }).pipe(Effect.flatMap((ws) => fromWebSocket(ws, input)))

export const layer: Layer.Layer<Service> = Layer.succeed(Service, Service.of({ open }))

export const fromWebSocket = (
  ws: globalThis.WebSocket,
  input: WebSocketRequest,
): Effect.Effect<WebSocketConnection, LLMError> =>
  Effect.gen(function* () {
    yield* waitOpen(ws, input)
    const messages = yield* Queue.bounded<string | Uint8Array, LLMError | Cause.Done<void>>(128)
    let idleTimer: ReturnType<typeof setTimeout> | undefined

    const clearIdleTimeout = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
    }
    const resetIdleTimeout = () => {
      clearIdleTimeout()
      idleTimer = setTimeout(() => {
        detach()
        if (ws.readyState !== globalThis.WebSocket.CLOSED && ws.readyState !== globalThis.WebSocket.CLOSING)
          ws.close(1000)
        Queue.failCauseUnsafe(
          messages,
          Cause.fail(
            transportError("message", "WebSocket response timed out without an event", {
              url: input.url,
              kind: "idle",
              canRetry: true,
            }),
          ),
        )
      }, input.idleTimeoutMs ?? IDLE_TIMEOUT_MS)
    }
    const detach = () => {
      clearIdleTimeout()
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("error", onError)
      ws.removeEventListener("close", onClose)
    }

    const onMessage = (event: MessageEvent) => {
      resetIdleTimeout()
      if (typeof event.data === "string") return Queue.offerUnsafe(messages, event.data)
      const binary = binaryMessage(event.data)
      if (binary) return Queue.offerUnsafe(messages, binary)
      Queue.failCauseUnsafe(
        messages,
        Cause.fail(
          transportError("message", "Unsupported WebSocket message payload", { url: input.url, kind: "message" }),
        ),
      )
    }
    const onError = (event: Event) => {
      detach()
      Queue.failCauseUnsafe(
        messages,
        Cause.fail(
          transportError("message", `WebSocket error: ${eventMessage(event)}`, {
            url: input.url,
            kind: "message",
            canRetry: true,
          }),
        ),
      )
    }
    const onClose = (event: CloseEvent) => {
      detach()
      if (event.code === 1000 || event.code === 1005) return Queue.endUnsafe(messages)
      const detail = event.reason ? `: ${event.reason}` : ""
      Queue.failCauseUnsafe(
        messages,
        Cause.fail(
          transportError("message", `WebSocket closed with code ${event.code}${detail}`, {
            url: input.url,
            kind: "close",
            canRetry: closeCanRetry(event),
          }),
        ),
      )
    }
    const cleanup = Effect.sync(() => {
      detach()
    }).pipe(Effect.andThen(Queue.shutdown(messages)))

    ws.addEventListener("message", onMessage)
    ws.addEventListener("error", onError)
    ws.addEventListener("close", onClose)
    resetIdleTimeout()

    return {
      sendText: (message) =>
        Effect.try({
          try: () => ws.send(message),
          catch: (error) =>
            transportError("sendText", error instanceof Error ? error.message : "Failed to send WebSocket message", {
              url: input.url,
              kind: "write",
              canRetry: true,
            }),
        }),
      messages: Stream.fromQueue(messages),
      close: cleanup.pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (ws.readyState === globalThis.WebSocket.CLOSED || ws.readyState === globalThis.WebSocket.CLOSING) return
            ws.close(1000)
          }),
        ),
      ),
    }
  })

export const messageText = (message: string | Uint8Array, decoder: TextDecoder) =>
  typeof message === "string" ? message : decoder.decode(message)

export interface JsonPrepared {
  readonly url: string
  readonly headers: Headers.Headers
  readonly message: string
}

export interface JsonInput<Body, Message> {
  readonly toMessage: (body: Body | Record<string, unknown>) => Effect.Effect<Message, LLMError>
  readonly encodeMessage: (message: Message) => string
}

export type JsonPatch<Body, Message> = Partial<JsonInput<Body, Message>>

export interface JsonTransport<Body, Message> extends Transport<Body, JsonPrepared, string> {
  readonly with: (patch: JsonPatch<Body, Message>) => JsonTransport<Body, Message>
}

export const json = <Body, Message>(input: JsonInput<Body, Message>): JsonTransport<Body, Message> => ({
  id: "websocket-json",
  with: (patch) => json({ ...input, ...patch }),
  prepare: (prepareInput) =>
    Effect.gen(function* () {
      const parts = yield* HttpTransport.jsonRequestParts({
        ...prepareInput,
      })
      return {
        url: yield* webSocketUrl(parts.url),
        headers: parts.headers,
        message: input.encodeMessage(yield* input.toMessage(parts.jsonBody)),
      }
    }),
  frames: (prepared, _request, runtime) => {
    const webSocket = runtime.webSocket
    if (!webSocket) {
      return Stream.fail(
        transportError("json", "WebSocket JSON transport requires WebSocketExecutor.Service", {
          url: prepared.url,
          kind: "websocket",
        }),
      )
    }
    const decoder = new TextDecoder()
    return Stream.unwrap(
      Effect.gen(function* () {
        const connection = yield* Effect.acquireRelease(
          webSocket.open({ url: prepared.url, headers: prepared.headers }),
          (connection) => connection.close,
        )
        yield* connection.sendText(prepared.message)
        return connection.messages.pipe(Stream.map((message) => messageText(message, decoder)))
      }),
    )
  },
})

export const jsonTransport = {
  id: "websocket-json",
  with: json,
} as const

export const WebSocketExecutor = {
  Service,
  layer,
  open,
  fromWebSocket,
  messageText,
} as const

export const WebSocketTransport = {
  json,
  jsonTransport,
} as const
