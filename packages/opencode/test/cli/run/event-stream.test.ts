import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import {
  createTurnCompletionTracker,
  settleEventStream,
  turnCompletionError,
  waitForCompletedAssistant,
  waitForRunCompletion,
  waitForTerminalAssistant,
  waitForTurnCompletion,
} from "@/cli/cmd/run/event-stream"

describe("createTurnCompletionTracker", () => {
  test("a delayed activity snapshot cannot replace a live activity observed while it was loading", () => {
    const tracker = createTurnCompletionTracker("session")
    tracker.observe({ type: "session.next.activity.started", properties: { sessionID: "session", activityID: "live" } })
    tracker.seed("stale-snapshot")
    tracker.observe({ type: "session.next.prompt.promoted", properties: { sessionID: "session", messageID: "input" } })
    tracker.observe({
      id: EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: "live" }),
      type: "session.turn.completed",
      properties: { sessionID: "session", status: "incomplete" },
    })
    expect(tracker.get("input")).toBe("incomplete")
  })

  for (const status of ["done", "incomplete"] as const) {
    test(`does not replace the new ${status} verdict with a delayed old activity verdict`, () => {
      const tracker = createTurnCompletionTracker("session")
      tracker.observe({
        type: "session.next.activity.started",
        properties: { sessionID: "session", activityID: "old" },
      })
      tracker.observe({
        type: "session.next.prompt.promoted",
        properties: { sessionID: "session", messageID: "old-input" },
      })
      tracker.observe({
        type: "session.next.activity.started",
        properties: { sessionID: "session", activityID: "new" },
      })
      tracker.observe({
        type: "session.next.prompt.promoted",
        properties: { sessionID: "session", messageID: "new-input" },
      })
      tracker.observe({
        id: EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: "new" }),
        type: "session.turn.completed",
        properties: { sessionID: "session", status },
      })
      tracker.observe({
        id: EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: "old" }),
        type: "session.turn.completed",
        properties: { sessionID: "session", status: status === "done" ? "incomplete" : "done" },
      })
      expect(tracker.get("new-input")).toBe(status)
    })
  }

  test("binds a terminal continuation verdict to every input promoted in its activity", () => {
    const tracker = createTurnCompletionTracker("session")
    tracker.observe({
      type: "session.next.activity.started",
      properties: { sessionID: "session", activityID: "first" },
    })
    for (const messageID of ["cli-input", "coalesced-input"])
      tracker.observe({ type: "session.next.prompt.promoted", properties: { sessionID: "session", messageID } })
    tracker.observe({
      type: "session.next.activity.started",
      properties: { sessionID: "session", activityID: "continuation" },
    })
    tracker.observe({
      id: EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: "continuation" }),
      type: "session.turn.completed",
      properties: { sessionID: "session", status: "incomplete" },
    })
    expect(tracker.get("cli-input")).toBe("incomplete")
    expect(tracker.get("coalesced-input")).toBe("incomplete")
  })

  test("keeps prior task verdicts separate when a later activity promotes a new input", () => {
    const tracker = createTurnCompletionTracker("session")
    tracker.seed("old")
    tracker.observe({ type: "session.next.prompt.promoted", properties: { sessionID: "session", messageID: "old" } })
    tracker.observe({
      id: EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: "old" }),
      type: "session.turn.completed",
      properties: { sessionID: "session", status: "incomplete" },
    })
    tracker.observe({ type: "session.next.activity.started", properties: { sessionID: "session", activityID: "new" } })
    tracker.observe({ type: "session.next.prompt.promoted", properties: { sessionID: "session", messageID: "new" } })
    tracker.observe({
      id: EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: "new" }),
      type: "session.turn.completed",
      properties: { sessionID: "session", status: "done" },
    })
    expect(tracker.get("old")).toBe("incomplete")
    expect(tracker.get("new")).toBe("done")
  })

  test("does not bind unrelated sessions, admission-only, legacy or unanchored verdicts", () => {
    const tracker = createTurnCompletionTracker("session")
    for (const type of ["session.next.prompt.admitted", "session.next.prompted"])
      tracker.observe({ type, properties: { sessionID: "session", messageID: "unpromoted" } })
    tracker.observe({ type: "session.next.prompt.promoted", properties: { sessionID: "other", messageID: "foreign" } })
    tracker.observe({ type: "session.turn.completed", properties: { sessionID: "session", status: "incomplete" } })
    expect(tracker.get("unpromoted")).toBeUndefined()
    expect(tracker.get("foreign")).toBeUndefined()
    tracker.seed("own-activity")
    tracker.observe({ type: "session.next.prompt.promoted", properties: { sessionID: "session", messageID: "own" } })
    tracker.observe({ type: "session.turn.completed", properties: { sessionID: "other", status: "incomplete" } })
    expect(tracker.get("own")).toBeUndefined()
    tracker.observe({
      id: "unrelated-event",
      type: "session.turn.completed",
      properties: { sessionID: "session", status: "incomplete" },
    })
    tracker.observe({ type: "session.turn.completed", properties: { sessionID: "session", status: "incomplete" } })
    expect(tracker.get("own")).toBeUndefined()
  })

  test("an older activity verdict cannot supersede its continuation for the same input", () => {
    const tracker = createTurnCompletionTracker("session")
    tracker.seed("parent")
    tracker.observe({ type: "session.next.prompt.promoted", properties: { sessionID: "session", messageID: "input" } })
    tracker.observe({
      type: "session.next.activity.started",
      properties: { sessionID: "session", activityID: "successor" },
    })
    tracker.observe({
      id: EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: "successor" }),
      type: "session.turn.completed",
      properties: { sessionID: "session", status: "done" },
    })
    tracker.observe({
      id: EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: "parent" }),
      type: "session.turn.completed",
      properties: { sessionID: "session", status: "incomplete" },
    })
    expect(tracker.get("input")).toBe("done")
  })
})

describe("waitForTurnCompletion", () => {
  function tracker() {
    const tracker = createTurnCompletionTracker("session")
    tracker.seed("first")
    tracker.observe({ type: "session.next.prompt.promoted", properties: { sessionID: "session", messageID: "input" } })
    tracker.observe({
      type: "session.next.activity.completed",
      properties: { sessionID: "session", activityID: "first" },
    })
    return tracker
  }
  function verdict(tracker: ReturnType<typeof createTurnCompletionTracker>, activityID = "first") {
    tracker.observe({
      id: EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: activityID }),
      type: "session.turn.completed",
      properties: { sessionID: "session", status: "done" },
    })
  }

  test("waits for its exact delayed terminal verdict", async () => {
    const current = tracker()
    const waiting = waitForTurnCompletion({
      messageID: "input",
      tracker: current,
      completed: new Promise(() => {}),
      done: () => false,
      interrupted: () => false,
      wait: () => Promise.resolve(),
      timeoutMs: 100,
      pollMs: 5,
    })
    current.observe({
      id: EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: "foreign" }),
      type: "session.turn.completed",
      properties: { sessionID: "session", status: "done" },
    })
    await Bun.sleep(20)
    verdict(current)
    expect(await waiting).toBe("done")
  })

  test("bounds a terminal activity whose verdict never arrives", async () => {
    expect(
      await waitForTurnCompletion({
        messageID: "input",
        tracker: tracker(),
        completed: new Promise(() => {}),
        done: () => false,
        interrupted: () => false,
        wait: () => Promise.resolve(),
        timeoutMs: 15,
        pollMs: 5,
      }),
    ).toBeUndefined()
  })

  test("uses a durable bound verdict when the event stream misses it", async () => {
    const current = tracker()
    expect(
      await waitForTurnCompletion({
        messageID: "input",
        tracker: current,
        completed: new Promise(() => {}),
        done: () => false,
        interrupted: () => false,
        wait: () => Promise.resolve(),
        readDurable: async () => (current.activity("input")?.activityID === "first" ? "done" : undefined),
        timeoutMs: 100,
        pollMs: 5,
      }),
    ).toBe("done")
  })

  test("an ended event stream cannot supply a missing verdict", async () => {
    expect(
      await waitForTurnCompletion({
        messageID: "input",
        tracker: tracker(),
        completed: Promise.resolve(undefined),
        done: () => true,
        interrupted: () => false,
        wait: () => Promise.resolve(),
        timeoutMs: 1_000,
      }),
    ).toBeUndefined()
  })

  test("keeps real continuation work alive beyond the terminal deadline", async () => {
    const current = tracker()
    const active = Promise.withResolvers<void>()
    let waits = 0
    const waiting = waitForTurnCompletion({
      messageID: "input",
      tracker: current,
      completed: new Promise(() => {}),
      done: () => false,
      interrupted: () => false,
      wait: () => {
        waits += 1
        return active.promise
      },
      timeoutMs: 40,
      pollMs: 5,
    })
    await Bun.sleep(10)
    current.observe({ type: "session.next.activity.started", properties: { sessionID: "session", activityID: "next" } })
    await Bun.sleep(70)
    expect(waits).toBe(1)
    current.observe({
      type: "session.next.activity.completed",
      properties: { sessionID: "session", activityID: "next" },
    })
    active.resolve()
    await Bun.sleep(10)
    verdict(current, "next")
    expect(await waiting).toBe("done")
  })

  test("an old verdict cannot complete an active successor for the same input", async () => {
    const current = tracker()
    current.observe({ type: "session.next.activity.started", properties: { sessionID: "session", activityID: "next" } })
    verdict(current)
    expect(current.get("input")).toBeUndefined()
    verdict(current, "next")
    expect(current.get("input")).toBe("done")
  })

  test("EOF still joins active continuation work before reporting a missing verdict", async () => {
    const current = tracker()
    current.observe({ type: "session.next.activity.started", properties: { sessionID: "session", activityID: "next" } })
    const active = Promise.withResolvers<void>()
    let finished = false
    const waiting = waitForTurnCompletion({
      messageID: "input",
      tracker: current,
      completed: Promise.resolve(undefined),
      done: () => true,
      interrupted: () => false,
      wait: () => active.promise,
      timeoutMs: 15,
    }).then((result) => {
      finished = true
      return result
    })
    await Bun.sleep(30)
    expect(finished).toBe(false)
    active.resolve()
    expect(await waiting).toBeUndefined()
  })

  test("honors an explicit user interruption while awaiting terminal completion", async () => {
    let interrupted = false
    const waiting = waitForTurnCompletion({
      messageID: "input",
      tracker: tracker(),
      completed: new Promise(() => {}),
      done: () => false,
      interrupted: () => interrupted,
      wait: () => Promise.resolve(),
      timeoutMs: 1_000,
      pollMs: 5,
    })
    await Bun.sleep(10)
    interrupted = true
    expect(await waiting).toBeUndefined()
  })

  test("a granted extension accepts a verdict that outlives the plain deadline", async () => {
    const current = tracker()
    const waiting = waitForTurnCompletion({
      messageID: "input",
      tracker: current,
      completed: new Promise(() => {}),
      done: () => false,
      interrupted: () => false,
      wait: () => Promise.resolve(),
      timeoutMs: 15,
      pollMs: 5,
      extensionMs: 250,
      maxExtensions: 1,
    })
    // The server publishes the bound verdict after the plain deadline, while
    // the evaluation retry backoff or a deferred continuation is still busy.
    await Bun.sleep(40)
    expect(current.get("input")).toBeUndefined()
    verdict(current)
    expect(await waiting).toBe("done")
  })

  test("a closed event stream never gains extension wait", async () => {
    const started = Date.now()
    expect(
      await waitForTurnCompletion({
        messageID: "input",
        tracker: tracker(),
        completed: Promise.resolve(undefined),
        done: () => true,
        interrupted: () => false,
        wait: () => Promise.resolve(),
        timeoutMs: 15,
        pollMs: 5,
        extensionMs: 10_000,
        maxExtensions: 3,
      }),
    ).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("stops extending once the extension budget is spent", async () => {
    const started = Date.now()
    expect(
      await waitForTurnCompletion({
        messageID: "input",
        tracker: tracker(),
        completed: new Promise(() => {}),
        done: () => false,
        interrupted: () => false,
        wait: () => Promise.resolve(),
        timeoutMs: 15,
        pollMs: 5,
        extensionMs: 60,
        maxExtensions: 1,
      }),
    ).toBeUndefined()
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(70)
    expect(elapsed).toBeLessThan(5_000)
  })
})

describe("turnCompletionError", () => {
  test("accepts only a done verdict when completion is required", () => {
    expect(turnCompletionError("done", true)).toBeUndefined()
    expect(turnCompletionError(undefined, true)?.name).toBe("TurnCompletionVerdictUnavailableError")
    expect(turnCompletionError("unknown", true)?.name).toBe("TurnCompletionVerdictUnavailableError")
    expect(turnCompletionError("incomplete", true)?.name).toBe("TurnCompletionIncompleteError")
  })

  test("disabled completion tolerates absence, not an explicit unknown or incomplete verdict", () => {
    expect(turnCompletionError(undefined, false)).toBeUndefined()
    expect(turnCompletionError("done", false)).toBeUndefined()
    expect(turnCompletionError("unknown", false)?.message).toContain("bound final verdict is unknown")
    expect(turnCompletionError("incomplete", false)?.name).toBe("TurnCompletionIncompleteError")
  })

  test("classifies the actual latest bound tracker verdict without borrowing an older done", () => {
    const tracker = createTurnCompletionTracker("session")
    tracker.seed("old")
    tracker.observe({ type: "session.next.prompt.promoted", properties: { sessionID: "session", messageID: "input" } })
    for (const [activityID, status] of [["old", "done"], ["next", "unknown"]] as const) {
      if (activityID === "next") tracker.observe({
        type: "session.next.activity.started", properties: { sessionID: "session", activityID },
      })
      tracker.observe({
        id: EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: activityID }),
        type: "session.turn.completed", properties: { sessionID: "session", status },
      })
    }
    expect(turnCompletionError(tracker.get("input"), true)?.name).toBe("TurnCompletionVerdictUnavailableError")
  })
})

describe("waitForRunCompletion", () => {
  test("an ended event stream does not end a still running session", async () => {
    const terminal = Promise.withResolvers<void>()
    let finished = false
    const waiting = waitForRunCompletion({
      completed: Promise.resolve(undefined),
      wait: terminal.promise,
    }).then(() => {
      finished = true
    })
    await Bun.sleep(10)
    expect(finished).toBe(false)
    terminal.resolve()
    await waiting
    expect(finished).toBe(true)
  })

  test("does not lose authoritative failure after the event stream ends", async () => {
    const terminal = Promise.withResolvers<void>()
    const waiting = waitForRunCompletion({ completed: Promise.resolve(undefined), wait: terminal.promise })
    terminal.reject(new Error("incomplete assistant"))
    await expect(waiting).rejects.toThrow("incomplete assistant")
  })

  test("session completion does not wait for an endless event stream", async () => {
    await waitForRunCompletion({ completed: new Promise(() => {}), wait: Promise.resolve() })
  })

  test("a reported event failure is not treated as successful completion", async () => {
    await expect(
      waitForRunCompletion({
        completed: Promise.resolve("provider failed"),
        wait: new Promise(() => {}),
      }),
    ).rejects.toThrow("provider failed")
  })
})

describe("waitForTerminalAssistant", () => {
  test("returns a durable final assistant when the session wait stays pending", async () => {
    let reads = 0
    const assistant = { id: "final", completed: true }
    const result = await waitForTerminalAssistant({
      wait: new Promise(() => {}),
      interrupted: () => false,
      pollMs: 1,
      observe: async () => ++reads < 2 ? { terminal: false } : { terminal: true, assistant },
    })
    expect(result).toEqual(assistant)
    expect(reads).toBe(2)
  })

  test("stops polling once the wait resolves without a terminal assistant", async () => {
    let reads = 0
    const result = await waitForTerminalAssistant({
      wait: Promise.resolve(),
      interrupted: () => false,
      pollMs: 1,
      observe: async () => {
        reads += 1
        return { terminal: false }
      },
    })
    expect(result).toBeUndefined()
    expect(reads).toBeGreaterThan(0)
    const settled = reads
    await Bun.sleep(20)
    expect(reads).toBe(settled)
  })

  test("stops polling when observations stay terminal without an assistant and the wait resolves", async () => {
    let reads = 0
    const result = await waitForTerminalAssistant({
      wait: new Promise<void>((resolve) => setTimeout(resolve, 6)),
      interrupted: () => false,
      pollMs: 1,
      observe: async () => {
        reads += 1
        return { terminal: true }
      },
    })
    expect(result).toBeUndefined()
    expect(reads).toBeGreaterThan(0)
    const settled = reads
    await Bun.sleep(20)
    expect(reads).toBe(settled)
  })

  test("propagates a rejected wait and stops polling", async () => {
    let reads = 0
    await expect(
      waitForTerminalAssistant({
        wait: Promise.reject(new Error("session wait failed")),
        interrupted: () => false,
        pollMs: 1,
        observe: async () => {
          reads += 1
          return { terminal: true }
        },
      }),
    ).rejects.toThrow("session wait failed")
    const settled = reads
    await Bun.sleep(20)
    expect(reads).toBe(settled)
  })

  test("does not begin a further round when the wait settles during an in-flight observation", async () => {
    let reads = 0
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const run = waitForTerminalAssistant({
      wait: new Promise<void>((resolve) => setTimeout(resolve, 4)),
      interrupted: () => false,
      pollMs: 1,
      observe: async () => {
        reads += 1
        if (reads === 1) await firstGate
        return { terminal: false }
      },
    })
    await Bun.sleep(20)
    releaseFirst()
    expect(await run).toBeUndefined()
    const settled = reads
    await Bun.sleep(20)
    expect(reads).toBe(settled)
  })
})

describe("settleEventStream", () => {
  test("returns a completed event stream without aborting it", async () => {
    let aborted = false
    const result = await settleEventStream({
      completed: Promise.resolve("provider failed"),
      done: () => true,
      abort: () => {
        aborted = true
      },
      graceMs: 5,
    })

    expect(result).toBe("provider failed")
    expect(aborted).toBe(false)
  })

  test("bounds a stream that ignores abort after the terminal session state", async () => {
    let aborted = false
    const started = Date.now()
    const result = await settleEventStream({
      completed: new Promise(() => {}),
      done: () => false,
      abort: () => {
        aborted = true
      },
      graceMs: 5,
    })

    expect(result).toBeUndefined()
    expect(aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(100)
  })
})

describe("waitForCompletedAssistant", () => {
  test("returns fresh completed output", async () => {
    const assistant = { id: "assistant-2", completed: true }
    expect(
      await waitForCompletedAssistant({
        previousMarker: JSON.stringify({ id: "assistant-1", completed: true }),
        read: async () => assistant,
        interrupted: () => false,
        completed: (item) => item.completed,
        error: () => undefined,
        timeoutMs: 20,
        pollMs: 1,
      }),
    ).toBe(assistant)
  })

  test("stops cleanly when the user interrupts an idle Session without a completed assistant", async () => {
    let reads = 0
    expect(
      await waitForCompletedAssistant({
        previousMarker: "null",
        read: async () => {
          reads++
          return undefined
        },
        interrupted: () => true,
        completed: () => false,
        error: () => undefined,
        timeoutMs: 5,
        pollMs: 1,
      }),
    ).toBeUndefined()
    expect(reads).toBe(0)
  })
})
