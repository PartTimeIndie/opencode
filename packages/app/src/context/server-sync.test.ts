import { describe, expect, spyOn, test } from "bun:test"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
import {
  estimateRootSessionTotal,
  loadRootSessionsWithFallback,
  waitForSharedSessionLoad,
} from "./global-sync/session-load"
import {
  directoryStoreForEvent,
  isSessionTabEvent,
  loadLspQuery,
  loadMcpQuery,
  makeQueryOptionsApi,
  mcpSetupSessionModel,
  reconcileSessionStatusSnapshot,
  createSerialDirectoryLoader,
  loadPassiveSessionInfo,
  loadPassiveSessionStatus,
  recoverMissingSessionInfo,
  withAbortableDeadline,
  PASSIVE_SIDEBAR_REQUEST_TIMEOUT_MS,
  SESSION_STATUS_RECONCILIATION_INTERVAL_MS,
  SESSION_STATUS_POLL_INTERVAL_MS,
  sessionDirectoryInStores,
  sessionIDsForStatusRecovery,
  sessionsNeedingStatusRecovery,
  sessionTabSyncEvent,
  shouldApplySessionStatusResponse,
  shouldPollSessionStatus,
  shouldRefreshDirectoryStatus,
  sessionStatusReconciliationScope,
  statusSnapshotRecoversMissedTerminal,
  withBootstrapSessions,
} from "./server-sync"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { ServerScope } from "@/utils/server-scope"
import { directoryKey, pathKey } from "@/utils/path-key"
import {
  finishSessionActivity,
  sessionActivity,
  sessionActivityGenerationSnapshot,
  sessionActivitySettled,
  sessionActivityStartedAt,
  startSessionActivity,
} from "@/utils/session-activity"
import {
  latestAssistantCompletedBefore,
  latestAssistantSettled,
  resolveLifecycleStatus,
  sessionIsWorking,
} from "@/utils/session-status"
import { activeSessionReadyForBackgroundPrefetch } from "./global-sync/session-prefetch"

describe("mcpSetupSessionModel", () => {
  test("snapshots the selected default chain in configured order", () => {
    expect(
      mcpSetupSessionModel({
        default_model_chain: "default",
        model_chains: [
          {
            id: "unrelated",
            name: "Unrelated",
            steps: [{ providerID: "other", modelID: "wrong" }],
          },
          {
            id: "default",
            name: "GLM Codex Chain",
            steps: [
              { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" },
              { providerID: "zai", modelID: "glm-5.3" },
            ],
          },
        ],
      }),
    ).toEqual({
      id: "gpt-5.6-sol",
      providerID: "openai",
      variant: "high",
      chain: {
        id: "default",
        name: "GLM Codex Chain",
        active: 0,
        steps: [
          { id: "gpt-5.6-sol", providerID: "openai", variant: "high" },
          { id: "glm-5.3", providerID: "zai" },
        ],
      },
    })
  })

  test("does not silently choose an unrelated chain", () => {
    expect(
      mcpSetupSessionModel({
        default_model_chain: "retired",
        model_chains: [
          {
            id: "available",
            name: "Available",
            steps: [{ providerID: "zai", modelID: "glm-5.3" }],
          },
        ],
      }),
    ).toBeUndefined()
  })
})

describe("pickDirectoriesToEvict", () => {
  test("keeps pinned stores and evicts idle stores", () => {
    const now = 5_000
    const picks = pickDirectoriesToEvict({
      stores: ["a", "b", "c", "d"],
      state: new Map([
        ["a", { lastAccessAt: 1_000 }],
        ["b", { lastAccessAt: 4_900 }],
        ["c", { lastAccessAt: 4_800 }],
        ["d", { lastAccessAt: 3_000 }],
      ]),
      pins: new Set(["a"]),
      max: 2,
      ttl: 1_500,
      now,
    })

    expect(picks).toEqual(["d", "c"])
  })
})

describe("loadRootSessionsWithFallback", () => {
  test("uses limited roots query when supported", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 10,
      list: async (query) => {
        calls.push(query)
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(true)
    expect(calls).toEqual([{ directory: "dir", roots: true, limit: 10 }])
  })

  test("falls back to full roots query on limited-query failure", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 25,
      list: async (query) => {
        calls.push(query)
        if (query.limit) throw new Error("unsupported")
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(false)
    expect(calls).toEqual([
      { directory: "dir", roots: true, limit: 25 },
      { directory: "dir", roots: true },
    ])
  })

  test("does not turn cancellation into an unlimited fallback request", async () => {
    const controller = new AbortController()
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []
    let started = () => {}
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const promise = loadRootSessionsWithFallback({
      directory: "dir",
      limit: 25,
      signal: controller.signal,
      list: (query) => {
        calls.push(query)
        started()
        return new Promise((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
        })
      },
    })

    await ready
    controller.abort(new DOMException("Cancelled", "AbortError"))

    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toEqual([{ directory: "dir", roots: true, limit: 25 }])
  })
})

describe("waitForSharedSessionLoad", () => {
  test("keeps shared HTTP work alive until every signal consumer leaves", async () => {
    const controller = new AbortController()
    const first = new AbortController()
    const second = new AbortController()
    let finish = () => {}
    const promise = new Promise<void>((resolve) => {
      finish = resolve
    })
    const load = { promise, controller, consumers: new Set<symbol>() }
    const firstWait = waitForSharedSessionLoad(load, first.signal)
    const secondWait = waitForSharedSessionLoad(load, second.signal)

    first.abort(new DOMException("First left", "AbortError"))

    await expect(firstWait).rejects.toMatchObject({ name: "AbortError" })
    expect(controller.signal.aborted).toBe(false)

    finish()
    await secondWait
  })

  test("aborts shared HTTP work when its last signal consumer leaves", async () => {
    const controller = new AbortController()
    const consumer = new AbortController()
    const load = { promise: new Promise<void>(() => {}), controller, consumers: new Set<symbol>() }
    const wait = waitForSharedSessionLoad(load, consumer.signal)

    consumer.abort(new DOMException("Gone", "AbortError"))

    await expect(wait).rejects.toMatchObject({ name: "AbortError" })
    expect(controller.signal.aborted).toBe(true)
  })
})

describe("withBootstrapSessions", () => {
  test("upgrades a refresh with one session load without repeating bootstrap work", async () => {
    const events: string[] = []
    let finishBootstrap = () => {}
    let finishSessions = () => {}
    const run = {
      sessions: false,
      promise: new Promise<void>((resolve) => {
        finishBootstrap = () => {
          events.push("bootstrap")
          resolve()
        }
      }),
    }
    const loadSessions = () =>
      new Promise<void>((resolve) => {
        events.push("sessions")
        finishSessions = resolve
      })

    const first = withBootstrapSessions(run, loadSessions)
    const second = withBootstrapSessions(run, loadSessions)
    expect(second).toBe(first)
    await Promise.resolve()
    expect(events).toEqual(["sessions"])

    finishBootstrap()
    await Promise.resolve()
    expect(events).toEqual(["sessions", "bootstrap"])

    finishSessions()
    await first

    expect(events).toEqual(["sessions", "bootstrap"])
  })
})

describe("createSerialDirectoryLoader", () => {
  test("deduplicates directory aliases and keeps at most one passive load active", async () => {
    const calls: string[] = []
    let active = 0
    let maximumActive = 0
    let startFirst = () => {}
    let releaseFirst = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      startFirst = resolve
    })
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const loader = createSerialDirectoryLoader({
      async load(directory) {
        calls.push(directory)
        active += 1
        maximumActive = Math.max(maximumActive, active)
        if (calls.length === 1) {
          startFirst()
          await firstGate
        }
        active -= 1
      },
    })

    const first = loader.enqueue(["C:\\Repo-A\\Project", "D:/workspace"])
    await firstStarted
    const duplicate = loader.enqueue(["c:/repo-a/project/", "D:/workspace"])
    expect(calls).toEqual(["C:\\Repo-A\\Project"])
    releaseFirst()
    await Promise.all([first, duplicate])

    expect(calls).toEqual(["C:\\Repo-A\\Project", "D:/workspace"])
    expect(maximumActive).toBe(1)
  })

  test("allows a failed directory snapshot to be loaded again", async () => {
    const calls: string[] = []
    const warning = spyOn(console, "warn").mockImplementation(() => undefined)
    const loader = createSerialDirectoryLoader({
      async load(directory) {
        calls.push(directory)
        if (calls.length === 1) throw new Error("temporary snapshot failure")
      },
    })

    try {
      await loader.enqueue(["C:\\Repo-A\\Project"])
      await loader.enqueue(["c:/repo-a/project/"])
      await loader.enqueue(["C:/repo-a/project"])
      expect(calls).toEqual(["C:\\Repo-A\\Project", "C:\\Repo-A\\Project"])
    } finally {
      warning.mockRestore()
    }
  })

  test("keeps an incomplete snapshot retryable after eligibility pauses and resumes", async () => {
    const calls: string[] = []
    let startFirst = () => {}
    let releaseFirst = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      startFirst = resolve
    })
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const loader = createSerialDirectoryLoader({
      async load(directory, { canContinue }) {
        calls.push(directory)
        if (calls.length === 1) {
          startFirst()
          await firstGate
          return canContinue()
        }
      },
    })

    const first = loader.enqueue(["C:\\Repo-A\\Project", "D:/workspace"])
    await firstStarted
    const paused = loader.enqueue(["C:\\Repo-A\\Project", "D:/workspace"], () => false)
    releaseFirst()
    await Promise.all([first, paused])

    expect(calls).toEqual(["C:\\Repo-A\\Project"])

    await loader.enqueue(["C:\\Repo-A\\Project", "D:/workspace"], () => true)
    expect(calls).toEqual(["C:\\Repo-A\\Project", "D:/workspace", "C:\\Repo-A\\Project"])
  })

  test("retries an in-flight snapshot when eligibility pauses before the next directory", async () => {
    const calls: string[] = []
    let startFirst = () => {}
    let releaseFirst = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      startFirst = resolve
    })
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const loader = createSerialDirectoryLoader({
      async load(directory) {
        calls.push(directory)
        if (calls.length === 1) {
          startFirst()
          await firstGate
        }
      },
    })

    const first = loader.enqueue(["C:\\Repo-A\\Project", "D:/workspace"])
    await firstStarted
    const paused = loader.enqueue(["C:\\Repo-A\\Project", "D:/workspace"], () => false)
    releaseFirst()
    await Promise.all([first, paused])

    await loader.enqueue(["C:\\Repo-A\\Project", "D:/workspace"], () => true)
    expect(calls).toEqual(["C:\\Repo-A\\Project", "D:/workspace", "C:\\Repo-A\\Project"])
  })

  test("retries an invalidated load when the directory is re-enqueued before it settles", async () => {
    const calls: string[] = []
    let startFirst = () => {}
    let releaseFirst = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      startFirst = resolve
    })
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const loader = createSerialDirectoryLoader({
      async load(directory) {
        calls.push(directory)
        if (calls.length === 1) {
          startFirst()
          await firstGate
        }
      },
    })

    const first = loader.enqueue(["C:\\Repo-A\\Project"])
    await firstStarted
    loader.forget("c:/repo-a/project/")
    const readded = loader.enqueue(["c:/repo-a/project/"])
    releaseFirst()
    await Promise.all([first, readded])

    expect(calls).toEqual(["C:\\Repo-A\\Project", "c:/repo-a/project/"])
  })

  test("aborts a paused request, waits for settlement, and allows a later retry", async () => {
    const calls: string[] = []
    const settled: string[] = []
    let startFirst = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      startFirst = resolve
    })
    const loader = createSerialDirectoryLoader({
      load(directory, { signal }) {
        calls.push(directory)
        if (calls.length > 1) return Promise.resolve()
        startFirst()
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              settled.push(directory)
              reject(signal.reason)
            },
            { once: true },
          )
        })
      },
    })

    const first = loader.enqueue(["C:/Repo-A/Project"])
    await firstStarted
    await loader.enqueue([], () => false)
    await first

    expect(settled).toEqual(["C:/Repo-A/Project"])
    await loader.enqueue(["C:/Repo-A/Project"], () => true)
    expect(calls).toEqual(["C:/Repo-A/Project", "C:/Repo-A/Project"])
  })

  test("settles a disposed request before starting the next directory", async () => {
    const calls: string[] = []
    const settled: string[] = []
    let active = 0
    let maximumActive = 0
    let startFirst = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      startFirst = resolve
    })
    const loader = createSerialDirectoryLoader({
      load(directory, { signal }) {
        calls.push(directory)
        active += 1
        maximumActive = Math.max(maximumActive, active)
        if (directory !== "first") {
          active -= 1
          return Promise.resolve()
        }
        startFirst()
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              settled.push(directory)
              active -= 1
              reject(signal.reason)
            },
            { once: true },
          )
        })
      },
    })

    const loading = loader.enqueue(["first", "second"])
    await firstStarted
    loader.forget("first")
    await loading

    expect(calls).toEqual(["first", "second"])
    expect(settled).toEqual(["first"])
    expect(maximumActive).toBe(1)
  })

  test("deadline abort waits for request settlement and leaves a failed directory retryable", async () => {
    const calls: string[] = []
    const settled: string[] = []
    let active = 0
    let maximumActive = 0
    let failFirst = true
    const loader = createSerialDirectoryLoader({
      async load(directory, { signal }) {
        calls.push(directory)
        active += 1
        maximumActive = Math.max(maximumActive, active)
        if (directory === "stuck" && failFirst) {
          try {
            await withAbortableDeadline({
              signal,
              timeoutMs: 5,
              run: (requestSignal) =>
                new Promise<void>((_resolve, reject) => {
                  requestSignal.addEventListener(
                    "abort",
                    () => {
                      settled.push(directory)
                      reject(requestSignal.reason)
                    },
                    { once: true },
                  )
                }),
            })
          } catch {
            failFirst = false
            active -= 1
            return false
          }
        }
        active -= 1
      },
    })

    await loader.enqueue(["stuck", "next"])

    expect(PASSIVE_SIDEBAR_REQUEST_TIMEOUT_MS).toBe(10_000)
    expect(settled).toEqual(["stuck"])
    expect(calls).toEqual(["stuck", "next"])
    expect(maximumActive).toBe(1)
    await loader.enqueue(["stuck", "next"])
    expect(calls).toEqual(["stuck", "next", "stuck"])
  })
})

describe("directoryStoreForEvent", () => {
  test("drops renderer-heavy deltas for many inactive long sessions without creating stores", () => {
    const inactive = Array.from({ length: 48 }, (_, index) => `ses_inactive_${index}`)
    const created: string[] = []
    let applied = 0

    for (const sessionID of inactive) {
      for (let turn = 0; turn < 161; turn += 1) {
        const store = directoryStoreForEvent({
          existing: undefined,
          type: turn % 2 === 0 ? "message.part.delta" : "session.next.text.delta",
          createLightweight: () => {
            created.push(sessionID)
            return { sessionID }
          },
        })
        if (store) applied += 1
      }
    }

    expect(applied).toBe(0)
    expect(created).toEqual([])
  })

  test("still creates a lightweight store for inactive session lifecycle state", () => {
    let created = 0
    const store = directoryStoreForEvent({
      existing: undefined,
      type: "session.status.2",
      createLightweight: () => {
        created += 1
        return { status: "busy" }
      },
    })

    expect(store).toEqual({ status: "busy" })
    expect(created).toBe(1)
  })
})

describe("server status queries", () => {
  test("forwards abort signals to passive session status and info reads", async () => {
    const controller = new AbortController()
    const seen: Array<AbortSignal | undefined> = []
    const sdk = {
      session: {
        status: async (_parameters?: unknown, options?: { signal?: AbortSignal }) => {
          seen.push(options?.signal)
          return { data: {} }
        },
        get: async (_parameters?: unknown, options?: { signal?: AbortSignal }) => {
          seen.push(options?.signal)
          return { data: undefined }
        },
      },
    } as unknown as OpencodeClient

    await Promise.all([
      loadPassiveSessionStatus(sdk, "C:/repo", controller.signal),
      loadPassiveSessionInfo(sdk, "ses_1", controller.signal),
    ])

    expect(seen).toEqual([controller.signal, controller.signal])
  })

  test("deadline abort waits for the signal-aware request to settle", async () => {
    const controller = new AbortController()
    let requestSettled = false
    const request = withAbortableDeadline({
      signal: controller.signal,
      timeoutMs: 5,
      run: (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              requestSettled = true
              reject(signal.reason)
            },
            { once: true },
          )
        }),
    })

    await expect(request).rejects.toMatchObject({ name: "TimeoutError" })
    expect(requestSettled).toBe(true)
  })

  test("normalizes MCP and LSP Windows directory aliases", () => {
    const sdk = {} as OpencodeClient

    expect(loadMcpQuery(ServerScope.local, "C:\\GitRepros\\PU", sdk).queryKey.map(String)).toEqual([
      ServerScope.local,
      "c:/gitrepros/pu",
      "mcp",
    ])
    expect(loadLspQuery(ServerScope.local, "C:/GitRepros/PU/", sdk).queryKey.map(String)).toEqual([
      ServerScope.local,
      "c:/gitrepros/pu",
      "lsp",
    ])
  })

  test("keeps original Windows SDK paths while normalizing project query aliases", () => {
    const directories: string[] = []
    const sdk = {} as OpencodeClient
    const api = makeQueryOptionsApi(
      ServerScope.local,
      () => sdk,
      (directory) => {
        directories.push(directory)
        return sdk
      },
    )

    expect(api.providers(pathKey("C:\\GitRepros\\PU"), "C:\\GitRepros\\PU").queryKey.map(String)).toEqual([
      ServerScope.local,
      "c:/gitrepros/pu",
      "providers",
    ])
    expect(api.agents(pathKey("C:\\GitRepros\\PU"), "C:\\GitRepros\\PU").queryKey.map(String)).toEqual([
      ServerScope.local,
      "c:/gitrepros/pu",
      "agents",
    ])
    expect(directories).toEqual(["C:\\GitRepros\\PU", "C:\\GitRepros\\PU"])
  })

  test("normalizes Windows session loading aliases", () => {
    const sdk = {} as OpencodeClient
    const api = makeQueryOptionsApi(
      ServerScope.local,
      () => sdk,
      () => sdk,
    )

    expect(api.sessions(pathKey("C:\\GitRepros\\PU")).queryKey.map(String)).toEqual([
      ServerScope.local,
      "c:/gitrepros/pu",
      "loadSessions",
    ])
    expect(api.sessions(pathKey("c:/gitrepros/pu/")).queryKey.map(String)).toEqual([
      ServerScope.local,
      "c:/gitrepros/pu",
      "loadSessions",
    ])
  })

  test("forwards TanStack cancellation signals to MCP and LSP HTTP requests", async () => {
    const seen: Array<AbortSignal | undefined> = []
    const sdk = {
      mcp: {
        status: async (_parameters?: unknown, options?: { signal?: AbortSignal }) => {
          seen.push(options?.signal)
          return { data: {} }
        },
      },
      lsp: {
        status: async (_parameters?: unknown, options?: { signal?: AbortSignal }) => {
          seen.push(options?.signal)
          return { data: [] }
        },
      },
    } as unknown as OpencodeClient
    const queries = [loadMcpQuery(ServerScope.local, "/project", sdk), loadLspQuery(ServerScope.local, "/project", sdk)]
    const signals = queries.map(() => new AbortController().signal)

    await Promise.all(
      queries.map((query, index) => {
        const queryFn = query.queryFn as (context: { signal: AbortSignal }) => Promise<unknown>
        return queryFn({ signal: signals[index] })
      }),
    )

    expect(seen).toEqual(signals)
  })
})

describe("session tab events", () => {
  test("materializes lifecycle, completion, question, and permission state for inactive tabs", () => {
    expect(isSessionTabEvent("session.next.activity.completed")).toBeTrue()
    expect(isSessionTabEvent("session.next.activity.interrupted.1")).toBeTrue()
    expect(isSessionTabEvent("session.turn.completed")).toBeTrue()
    expect(isSessionTabEvent("session.turn.completed.12")).toBeTrue()
    expect(isSessionTabEvent("session.deleted")).toBeTrue()
    expect(isSessionTabEvent("session.next.title.updated.1")).toBeTrue()
    expect(isSessionTabEvent("surface.asked")).toBeTrue()
    expect(isSessionTabEvent("surface.dismissed.2")).toBeTrue()
    expect(isSessionTabEvent("permission.v2.asked")).toBeTrue()
    expect(isSessionTabEvent("permission.v2.replied.3")).toBeTrue()
  })

  test("does not materialize inactive directory stores for message traffic", () => {
    expect(isSessionTabEvent("message.updated")).toBeFalse()
    expect(isSessionTabEvent("message.updated.1")).toBeFalse()
    expect(isSessionTabEvent("message.part.delta")).toBeFalse()
  })

  test("recovers only sessions with a non-idle status or stale running tool", () => {
    expect(
      sessionsNeedingStatusRecovery({
        session_status: {
          busy: { type: "busy" },
          idle: { type: "idle" },
          stale: { type: "idle" },
        },
        message: {
          stale: [{ id: "msg_stale" }],
          idle: [{ id: "msg_idle" }],
        },
        part: {
          msg_stale: [{ type: "tool", state: { status: "running" } }],
          msg_idle: [{ type: "text", text: "done" }],
        },
      } as never),
    ).toEqual(["busy"])
  })

  test("projects durable completion and question events into inactive tab stores", () => {
    const event = (type: string, data: Record<string, unknown>) =>
      ({
        type: "sync",
        syncEvent: {
          id: `evt_${type}`,
          type,
          seq: 1,
          aggregateID: "ses_1",
          data: { sessionID: "ses_1", ...data },
        },
      }) as never

    expect(sessionTabSyncEvent(event("session.turn.completed.1", { status: "done" }))).toEqual({
      type: "session.turn.completed",
      properties: { sessionID: "ses_1", status: "done" },
    })
    expect(sessionTabSyncEvent(event("surface.asked.2", { id: "que_1", questions: [] }))).toEqual({
      type: "surface.asked",
      properties: { sessionID: "ses_1", id: "que_1", questions: [] },
    })
    expect(sessionTabSyncEvent(event("message.updated.1", {}))).toBeUndefined()
  })

  test("includes activity-only sessions when a cold store has no status or messages", () => {
    const directory = "C:/OpenCode/cold-recovery"
    startSessionActivity(directory, "ses_activity_only", "activity_1")

    expect(
      sessionIDsForStatusRecovery(directory, {
        session_status: {},
        message: {},
        part: {},
      }),
    ).toEqual(["ses_activity_only"])
    finishSessionActivity(directory, "ses_activity_only", "activity_1")
  })

  test("polls non-idle and activity-only sessions every three seconds", () => {
    const directory = "C:/OpenCode/status-poll"
    const idle = { session_status: { ses_idle: { type: "idle" as const } }, message: {}, part: {} }

    expect(SESSION_STATUS_POLL_INTERVAL_MS).toBe(3_000)
    expect(SESSION_STATUS_RECONCILIATION_INTERVAL_MS).toBe(15_000)
    expect(shouldPollSessionStatus(directory, idle)).toBeFalse()
    expect(
      shouldPollSessionStatus(directory, {
        ...idle,
        session_status: { ses_busy: { type: "busy" } },
      }),
    ).toBeTrue()

    startSessionActivity(directory, "ses_activity_only", "activity_1")
    expect(shouldPollSessionStatus(directory, idle)).toBeTrue()
    finishSessionActivity(directory, "ses_activity_only", "activity_1")
  })

  test("gates hidden recovery on completed foreground messages, then resumes while work is still active", () => {
    const root = "C:/OpenCode/status-scope-root"
    const visible = "C:/OpenCode/status-scope-visible"
    const collapsed = "C:/OpenCode/status-scope-collapsed"
    const pendingMessagesReady = activeSessionReadyForBackgroundPrefetch({ message: true })
    const cold = sessionStatusReconciliationScope({
      activeDirectory: root,
      visibleDirectories: [visible],
      activeSessionMessagesReady: pendingMessagesReady,
      pageVisible: true,
      hasSessions: true,
    })
    expect(cold.foregroundReady).toBeFalse()
    expect(cold.directories).toEqual(new Set([directoryKey(root)]))

    const completedMessagesReady = activeSessionReadyForBackgroundPrefetch({
      message: true,
      info: { limit: 80, complete: true, at: 1 },
    })
    const ready = sessionStatusReconciliationScope({
      activeDirectory: root,
      visibleDirectories: [visible],
      activeSessionMessagesReady: completedMessagesReady,
      pageVisible: true,
      hasSessions: true,
    })
    expect(ready.foregroundReady).toBeTrue()
    expect(ready.directories).toEqual(new Set([directoryKey(root), directoryKey(visible)]))
    expect(ready.directories.has(directoryKey(collapsed))).toBeFalse()

    const hiddenRunning = {
      session_status: { ses_busy: { type: "busy" as const } },
      message: {},
      part: {},
    }
    expect(
      shouldRefreshDirectoryStatus({
        directory: root,
        store: hiddenRunning,
        activeOnly: true,
        scope: cold,
      }),
    ).toBeTrue()
    expect(
      shouldRefreshDirectoryStatus({
        directory: collapsed,
        store: hiddenRunning,
        activeOnly: true,
        scope: cold,
      }),
    ).toBeFalse()
    expect(
      shouldRefreshDirectoryStatus({
        directory: collapsed,
        store: hiddenRunning,
        activeOnly: true,
        scope: ready,
      }),
    ).toBeTrue()
    expect(
      shouldRefreshDirectoryStatus({
        directory: collapsed,
        store: hiddenRunning,
        activeOnly: false,
        scope: ready,
      }),
    ).toBeFalse()
  })

  test("accepts response-only sessions with historical activity but rejects in-flight lifecycle changes", () => {
    const directory = "C:/OpenCode/status-generation"
    const sessionID = "ses_restarted"
    startSessionActivity(directory, sessionID, "activity_old")
    finishSessionActivity(directory, sessionID, "activity_old")
    const generations = sessionActivityGenerationSnapshot(directory)

    expect(shouldApplySessionStatusResponse(directory, sessionID, generations)).toBeTrue()
    startSessionActivity(directory, sessionID, "activity_new")
    expect(shouldApplySessionStatusResponse(directory, sessionID, generations)).toBeFalse()
    finishSessionActivity(directory, sessionID, "activity_new")
  })

  test("a busy snapshot after a missed start restores the navigation spinner", () => {
    const directory = "C:/OpenCode/status-external-restart"
    const sessionID = "ses_restarted"
    startSessionActivity(directory, sessionID, "activity_old")
    finishSessionActivity(directory, sessionID, "activity_old")
    const store = { session_status: { [sessionID]: { type: "idle" } }, message: {}, part: {} } as never
    const status = reconcileSessionStatusSnapshot({
      directory,
      sessionID,
      generations: sessionActivityGenerationSnapshot(directory),
      incoming: { type: "busy" },
      store,
    })
    const lifecycle = resolveLifecycleStatus({
      activity: sessionActivity(directory, sessionID)?.type,
      activitySettled: sessionActivitySettled(directory, sessionID),
      store: status?.type,
      latestAssistantSettled: false,
    })
    expect(status?.type).toBe("busy")
    expect(sessionIsWorking(store, sessionID, lifecycle, sessionActivitySettled(directory, sessionID))).toBeTrue()
  })

  test("recovers a missed terminal lifecycle only after the latest assistant turn settled", () => {
    expect(
      statusSnapshotRecoversMissedTerminal(
        undefined,
        {
          message: { ses_done: [{ id: "msg_done", role: "assistant", finish: "stop" }] },
          part: { msg_done: [{ type: "text" }] },
        } as never,
        "ses_done",
      ),
    ).toBeTrue()
    expect(
      statusSnapshotRecoversMissedTerminal(
        undefined,
        {
          message: { ses_running: [{ id: "msg_running", role: "assistant", finish: "tool-calls" }] },
          part: { msg_running: [{ type: "tool", state: { status: "running" } }] },
        } as never,
        "ses_running",
      ),
    ).toBeFalse()
    expect(
      statusSnapshotRecoversMissedTerminal(
        { type: "busy" },
        {
          message: { ses_done: [{ id: "msg_done", role: "assistant", finish: "stop" }] },
          part: { msg_done: [{ type: "text" }] },
        } as never,
        "ses_done",
      ),
    ).toBeFalse()
  })

  test("keeps a fresh activity busy when an idle or absent status snapshot arrives before the new assistant message", () => {
    const directory = "C:/OpenCode/status-fresh-activity"
    const startedAt = Date.now()
    const results = [undefined, { type: "idle" } as const].map((incoming) => {
      const sessionID = `ses_fresh_${incoming?.type ?? "absent"}`
      startSessionActivity(directory, sessionID, "activity_fresh", { timestamp: startedAt })
      const generations = sessionActivityGenerationSnapshot(directory)
      const store = {
        session_status: { [sessionID]: { type: "busy" } },
        message: {
          [sessionID]: [
            {
              id: "msg_previous",
              role: "assistant",
              finish: "stop",
              time: { created: startedAt - 10_000, completed: startedAt - 5_000 },
            },
          ],
        },
        part: { msg_previous: [{ type: "text" }] },
      } as never
      try {
        const status = reconcileSessionStatusSnapshot({ directory, sessionID, generations, incoming, store })
        const settled = sessionActivitySettled(directory, sessionID)
        const lifecycle = resolveLifecycleStatus({
          activity: sessionActivity(directory, sessionID)?.type,
          activityTracked: latestAssistantCompletedBefore(store, sessionID, sessionActivityStartedAt(directory, sessionID)),
          activitySettled: settled,
          store: status?.type,
          latestAssistantSettled: latestAssistantSettled(store, sessionID),
        })
        return {
          working: sessionIsWorking(store, sessionID, lifecycle, settled),
          activity: sessionActivity(directory, sessionID)?.type,
        }
      } finally {
        finishSessionActivity(directory, sessionID, "activity_fresh")
      }
    })
    expect(results).toEqual([
      { working: true, activity: "busy" },
      { working: true, activity: "busy" },
    ])
  })

  test("finishes stale activity and hydrates idle from an empty status response after finish stop", () => {
    const directory = "C:/OpenCode/status-missed-terminal"
    const sessionID = "ses_done"
    startSessionActivity(directory, sessionID, "activity_done")
    const generations = sessionActivityGenerationSnapshot(directory)

    const status = reconcileSessionStatusSnapshot({
      directory,
      sessionID,
      generations,
      incoming: undefined,
      store: {
        session_status: { [sessionID]: { type: "busy" } },
        message: { [sessionID]: [{ id: "msg_done", role: "assistant", finish: "stop" }] },
        part: { msg_done: [{ type: "text" }] },
      } as never,
    })

    expect(status).toEqual({ type: "idle" })
    expect(sessionActivity(directory, sessionID)).toBeUndefined()
  })

  test("keeps activity busy when an empty status response races a running tool call", () => {
    const directory = "C:/OpenCode/status-running-tool"
    const sessionID = "ses_running"
    startSessionActivity(directory, sessionID, "activity_running")
    const generations = sessionActivityGenerationSnapshot(directory)

    const status = reconcileSessionStatusSnapshot({
      directory,
      sessionID,
      generations,
      incoming: undefined,
      store: {
        session_status: { [sessionID]: { type: "busy" } },
        message: { [sessionID]: [{ id: "msg_running", role: "assistant", finish: "tool-calls" }] },
        part: { msg_running: [{ type: "tool", state: { status: "running" } }] },
      } as never,
    })

    expect(status).toEqual({ type: "busy" })
    expect(sessionActivity(directory, sessionID)?.type).toBe("busy")
    finishSessionActivity(directory, sessionID, "activity_running")
  })

  test("does not revive a closed activity from a busy response started before completion", () => {
    const directory = "C:/OpenCode/status-terminal-race"
    const sessionID = "ses_finished"
    startSessionActivity(directory, sessionID, "activity_finished")
    const generations = sessionActivityGenerationSnapshot(directory)
    finishSessionActivity(directory, sessionID, "activity_finished")
    expect(reconcileSessionStatusSnapshot({
      directory,
      sessionID,
      generations,
      incoming: { type: "busy" },
      store: { session_status: { [sessionID]: { type: "idle" } }, message: {}, part: {} } as never,
    })).toBeUndefined()
    expect(sessionActivitySettled(directory, sessionID)).toBeTrue()
  })

  test("does not apply an idle response after a newer activity changes the generation", () => {
    const directory = "C:/OpenCode/status-new-generation"
    const sessionID = "ses_restarted"
    startSessionActivity(directory, sessionID, "activity_old")
    const generations = sessionActivityGenerationSnapshot(directory)
    startSessionActivity(directory, sessionID, "activity_new")

    const status = reconcileSessionStatusSnapshot({
      directory,
      sessionID,
      generations,
      incoming: undefined,
      store: {
        session_status: { [sessionID]: { type: "busy" } },
        message: { [sessionID]: [{ id: "msg_old", role: "assistant", finish: "stop" }] },
        part: { msg_old: [{ type: "text" }] },
      } as never,
    })

    expect(status).toBeUndefined()
    expect(sessionActivity(directory, sessionID)?.type).toBe("busy")
    finishSessionActivity(directory, sessionID, "activity_new")
  })
})

describe("estimateRootSessionTotal", () => {
  test("keeps exact total for full fetches", () => {
    expect(estimateRootSessionTotal({ count: 42, limit: 10, limited: false })).toBe(42)
  })

  test("marks has-more for full-limit limited fetches", () => {
    expect(estimateRootSessionTotal({ count: 10, limit: 10, limited: true })).toBe(11)
  })

  test("keeps exact total when limited fetch is under limit", () => {
    expect(estimateRootSessionTotal({ count: 9, limit: 10, limited: true })).toBe(9)
  })
})

describe("canDisposeDirectory", () => {
  test("rejects pinned or inflight directories", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: true,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: true,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: true,
      }),
    ).toBe(false)
  })

  test("accepts idle unpinned directory store", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(true)
  })
})

describe("sessionDirectoryInStores", () => {
  const store = (session: string[], status: Record<string, unknown> = {}) =>
    ({ session: session.map((id) => ({ id })), session_status: status }) as never

  test("finds the owning directory through the sorted session list", () => {
    const directory = sessionDirectoryInStores({
      directories: [
        ["C:/OpenCode/other", store(["ses_other"])],
        ["C:/ProjektA", store(["ses_a", "ses_b"])],
      ],
      sessionID: "ses_b",
    })
    expect(directory).toBe("C:/ProjektA")
  })

  test("finds lightweight directories that only track session status", () => {
    const directory = sessionDirectoryInStores({
      directories: [
        ["C:/ProjektA", store(["ses_a"])],
        ["C:/ProjektB", store([], { ses_b: { type: "busy" } })],
      ],
      sessionID: "ses_b",
    })
    expect(directory).toBe("C:/ProjektB")
  })

  test("skips the pseudo global scope entry and unknown sessions", () => {
    expect(
      sessionDirectoryInStores({
        directories: [["global", store([], { ses_1: { type: "busy" } })]],
        sessionID: "ses_1",
      }),
    ).toBeUndefined()
    expect(
      sessionDirectoryInStores({
        directories: [["C:/ProjektA", store(["ses_a"])]],
        sessionID: "ses_unknown",
      }),
    ).toBeUndefined()
  })

  test("returns the first matching directory in insertion order", () => {
    const directory = sessionDirectoryInStores({
      directories: [
        ["C:/First", store(["ses_dup"])],
        ["C:/Second", store(["ses_dup"])],
      ],
      sessionID: "ses_dup",
    })
    expect(directory).toBe("C:/First")
  })
})

describe("recoverMissingSessionInfo", () => {
  const notFound = (sessionID: string) =>
    new Error(`Request failed with status 404: Session not found: ${sessionID}`, {
      cause: { status: 404, body: { name: "NotFoundError", data: { message: `Session not found: ${sessionID}` } } },
    })

  test("forgets the stale session record and settles the load", () => {
    let forgotten = 0
    const result = recoverMissingSessionInfo(notFound("ses_gone"), () => {
      forgotten += 1
    })
    expect(result).toBeUndefined()
    expect(forgotten).toBe(1)
  })

  test("rethrows errors that are not missing-session 404s", () => {
    const serverError = new Error("Request failed with status 500", { cause: { status: 500 } })
    let forgotten = 0
    expect(() =>
      recoverMissingSessionInfo(serverError, () => {
        forgotten += 1
      }),
    ).toThrow("Request failed with status 500")
    expect(forgotten).toBe(0)
  })
})

