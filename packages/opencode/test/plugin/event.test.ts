import { describe, expect, test } from "bun:test"
import { pluginEventType, runPluginEventHooks } from "../../src/plugin/event"

describe("plugin event compatibility", () => {
  test("removes the internal numeric event version", () => {
    expect(pluginEventType("session.turn.completed.1")).toBe("session.turn.completed")
    expect(pluginEventType("session.next.step.ended.2")).toBe("session.next.step.ended")
  })

  test("preserves unversioned and nonnumeric event names", () => {
    expect(pluginEventType("session.status")).toBe("session.status")
    expect(pluginEventType("plugin.release.beta")).toBe("plugin.release.beta")
  })

  test("reports sync and async hook failures while preserving hook order", async () => {
    const calls: number[] = []
    const errors = await runPluginEventHooks(
      [
        () => {
          calls.push(1)
          throw new Error("sync failure")
        },
        async () => {
          calls.push(2)
          throw new Error("async failure")
        },
        undefined,
        () => {
          calls.push(3)
        },
      ],
      { event: { type: "session.turn.completed" } },
    )

    expect(calls).toEqual([1, 2, 3])
    expect(errors.map((error) => (error as Error).message)).toEqual(["sync failure", "async failure"])
  })
})
