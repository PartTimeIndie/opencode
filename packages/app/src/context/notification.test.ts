import { describe, expect, test } from "bun:test"
import { sessionNotificationEvent } from "./notification-event"

describe("sessionNotificationEvent", () => {
  test("recognizes legacy and versioned session completion and errors", () => {
    ;["session.idle", "session.idle.1", "session.idle.2"].forEach((type) => {
      expect(sessionNotificationEvent({ type })).toBe("idle")
    })
    ;["session.error", "session.error.1", "session.error.2"].forEach((type) => {
      expect(sessionNotificationEvent({ type })).toBe("error")
    })
  })

  test("recognizes durable activity failures", () => {
    ;[
      "session.next.activity.failed",
      "session.next.activity.failed.1",
      "session.next.activity.failed.2",
    ].forEach((type) => {
      expect(sessionNotificationEvent({ type })).toBe("error")
    })
  })

  test("ignores expected durable activity interruptions", () => {
    ;["user-stop", "owner-interrupted", "owner-shutdown", "stale-lease", "rollback"].forEach((reason) => {
      ;[
        "session.next.activity.interrupted",
        "session.next.activity.interrupted.1",
        "session.next.activity.interrupted.2",
      ].forEach((type) => {
        expect(sessionNotificationEvent({ type, properties: { reason } })).toBeUndefined()
      })
    })
  })

  test("recognizes legacy and unexpected durable activity interruptions as errors", () => {
    ;[undefined, {}, { reason: undefined }, { reason: null }, { reason: "unexpected" }].forEach((properties) => {
      expect(sessionNotificationEvent({ type: "session.next.activity.interrupted.2", properties })).toBe("error")
    })
  })

  test("treats durable activity completion as idle", () => {
    ;[
      "session.next.activity.completed",
      "session.next.activity.completed.1",
      "session.next.activity.completed.2",
    ].forEach((type) => {
      expect(sessionNotificationEvent({ type })).toBe("idle")
    })
  })

  test("ignores non-terminal activity events", () => {
    expect(sessionNotificationEvent({ type: "session.next.activity.started.1" })).toBeUndefined()
    expect(sessionNotificationEvent({ type: "session.next.activity.recovered.1" })).toBeUndefined()
  })
})
