import { describe, expect, test } from "bun:test"
import {
  activeSessionReadyForBackgroundPrefetch,
  canUseSessionPrefetch,
  cancelSessionPrefetch,
  clearSessionPrefetch,
  clearSessionPrefetchDirectory,
  getSessionPrefetch,
  getSessionPrefetchPromise,
  markSessionPrefetchFailed,
  runSessionPrefetch,
  sessionPrefetchCoolingDown,
  setSessionPrefetch,
  shouldSkipSessionPrefetch,
} from "./session-prefetch"
import { ServerScope } from "@/utils/server-scope"

const scope = ServerScope.local

describe("session prefetch", () => {
  test("backs off failed background reads until the cooldown expires", () => {
    clearSessionPrefetch(scope, "/tmp/failed", ["ses_1"])
    markSessionPrefetchFailed(scope, "/tmp/failed", "ses_1", 1_000)

    expect(sessionPrefetchCoolingDown(scope, "/tmp/failed", "ses_1", 1_001)).toBe(true)
    expect(sessionPrefetchCoolingDown(scope, "/tmp/failed", "ses_1", 301_000)).toBe(false)
  })

  test("successful prefetch metadata clears a prior failure cooldown", () => {
    clearSessionPrefetch(scope, "/tmp/recovered", ["ses_1"])
    markSessionPrefetchFailed(scope, "/tmp/recovered", "ses_1", 1_000)
    setSessionPrefetch({ scope, directory: "/tmp/recovered", sessionID: "ses_1", limit: 80, complete: false })

    expect(sessionPrefetchCoolingDown(scope, "/tmp/recovered", "ses_1", 1_001)).toBe(false)
  })

  test("waits for a completed foreground page before background prefetch", () => {
    expect(activeSessionReadyForBackgroundPrefetch({ message: false })).toBe(false)
    expect(activeSessionReadyForBackgroundPrefetch({ message: true })).toBe(false)
    expect(
      activeSessionReadyForBackgroundPrefetch({ message: true, info: { limit: 0, complete: true, at: 1 } }),
    ).toBe(true)
  })

  test("stores and clears message metadata by directory", () => {
    clearSessionPrefetch(scope, "/tmp/a", ["ses_1"])
    clearSessionPrefetch(scope, "/tmp/b", ["ses_1"])

    setSessionPrefetch({
      directory: "/tmp/a",
      scope,
      sessionID: "ses_1",
      limit: 200,
      cursor: "abc",
      complete: false,
      at: 123,
    })

    expect(getSessionPrefetch(scope, "/tmp/a", "ses_1")).toEqual({
      limit: 200,
      cursor: "abc",
      complete: false,
      at: 123,
    })
    expect(getSessionPrefetch(scope, "/tmp/b", "ses_1")).toBeUndefined()

    clearSessionPrefetch(scope, "/tmp/a", ["ses_1"])

    expect(getSessionPrefetch(scope, "/tmp/a", "ses_1")).toBeUndefined()
  })

  test("dedupes inflight work", async () => {
    clearSessionPrefetch(scope, "/tmp/c", ["ses_2"])

    let calls = 0
    const run = () =>
      runSessionPrefetch({
        directory: "/tmp/c",
        scope,
        sessionID: "ses_2",
        task: async () => {
          calls += 1
          return { limit: 100, cursor: "next", complete: true, at: 456 }
        },
      })

    const [a, b] = await Promise.all([run(), run()])

    expect(calls).toBe(1)
    expect(a).toEqual({ limit: 100, cursor: "next", complete: true, at: 456 })
    expect(b).toEqual({ limit: 100, cursor: "next", complete: true, at: 456 })
  })

  test("clears a whole directory", () => {
    setSessionPrefetch({
      scope,
      directory: "/tmp/d",
      sessionID: "ses_1",
      limit: 10,
      cursor: "a",
      complete: true,
      at: 1,
    })
    setSessionPrefetch({
      scope,
      directory: "/tmp/d",
      sessionID: "ses_2",
      limit: 20,
      cursor: "b",
      complete: false,
      at: 2,
    })
    setSessionPrefetch({
      scope,
      directory: "/tmp/e",
      sessionID: "ses_1",
      limit: 30,
      cursor: "c",
      complete: true,
      at: 3,
    })

    clearSessionPrefetchDirectory(scope, "/tmp/d")

    expect(getSessionPrefetch(scope, "/tmp/d", "ses_1")).toBeUndefined()
    expect(getSessionPrefetch(scope, "/tmp/d", "ses_2")).toBeUndefined()
    expect(getSessionPrefetch(scope, "/tmp/e", "ses_1")).toEqual({ limit: 30, cursor: "c", complete: true, at: 3 })
  })

  test("isolates identical directories and sessions by server scope", () => {
    const remote = "https://debian.example" as ServerScope
    setSessionPrefetch({ scope, directory: "/repo", sessionID: "ses_1", limit: 10, complete: true, at: 1 })
    setSessionPrefetch({ scope: remote, directory: "/repo", sessionID: "ses_1", limit: 20, complete: true, at: 2 })

    expect(getSessionPrefetch(scope, "/repo", "ses_1")?.limit).toBe(10)
    expect(getSessionPrefetch(remote, "/repo", "ses_1")?.limit).toBe(20)
  })

  test("keeps a full first prefetched page cached for passive prefetch", () => {
    expect(
      shouldSkipSessionPrefetch({
        message: true,
        info: { limit: 200, cursor: "x", complete: false, at: 1 },
        chunk: 200,
        now: 1 + 15_001,
      }),
    ).toBe(true)
  })

  test("cancels a passive read so foreground navigation can start immediately", async () => {
    clearSessionPrefetch(scope, "/tmp/foreground", ["ses_1"])

    let aborted = false
    const pending = runSessionPrefetch({
      directory: "/tmp/foreground",
      scope,
      sessionID: "ses_1",
      task: (_, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true
            resolve(undefined)
          })
        }),
    })

    expect(getSessionPrefetchPromise(scope, "/tmp/foreground", "ses_1")).toBe(pending)
    cancelSessionPrefetch(scope, "/tmp/foreground", "ses_1")

    expect(aborted).toBe(true)
    expect(getSessionPrefetchPromise(scope, "/tmp/foreground", "ses_1")).toBeUndefined()
    await pending
  })

  test("requires matching messages before using prefetched metadata", () => {
    const info = { limit: 80, cursor: "x", complete: false, at: 1 }

    expect(canUseSessionPrefetch({ messageCount: 1, info })).toBe(false)
    expect(canUseSessionPrefetch({ messageCount: 80, info })).toBe(true)
    expect(canUseSessionPrefetch({ messageCount: 120, info })).toBe(true)
  })

  test("rejects shallow incomplete metadata for initial session hydration", () => {
    expect(
      canUseSessionPrefetch({
        messageCount: 2,
        info: { limit: 2, cursor: "x", complete: false, at: 1 },
        minLimit: 25,
      }),
    ).toBe(false)

    expect(
      canUseSessionPrefetch({
        messageCount: 2,
        info: { limit: 2, complete: true, at: 1 },
        minLimit: 25,
      }),
    ).toBe(true)
  })

  test("refreshes stale partial prefetched history", () => {
    expect(
      shouldSkipSessionPrefetch({
        message: true,
        info: { limit: 100, cursor: "x", complete: false, at: 1 },
        chunk: 200,
        now: 1 + 15_001,
      }),
    ).toBe(false)
  })

  test("keeps deeper or complete history cached", () => {
    expect(
      shouldSkipSessionPrefetch({
        message: true,
        info: { limit: 400, cursor: "x", complete: false, at: 1 },
        chunk: 200,
        now: 1 + 15_001,
      }),
    ).toBe(true)

    expect(
      shouldSkipSessionPrefetch({
        message: true,
        info: { limit: 120, complete: true, at: 1 },
        chunk: 200,
        now: 1 + 15_001,
      }),
    ).toBe(true)
  })
})
