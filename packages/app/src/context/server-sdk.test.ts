import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import {
  coalescibleServerEventKey,
  coalesceServerEvents,
  createDirSdkContext,
  createStreamReconnectTracker,
  enqueueCoalescibleServerEvent,
  createServerEventQueue,
  createSessionScopeRouting,
  globalScopeSessionRef,
  routedEventDirectory,
  type SyncServerEvent,
  resumeStreamAfterPageShow,
  serverEventStreamTimedOut,
  serverEventDirectoryKey,
} from "./server-sdk"
import type { Event } from "@opencode-ai/sdk/v2/client"

describe("resumeStreamAfterPageShow", () => {
  test("restarts a stream only after a back-forward cache restore", () => {
    let starts = 0
    const start = () => starts++

    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)
    resumeStreamAfterPageShow({ persisted: true } as PageTransitionEvent, start)

    expect(starts).toBe(1)
  })
})

describe("createStreamReconnectTracker", () => {
  test("reports every established stream after the initial connection", () => {
    let reconnects = 0
    const connected = createStreamReconnectTracker(() => reconnects++)

    connected()
    expect(reconnects).toBe(0)

    connected()
    connected()
    expect(reconnects).toBe(2)
  })
})

describe("serverEventStreamTimedOut", () => {
  test("allows three server heartbeat intervals before restarting the stream", () => {
    expect(serverEventStreamTimedOut(10_000, 25_000)).toBe(false)
    expect(serverEventStreamTimedOut(10_000, 39_999)).toBe(false)
    expect(serverEventStreamTimedOut(10_000, 40_000)).toBe(true)
  })
})

describe("coalescibleServerEventKey", () => {
  test("collapses only equivalent watcher updates for the same normalized Windows path", () => {
    const event = (file: string, kind: "add" | "change" | "unlink") =>
      ({ type: "file.watcher.updated", properties: { file, event: kind } }) as Event

    expect(coalescibleServerEventKey("c:/repo", event("C:\\Repo\\src\\file.ts", "change"))).toBe(
      coalescibleServerEventKey("c:/repo", event("c:/repo/src/file.ts", "change")),
    )
    expect(coalescibleServerEventKey("c:/repo", event("c:/repo/src/file.ts", "add"))).not.toBe(
      coalescibleServerEventKey("c:/repo", event("c:/repo/src/file.ts", "change")),
    )
    expect(coalescibleServerEventKey("c:/repo", event("c:/repo/src/other.ts", "change"))).not.toBe(
      coalescibleServerEventKey("c:/repo", event("c:/repo/src/file.ts", "change")),
    )
    expect(coalescibleServerEventKey("c:/repo-a", event("c:/repo/src/file.ts", "change"))).not.toBe(
      coalescibleServerEventKey("c:/repo-b", event("c:/repo/src/file.ts", "change")),
    )
  })

  test("coalesces adjacent watcher repeats without reordering events around another kind", () => {
    const queue: Array<{ directory: string; payload: Event }> = []
    const slots = new Map<string, number>()
    const event = (id: string, kind: "change" | "unlink") => ({
      directory: "c:/repo",
      payload: { id, type: "file.watcher.updated", properties: { file: "c:/repo/src/file.ts", event: kind } } as Event,
    })

    enqueueCoalescibleServerEvent(queue, slots, event("change-1", "change"))
    enqueueCoalescibleServerEvent(queue, slots, event("change-2", "change"))
    expect(queue.map((item) => item.payload.id)).toEqual(["change-2"])

    enqueueCoalescibleServerEvent(queue, slots, event("unlink", "unlink"))
    enqueueCoalescibleServerEvent(queue, slots, event("change-3", "change"))
    expect(queue.map((item) => item.payload.id)).toEqual(["change-2", "unlink", "change-3"])
  })
})

describe("coalesceServerEvents", () => {
  const delta = (value: string, field = "text") => ({
    directory: "/repo",
    payload: {
      type: "message.part.delta",
      properties: { messageID: "msg", partID: "part", field, delta: value },
    } as Event,
  })

  test("merges adjacent deltas for the same field", () => {
    const result = coalesceServerEvents([delta("hello "), delta("world")])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload).toMatchObject({ properties: { delta: "hello world" } })
  })

  test("preserves event boundaries and distinct fields", () => {
    const status = {
      directory: "/repo",
      payload: { type: "session.status", properties: { sessionID: "ses", status: { type: "idle" } } } as Event,
    }
    const result = coalesceServerEvents([delta("a"), delta("b", "metadata"), status, delta("c")])

    expect(result.map((event) => event.payload.type)).toEqual([
      "message.part.delta",
      "message.part.delta",
      "session.status",
      "message.part.delta",
    ])
  })

  test("preserves deltas around whole-part updates", () => {
    const partUpdated = {
      directory: "/repo",
      payload: {
        type: "message.part.updated",
        properties: { part: { id: "part", messageID: "msg", sessionID: "ses", type: "text", text: "snapshot" } },
      } as Event,
    }
    const result = coalesceServerEvents([delta("streamed "), partUpdated, delta("text")])

    expect(result.map((event) => event.payload.type)).toEqual([
      "message.part.delta",
      "message.part.updated",
      "message.part.delta",
    ])
  })

  test("merges V2 streaming deltas for text, reasoning, tool input, and compaction", () => {
    const events = [
      {
        type: "session.next.text.delta",
        properties: {
          sessionID: "ses",
          timestamp: 1,
          assistantMessageID: "msg",
          textID: "text",
          delta: "text ",
        },
      },
      {
        type: "session.next.text.delta",
        properties: {
          sessionID: "ses",
          timestamp: 2,
          assistantMessageID: "msg",
          textID: "text",
          delta: "done",
        },
      },
      {
        type: "session.next.reasoning.delta",
        properties: {
          sessionID: "ses",
          timestamp: 3,
          assistantMessageID: "msg",
          reasoningID: "reasoning",
          delta: "reason ",
        },
      },
      {
        type: "session.next.reasoning.delta",
        properties: {
          sessionID: "ses",
          timestamp: 4,
          assistantMessageID: "msg",
          reasoningID: "reasoning",
          delta: "done",
        },
      },
      {
        type: "session.next.tool.input.delta",
        properties: {
          sessionID: "ses",
          timestamp: 5,
          assistantMessageID: "msg",
          callID: "call",
          delta: '{"path":',
        },
      },
      {
        type: "session.next.tool.input.delta",
        properties: {
          sessionID: "ses",
          timestamp: 6,
          assistantMessageID: "msg",
          callID: "call",
          delta: '"file"}',
        },
      },
      {
        type: "session.next.compaction.delta",
        properties: {
          sessionID: "ses",
          timestamp: 7,
          messageID: "summary",
          text: "summary ",
        },
      },
      {
        type: "session.next.compaction.delta",
        properties: {
          sessionID: "ses",
          timestamp: 8,
          messageID: "summary",
          text: "done",
        },
      },
    ].map((payload, index) => ({ directory: "/repo", payload: { id: `evt_${index}`, ...payload } as Event }))

    const result = coalesceServerEvents(events)

    expect(result).toHaveLength(4)
    expect(result.map((event) => event.payload.type !== "sync" && event.payload.properties)).toMatchObject([
      { delta: "text done" },
      { delta: "reason done" },
      { delta: '{"path":"file"}' },
      { text: "summary done" },
    ])
  })

  test("merges interleaved V2 deltas independently across active sessions", () => {
    const delta = (sessionID: string, value: string, index: number) => ({
      directory: "/repo",
      payload: {
        id: `evt_${index}`,
        type: "session.next.reasoning.delta",
        properties: {
          sessionID,
          timestamp: index,
          assistantMessageID: `msg_${sessionID}`,
          reasoningID: "reasoning",
          delta: value,
        },
      } as Event,
    })

    const result = coalesceServerEvents([
      delta("ses_a", "a", 1),
      delta("ses_b", "b", 2),
      delta("ses_a", "c", 3),
      delta("ses_b", "d", 4),
    ])

    expect(result).toHaveLength(2)
    expect(result.map((event) => event.payload.type !== "sync" && event.payload.properties)).toMatchObject([{ delta: "ac" }, { delta: "bd" }])
  })
})

describe("globalScopeSessionRef", () => {
  test("reads the owning project directory and session id from session info payloads", () => {
    expect(
      globalScopeSessionRef({
        type: "session.created",
        properties: { info: { id: "ses_1", directory: "C:\\ProjektA" } },
      } as Event),
    ).toEqual({ directory: "C:\\ProjektA", sessionID: "ses_1" })
  })

  test("reads the session reference from live session status payloads", () => {
    expect(
      globalScopeSessionRef({
        type: "session.status",
        properties: { sessionID: "ses_9", status: { type: "busy" } },
      } as Event),
    ).toEqual({ sessionID: "ses_9" })
  })

  test("reads the session reference from durable sync envelopes", () => {
    expect(
      globalScopeSessionRef({
        type: "sync",
        syncEvent: {
          id: "evt_1",
          type: "session.next.activity.started.1",
          seq: 1,
          aggregateID: "ses_1",
          data: { sessionID: "ses_1", activityID: "act_1" },
        },
      } as SyncServerEvent),
    ).toEqual({ sessionID: "ses_1" })
  })

  test("falls back to the session id when a payload directory is the pseudo global scope", () => {
    expect(
      globalScopeSessionRef({
        type: "session.updated",
        properties: { info: { id: "ses_1", directory: "global" }, sessionID: "ses_1" },
      } as unknown as Event),
    ).toEqual({ sessionID: "ses_1" })
  })

  test("ignores payloads without a session reference", () => {
    expect(globalScopeSessionRef({ type: "project.updated", properties: { id: "prj_1" } } as Event)).toBeUndefined()
    expect(globalScopeSessionRef({ type: "global.disposed", properties: {} } as Event)).toBeUndefined()
  })
})

describe("routedEventDirectory", () => {
  const payload = { type: "session.status", properties: { sessionID: "ses_1" } } as Event

  test("re-keys scope-less session events onto their project directory", () => {
    expect(
      routedEventDirectory({ directory: "global", payload, resolveSessionScope: () => "C:\\ProjektA" }),
    ).toBe("C:\\ProjektA")
  })

  test("keeps the global scope when no project directory resolves", () => {
    expect(routedEventDirectory({ directory: "global", payload, resolveSessionScope: () => undefined })).toBe("global")
    expect(routedEventDirectory({ directory: "global", payload })).toBe("global")
  })

  test("never consults the resolver for directory-scoped events", () => {
    let consulted = 0
    const resolve = () => {
      consulted++
      return "C:\\Wrong"
    }
    expect(routedEventDirectory({ directory: "C:\\ProjektA", payload, resolveSessionScope: resolve })).toBe(
      "C:\\ProjektA",
    )
    expect(consulted).toBe(0)
  })
})

describe("createSessionScopeRouting", () => {
  const makeTransport = () => {
    const delivered: Array<{ directory: string; type: string }> = []
    const queue = createServerEventQueue({
      signal: new AbortController().signal,
      emit: (directory, payload) => delivered.push({ directory, type: payload.type }),
      sync: (directory, payload) => delivered.push({ directory, type: payload.syncEvent.type }),
    })
    return { delivered, routing: createSessionScopeRouting({ push: queue.push }), flush: queue.flush }
  }
  const scopeless = (type: string, sessionID: string, id: string) =>
    ({ id, type, properties: { sessionID } }) as Event
  const metadata = (sessionID: string, directory: string) =>
    ({
      id: `evt_created_${sessionID}`,
      type: "session.created",
      properties: { info: { id: sessionID, directory } },
    }) as Event

  test("routes metadata and its follower events in one batch onto the learned project directory", () => {
    const { delivered, routing, flush } = makeTransport()
    routing.setResolver(() => {
      throw new Error("store lookup must not be needed for learned placement")
    })
    routing.push("global", metadata("ses_1", "C:\\ProjektA"))
    routing.push("global", scopeless("session.status", "ses_1", "evt_status"))
    routing.push("global", scopeless("session.next.text.delta", "ses_1", "evt_delta"))
    flush()

    expect(delivered.map((event) => [event.directory, event.type])).toEqual([
      ["c:/projekta", "session.created"],
      ["c:/projekta", "session.status"],
      ["c:/projekta", "session.next.text.delta"],
    ])
  })

  test("falls back to the installed resolver for known sessions and keeps unknown sessions global", () => {
    const { delivered, routing, flush } = makeTransport()
    routing.setResolver((payload) => {
      const ref = globalScopeSessionRef(payload)
      return ref && "sessionID" in ref && ref.sessionID === "ses_known" ? "C:/Known" : undefined
    })

    routing.push("global", scopeless("session.status", "ses_known", "evt_known"))
    routing.push("global", scopeless("session.status", "ses_unknown", "evt_unknown"))
    flush()

    expect(delivered.map((event) => [event.directory, event.type])).toEqual([
      ["c:/known", "session.status"],
      ["global", "session.status"],
    ])
  })

  test("keeps explicit directories untouched and refreshes learned placement from keyed metadata", () => {
    const { delivered, routing, flush } = makeTransport()
    routing.setResolver(() => {
      throw new Error("resolver must not run for directory-scoped events")
    })
    routing.push("C:/ProjektB", {
      id: "evt_moved",
      type: "session.updated",
      properties: { info: { id: "ses_moved", directory: "C:/ProjektB" } },
    } as Event)
    routing.push("global", scopeless("session.status", "ses_moved", "evt_followup"))
    flush()

    expect(delivered.map((event) => [event.directory, event.type])).toEqual([
      ["c:/projektb", "session.updated"],
      ["c:/projektb", "session.status"],
    ])
  })

  test("keeps non-session payloads on the global scope", () => {
    const { delivered, routing, flush } = makeTransport()
    routing.push("global", { type: "project.updated", properties: { id: "prj_1" } } as Event)
    routing.push("global", { type: "global.disposed", properties: {} } as Event)
    flush()

    expect(delivered.map((event) => [event.directory, event.type])).toEqual([
      ["global", "project.updated"],
      ["global", "global.disposed"],
    ])
  })
})

describe("createDirSdkContext", () => {
  test("matches equivalent Windows event directories", () => {
    expect(serverEventDirectoryKey("C:\\Repo-A\\Project")).toBe("c:/repo-a/project")
    expect(serverEventDirectoryKey("c:/repo-a/project/")).toBe("c:/repo-a/project")
    expect(serverEventDirectoryKey("/Repo-A/Project")).toBe("/Repo-A/Project")
  })

  test("multiplexes directory events without opening per-directory SSE connections", () => {
    let directSubscriptions = 0
    const handlers = new Map<string, (event: Event) => void>()
    const serverSDK = {
      scope: {},
      url: "http://127.0.0.1:4096",
      createClient: () => ({
        event: {
          subscribe: () => {
            directSubscriptions++
            return new Promise(() => {})
          },
        },
      }),
      event: {
        on: (directory: string, handler: (event: Event) => void) => {
          handlers.set(directory, handler)
          return () => handlers.delete(directory)
        },
      },
    } as unknown as Parameters<typeof createDirSdkContext>[1]
    const received: string[] = []

    createRoot((dispose) => {
      const first = createDirSdkContext("C:\\repo-a", serverSDK)
      createDirSdkContext("C:\\repo-b", serverSDK)
      const unsubscribe = first.event.on("session.status", (event) => received.push(event.properties.sessionID))
      handlers.get("c:/repo-a")?.({
        id: "evt_directory_a",
        type: "session.status",
        properties: { sessionID: "ses_a", status: { type: "idle" } },
      } as Event)

      expect(received).toEqual(["ses_a"])
      expect(handlers.size).toBe(2)
      expect(directSubscriptions).toBe(0)
      unsubscribe()
      dispose()
    })
  })
})
