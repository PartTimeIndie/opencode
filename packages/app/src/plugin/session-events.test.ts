import { describe, expect, test } from "bun:test"
import { createSessionSubscription, sessionEvent, sessionMessages } from "./session-events"

describe("voice permission recovery", () => {
  const request = { id: "per_child", sessionID: "child", action: "write", resources: ["notes.md"] }

  test("recovers only server-stamped approvals for the bound top-level worker without forwarding worker text", async () => {
    const events: unknown[] = []
    const voiceRequest = { ...request, sessionID: "worker", metadata: { "$opencode.permission.single_use": true } }
    let relatedSession: string | undefined = "worker"
    const subscription = createSessionSubscription({
      sessionID: "root", relatedSession: async () => relatedSession, session: async () => ({}),
      pending: async () => [voiceRequest, { ...request, id: "manual", sessionID: "worker" }, { ...voiceRequest, id: "foreign", sessionID: "foreign" }],
      emit: (event) => events.push(event),
    })
    await subscription.receive({ type: "permission.v2.replied", properties: { requestID: "unrelated", sessionID: "worker" } })
    expect(events).toEqual([])
    await subscription.recover()
    expect(events).toEqual([{ type: "permission.asked", requestID: request.id, sessionID: "worker", action: "write", resources: ["notes.md"] }])
    await subscription.receive({ type: "session.next.text.delta", properties: { sessionID: "worker", assistantMessageID: "a1", textID: "t1", delta: "Not moderator speech" } })
    await subscription.receive({ type: "permission.v2.asked", properties: { ...request, id: "manual-live", sessionID: "worker" } })
    expect(events).toHaveLength(1)
    relatedSession = undefined
    await subscription.receive({ type: "permission.v2.replied", properties: { requestID: request.id, sessionID: "worker" } })
    expect(events.at(-1)).toEqual({ type: "permission.replied", requestID: request.id })
    await subscription.recover()
    expect(events).toHaveLength(2)
  })

  test("a live worker reply wins over an older permission snapshot during pair lookup", async () => {
    const snapshot = Promise.withResolvers<unknown[]>()
    const events: unknown[] = []
    const subscription = createSessionSubscription({
      sessionID: "root", pending: () => snapshot.promise, relatedSession: async () => "worker",
      session: async () => ({}), emit: (event) => events.push(event),
    })
    const recovery = subscription.recover()
    await subscription.receive({ type: "permission.v2.replied", properties: { sessionID: "worker", requestID: request.id } })
    snapshot.resolve([{ ...request, sessionID: "worker", metadata: { "$opencode.permission.single_use": true } }])
    await recovery
    // Record the reply revision to invalidate the snapshot, but never emit a
    // top-level worker reply for a request this subscriber did not present.
    expect(events).toEqual([])
  })

  test("restores existing descendants and reconciles replies missed while disconnected", async () => {
    const events: unknown[] = []
    let requests = [request]
    const subscription = createSessionSubscription({
      sessionID: "root",
      pending: async () => requests,
      session: async (id) => ({ parentID: id === "child" ? "middle" : id === "middle" ? "root" : undefined }),
      emit: (event) => events.push(event),
    })
    await subscription.recover()
    expect(events).toEqual([{ type: "permission.asked", sessionID: "child", requestID: "per_child", action: "write", resources: ["notes.md"] }])
    requests = []
    await subscription.recover()
    expect(events.at(-1)).toEqual({ type: "permission.replied", requestID: "per_child" })
  })

  test("does not resurrect a permission replied to during snapshot recovery", async () => {
    const snapshot = Promise.withResolvers<unknown[]>()
    const events: unknown[] = []
    const subscription = createSessionSubscription({
      sessionID: "root", pending: () => snapshot.promise,
      session: async () => ({ parentID: "root" }), emit: (event) => events.push(event),
    })
    const recovery = subscription.recover()
    await subscription.receive({ type: "permission.v2.replied", properties: { sessionID: "child", requestID: "per_child" } })
    snapshot.resolve([request])
    await recovery
    expect(events).toEqual([{ type: "permission.replied", requestID: "per_child" }])
  })

  test("ignores unrelated or cyclic ancestry and emits nothing after disposal", async () => {
    const events: unknown[] = []
    const subscription = createSessionSubscription({
      sessionID: "root", pending: async () => [request],
      session: async () => ({ parentID: "child" }), emit: (event) => events.push(event),
    })
    await subscription.recover()
    subscription.dispose()
    await subscription.receive({ type: "permission.v2.asked", properties: { ...request, sessionID: "root" } })
    expect(events).toEqual([])
  })
})

describe("sessionEvent", () => {
  test("delivers versioned durable text and completion once across both SSE channels", async () => {
    const events: unknown[] = []
    const subscription = createSessionSubscription({ sessionID: "session-1", pending: async () => [], session: async () => undefined, emit: event => events.push(event) })
    const sync = { type: "sync", id: "transport-id", syncEvent: {
      id: "text-event", type: "session.next.text.ended.1", aggregateID: "session-1", seq: 7,
      data: { sessionID: "session-1", assistantMessageID: "answer", textID: "text", text: "Guten Tag.", timestamp: 123 },
    } }
    await subscription.receive(sync)
    await subscription.receive({ id: "text-event", type: "session.next.text.ended", properties: sync.syncEvent.data })
    await subscription.receive({ ...sync, syncEvent: { ...sync.syncEvent, id: "complete-event", type: "session.next.activity.completed.1" } })
    expect(events).toEqual([{ type: "text.ended", messageID: "answer", textID: "text", text: "Guten Tag." }, { type: "activity.completed" }])
    subscription.dispose()
    await subscription.receive({ ...sync, syncEvent: { ...sync.syncEvent, id: "after-dispose" } })
    expect(events).toHaveLength(2)
    expect(sessionEvent({ ...sync, syncEvent: { ...sync.syncEvent, aggregateID: "foreign" } }, "session-1")).toBeUndefined()
    expect(sessionEvent(sync, "foreign")).toBeUndefined()
  })
  test("forwards text deltas only for the requested session", () => {
    const event = {
      type: "session.next.text.delta",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "message-1",
        textID: "text-1",
        delta: "Hello",
      },
    }

    expect(sessionEvent(event, "session-1")).toEqual({
      type: "text.delta",
      messageID: "message-1",
      textID: "text-1",
      delta: "Hello",
    })
    expect(sessionEvent(event, "session-2")).toBeUndefined()
  })

  test("sanitizes permission events to the scoped public contract", () => {
    expect(
      sessionEvent(
        {
          type: "permission.v2.asked",
          properties: {
            sessionID: "child-1",
            id: "permission-1",
            action: "write",
            resources: ["notes.md", 42],
            metadata: { secret: "not forwarded" },
          },
        },
        "session-1",
        new Set(["session-1", "child-1"]),
      ),
    ).toEqual({
      type: "permission.asked",
      sessionID: "child-1",
      requestID: "permission-1",
      action: "write",
      resources: ["notes.md"],
    })
  })

  test("does not forward permissions from unrelated sessions", () => {
    expect(
      sessionEvent(
        {
          type: "permission.v2.asked",
          properties: { sessionID: "other", id: "permission-2", action: "write", resources: ["secret"] },
        },
        "session-1",
        new Set(["session-1", "child-1"]),
      ),
    ).toBeUndefined()
  })
})

describe("sessionMessages", () => {
  test("projects only visible user and assistant text", () => {
    expect(
      sessionMessages([
        { id: "u1", type: "user", text: "Question", time: { created: 1 }, metadata: { hidden: true } },
        {
          id: "a1",
          type: "assistant",
          time: { created: 2 },
          content: [
            { id: "r1", type: "reasoning", text: "private" },
            { id: "t1", type: "text", text: "Answer" },
          ],
        },
        { id: "s1", type: "system", text: "hidden", time: { created: 0 } },
      ]),
    ).toEqual([
      { id: "u1", role: "user", text: "Question", createdAt: 1 },
      { id: "a1", role: "assistant", text: "Answer", createdAt: 2 },
    ])
  })
})
