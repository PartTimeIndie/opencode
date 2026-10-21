import { EventV2Bridge } from "@/event-v2-bridge"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { Perf } from "@opencode-ai/core/observability/perf"
import { Cause, Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import path from "node:path"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"

const SSE_QUEUE_CAPACITY = 1024

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventID() {
  return EventV2.ID.create()
}

export function sameEventDirectory(left: string, right: string) {
  if (process.platform !== "win32") return path.normalize(left) === path.normalize(right)
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase()
}

function eventResponse(events: EventV2.Interface) {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    const session = yield* Session.Service
    const bridge = yield* EffectBridge.make()
    const sessionLocations = new Map<string, { directory: string; workspaceID?: string }>()
    const matchesInstance = Effect.fn("EventHttpApi.matchesInstance")(function* (event: EventV2.Payload) {
      const location = event.location
      if (location) {
        return (
          sameEventDirectory(location.directory, instance.directory) &&
          (location.workspaceID === undefined || location.workspaceID === workspaceID)
        )
      }

      const data = event.data
      if (!data || typeof data !== "object" || !("sessionID" in data) || typeof data.sessionID !== "string") return false
      const cached = sessionLocations.get(data.sessionID)
      const info = cached
        ? cached
        : yield* session.get(SessionID.make(data.sessionID)).pipe(
            Effect.map((item) => ({ directory: item.directory, workspaceID: item.workspaceID })),
            Effect.catch(() => Effect.succeed(undefined)),
          )
      if (!info) return false
      if (!cached) {
        sessionLocations.set(data.sessionID, info)
        if (sessionLocations.size > 1024) sessionLocations.delete(sessionLocations.keys().next().value!)
      }
      return sameEventDirectory(info.directory, instance.directory) && info.workspaceID === workspaceID
    })
    // Listener registration is eager, so events published after this point cannot
    // be lost while the HTTP body fiber is starting or emitting server.connected.
    const queue = yield* Queue.bounded<EventV2.Payload, Cause.Done>(SSE_QUEUE_CAPACITY)
    const saturated = { value: false }
    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        if (!(yield* matchesInstance(event))) return
        if (saturated.value) return
        if (Queue.offerUnsafe(queue, event)) return
        saturated.value = true
        yield* Perf.record(
          {
            kind: "sse_queue_saturated",
            endpoint: "event.subscribe",
            capacity: SSE_QUEUE_CAPACITY,
            eventID: event.id,
            eventType: event.type,
            directory: instance.directory,
            workspaceID,
          },
          "performance",
        )
        yield* Queue.end(queue)
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const stream = Stream.fromQueue(queue).pipe(
      Stream.map((event) => ({ id: event.id, type: event.type, properties: event.data })),
    )
    const disposed = Stream.callback<{ id: string; type: string; properties: unknown }>(
      (queue) => {
        const saturated = { value: false }
        const listener = (event: {
          directory?: string
          payload: { id?: string; type?: string; properties?: unknown }
        }) => {
          if (!sameEventDirectory(event.directory ?? "", instance.directory) || event.payload.type !== "server.instance.disposed") return
          if (saturated.value) return
          if (
            Queue.offerUnsafe(queue, {
              id: event.payload.id ?? eventID(),
              type: "server.instance.disposed",
              properties: event.payload.properties ?? {},
            })
          )
            return
          saturated.value = true
          Queue.endUnsafe(queue)
          bridge.fork(
            Perf.record(
              {
                kind: "sse_queue_saturated",
                endpoint: "event.subscribe.disposed",
                capacity: SSE_QUEUE_CAPACITY,
                directory: instance.directory,
              },
              "performance",
            ),
          )
        }
        return Effect.acquireRelease(
          Effect.sync(() => GlobalBus.on("event", listener)),
          () => Effect.sync(() => GlobalBus.off("event", listener)),
        )
      },
      { bufferSize: SSE_QUEUE_CAPACITY, strategy: "suspend" },
    )
    const output = stream.pipe(
      Stream.merge(disposed, { haltStrategy: "left" }),
      Stream.takeUntil((event) => event.type === "server.instance.disposed"),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ id: eventID(), type: "server.heartbeat", properties: {} })),
    )

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      Stream.make({ id: eventID(), type: "server.connected", properties: {} }).pipe(
        Stream.concat(output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        return yield* eventResponse(events)
      }),
    )
  }),
)
