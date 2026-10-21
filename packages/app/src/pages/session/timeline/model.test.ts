import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import { nextSessionMessageReadLimit } from "@/context/directory-sync"
import {
  SESSION_MESSAGE_PAGE_LOOKBEHIND,
  SESSION_MESSAGE_REOPEN_LIMIT,
  SESSION_MESSAGE_WINDOW_LIMIT,
} from "@/context/global-sync/session-message-window"
import {
  SESSION_MESSAGE_REQUEST_RETRIES,
  SESSION_MESSAGE_REQUEST_TIMEOUT_MS,
  isSessionMessageRequestTimeoutError,
  withSessionMessageRequestTimeout,
} from "@/context/session-message-request"
import { ServerConnection } from "@/context/server"
import { ServerScope } from "@/utils/server-scope"
import {
  TIMELINE_AUTO_RESUME_DELAY_MS,
  TIMELINE_AUTO_RESUME_MAX_DELAY_MS,
  createTimelineAutoResume,
  handleMissingTimelineSession,
  isRecoverableTimelineLoadError,
  isSessionPrefetchStale,
  loadOlderTimeline,
  selectUserMessages,
  selectVisibleUserMessages,
  selectWindowedUserMessages,
  shouldAutoFillHistory,
  shouldAutoResumeTimelineLoad,
  shouldCatchUpBusySessionTimeline,
  shouldReleaseTimeline,
  shouldResetTimelineMessagesOnOpen,
  timelineAutoResumeProbe,
  timelineReconnectRecoveryForSession,
} from "./model"

const user = (id: string, created = Number(id.slice(4))) => ({ id, role: "user", time: { created } }) as UserMessage
const assistant = (id: string, created = Number(id.slice(4))) => ({ id, role: "assistant", time: { created } }) as AssistantMessage

describe("timeline model", () => {
  test("renders a resumed morning review chronologically without mutating its ID-sorted store", () => {
    const root = user("msg_80daf1f1f62f000994c26e3603", 1788418804026)
    const resumed = user("msg_06d8e45f2001F5K1Hrks6Vfk9F", 1788544435744)
    const messages = [resumed, root]

    expect(selectUserMessages(messages).map((message) => message.id)).toEqual([root.id, resumed.id])
    expect(messages).toEqual([resumed, root])
  })

  test("resets an oversized cached timeline only when reopening it", () => {
    expect(shouldResetTimelineMessagesOnOpen(200, false)).toBe(false)
    expect(shouldResetTimelineMessagesOnOpen(201, false)).toBe(true)
    expect(shouldResetTimelineMessagesOnOpen(673, false)).toBe(true)
    expect(shouldResetTimelineMessagesOnOpen(673, true)).toBe(false)
  })

  test("reconciles the active busy timeline even when no events arrive", () => {
    expect(
      shouldCatchUpBusySessionTimeline({
        active: true,
        sessionID: "ses_target",
        statusType: "busy",
        activityType: undefined,
      }),
    ).toBe(true)
    expect(
      shouldCatchUpBusySessionTimeline({
        active: true,
        sessionID: "ses_target",
        statusType: "idle",
        activityType: "busy",
      }),
    ).toBe(true)
    expect(
      shouldCatchUpBusySessionTimeline({
        active: false,
        sessionID: "ses_target",
        statusType: "busy",
        activityType: "busy",
      }),
    ).toBe(false)
    expect(
      shouldCatchUpBusySessionTimeline({
        active: true,
        sessionID: undefined,
        statusType: "busy",
        activityType: "busy",
      }),
    ).toBe(false)
    expect(
      shouldCatchUpBusySessionTimeline({
        active: true,
        sessionID: "ses_target",
        statusType: undefined,
        activityType: undefined,
      }),
    ).toBe(false)
  })

  test("defers reconnect recovery for an inactive timeline and performs it once on activation", () => {
    const input = { directory: "C:/repo", scope: ServerScope.local, sessionID: "ses_reconnect" }
    const initial = timelineReconnectRecoveryForSession({ ...input, active: true, generation: 0 })
    expect(initial).toEqual({ load: true, recover: false, seen: 0 })

    const hidden = timelineReconnectRecoveryForSession({ ...input, active: false, generation: 2 })
    expect(hidden).toEqual({ load: false, recover: false, seen: 0 })

    const activated = timelineReconnectRecoveryForSession({ ...input, active: true, generation: 2 })
    expect(activated).toEqual({ load: true, recover: true, seen: 2 })
    expect(timelineReconnectRecoveryForSession({ ...input, active: true, generation: 2 })).toEqual({
      load: true,
      recover: false,
      seen: 2,
    })

    expect(
      timelineReconnectRecoveryForSession({ ...input, sessionID: "ses_never_opened", active: true, generation: 2 }),
    ).toEqual({ load: true, recover: false, seen: 2 })

    expect(timelineReconnectRecoveryForSession({ ...input, active: true, generation: 0 })).toEqual({
      load: true,
      recover: true,
      seen: 0,
    })
  })

  test("keeps same-directory tab timelines alive and releases cross-directory ownership", () => {
    const server = ServerConnection.Key.make("https://server-a.test")
    const previous = { server, directory: "C:/repo" }
    expect(shouldReleaseTimeline(previous, { server, directory: "C:/repo" })).toBe(false)
    expect(shouldReleaseTimeline(previous, { server, directory: "C:/other" })).toBe(true)
    expect(
      shouldReleaseTimeline(previous, {
        server: ServerConnection.Key.make("https://server-b.test"),
        directory: "C:/repo",
      }),
    ).toBe(true)
    expect(shouldReleaseTimeline(previous, undefined)).toBe(true)
  })

  test("does not run a queued stale refresh after another owner refreshed the timeline", () => {
    expect(isSessionPrefetchStale(undefined, 20_000)).toBe(true)
    expect(isSessionPrefetchStale({ at: 1_000 }, 20_000)).toBe(true)
    expect(isSessionPrefetchStale({ at: 19_000 }, 20_000)).toBe(false)
  })

  test("reports authoritative missing sessions with their owning server", () => {
    const server = ServerConnection.Key.make("https://server-a.test")
    const error = Object.assign(new Error("missing"), { cause: { status: 404 } })
    const details: unknown[] = []
    let evicted = 0

    handleMissingTimelineSession({
      server,
      directory: "/tmp/project",
      sessionID: "ses_same",
      error,
      evict: () => evicted++,
      onSessionNotFound: (detail) => details.push(detail),
    })

    expect(evicted).toBe(1)
    expect(details).toEqual([{ server, directory: "/tmp/project", sessionID: "ses_same", error }])

    const failure = Object.assign(new Error("failed"), { cause: { status: 500 } })
    expect(() =>
      handleMissingTimelineSession({
        server,
        directory: "/tmp/project",
        sessionID: "ses_same",
        error: failure,
        evict: () => evicted++,
      }),
    ).toThrow(failure)
    expect(evicted).toBe(1)
  })

  test("selects users and applies the revert boundary", () => {
    const messages: Message[] = [user("msg_1"), assistant("msg_2"), user("msg_3"), user("msg_5")]
    const users = selectUserMessages(messages)

    expect(users.map((message) => message.id)).toEqual(["msg_1", "msg_3", "msg_5"])
    expect(selectVisibleUserMessages(users, "msg_5").map((message) => message.id)).toEqual(["msg_1", "msg_3"])
    expect(selectVisibleUserMessages(users)).toBe(users)
  })

  test("windows user messages around a target or the latest turns", () => {
    const messages = Array.from({ length: 10 }, (_, index) => user(`msg_${index}`))

    expect(selectWindowedUserMessages(messages, { limit: 4, before: 1 }).map((message) => message.id)).toEqual([
      "msg_6",
      "msg_7",
      "msg_8",
      "msg_9",
    ])
    expect(
      selectWindowedUserMessages(messages, { limit: 4, before: 1, targetID: "msg_4" }).map((message) => message.id),
    ).toEqual(["msg_3", "msg_4", "msg_5", "msg_6"])
    const short = messages.slice(0, 3)
    expect(selectWindowedUserMessages(short, { limit: 4, before: 1 })).toBe(short)
  })

  test("auto-fills history only until rendered content fills the viewport", () => {
    expect(shouldAutoFillHistory({ scrollHeight: 1200, clientHeight: 700 })).toBe(false)
    expect(shouldAutoFillHistory({ scrollHeight: 700, clientHeight: 700 })).toBe(true)
  })

  test("loads pages until a visible user turn is added", async () => {
    let loaded = 10
    let visible = 2
    let calls = 0
    const anchors: Array<string | boolean> = []

    await loadOlderTimeline({
      sessionID: () => "ses_test",
      loaded: () => loaded,
      visible: () => visible,
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
        loaded += 3
        if (calls === 2) visible += 1
      },
      before: () => anchors.push("before"),
      after: (done) => anchors.push("after", done),
    })

    expect(calls).toBe(2)
    expect(anchors).toEqual(["before", "after", false, "after", true])
  })

  test("stops when a page adds no raw messages", async () => {
    let calls = 0
    await loadOlderTimeline({
      sessionID: () => "ses_test",
      loaded: () => 10,
      visible: () => 2,
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
      },
    })

    expect(calls).toBe(1)
  })

  test("does not restore an anchor after the session changes", async () => {
    let sessionID = "ses_old"
    let restore = 0

    await loadOlderTimeline({
      sessionID: () => sessionID,
      loaded: () => 10,
      visible: () => 2,
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        sessionID = "ses_new"
      },
      after: () => {
        restore += 1
      },
    })

    expect(restore).toBe(0)
  })

  test("releases the anchor when loading history fails", async () => {
    let restore = 0

    await expect(
      loadOlderTimeline({
        sessionID: () => "ses_test",
        loaded: () => 10,
        visible: () => 2,
        more: () => true,
        loading: () => false,
        loadMore: async () => {
          throw new Error("history failed")
        },
        after: () => {
          restore += 1
        },
      }),
    ).rejects.toThrow("history failed")

    expect(restore).toBe(1)
  })
})

describe("timeline auto resume", () => {
  let timeoutFailure: unknown

  beforeAll(async () => {
    // Real production failure shape: two timed-out attempts (the 2x15s contract is pinned in
    // directory-sync tests). The short timeout keeps this setup fast without changing the error.
    timeoutFailure = await withSessionMessageRequestTimeout({
      signal: new AbortController().signal,
      timeoutMs: 5,
      task: () => new Promise<never>(() => {}),
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
  })

  const flushMicrotasks = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  }

  const setupAutoResume = () => {
    const seen = { probes: 0, resumes: 0 }
    const pending: Array<(healthy: boolean) => void> = []
    const controller = createTimelineAutoResume({
      probe: () =>
        new Promise<boolean>((resolve) => {
          seen.probes += 1
          pending.push(resolve)
        }),
      resume: () => {
        seen.resumes += 1
      },
    })
    return { controller, seen, pending }
  }

  const armTimedOutEpisode = (
    controller: ReturnType<typeof createTimelineAutoResume>,
    overrides?: Partial<{ key: string; cached: boolean; active: boolean; error: unknown; ready: () => boolean }>,
  ) =>
    controller.arm({
      key: "ses_timeout",
      sessionID: "ses_timeout",
      cached: false,
      active: true,
      error: timeoutFailure,
      ready: () => true,
      ...overrides,
    })

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test("recognizes the production two-attempt timeout failure", () => {
    expect(isSessionMessageRequestTimeoutError(timeoutFailure)).toBe(true)
    expect(SESSION_MESSAGE_REQUEST_TIMEOUT_MS).toBe(15_000)
    expect(SESSION_MESSAGE_REQUEST_RETRIES).toBe(1)
  })

  test("retries transient session metadata failures but not permanent responses", () => {
    for (const status of [408, 499, 500, 503, 504]) {
      expect(isRecoverableTimelineLoadError(Object.assign(new Error("request failed"), { cause: { status } }))).toBe(true)
    }
    for (const status of [400, 401, 403, 404, 429]) {
      expect(isRecoverableTimelineLoadError(Object.assign(new Error("request failed"), { cause: { status } }))).toBe(false)
    }
    expect(isRecoverableTimelineLoadError(new TypeError("Failed to fetch"))).toBe(true)
    expect(isRecoverableTimelineLoadError(new DOMException("Aborted", "AbortError"))).toBe(false)
  })

  test("gates auto resume on active, uncached, timed-out loads with remaining budget", () => {
    expect(shouldAutoResumeTimelineLoad({ active: true, cached: false, timedOut: true })).toBe(true)
    expect(shouldAutoResumeTimelineLoad({ active: false, cached: false, timedOut: true })).toBe(false)
    expect(shouldAutoResumeTimelineLoad({ active: true, cached: true, timedOut: true })).toBe(false)
    expect(shouldAutoResumeTimelineLoad({ active: true, cached: false, timedOut: false })).toBe(false)
  })

  test("resumes a timed-out load after the probe proves the server recovered, without looping", async () => {
    const { controller, seen, pending } = setupAutoResume()
    armTimedOutEpisode(controller)
    expect(controller.pending()).toBe(true)

    vi.advanceTimersByTime(TIMELINE_AUTO_RESUME_DELAY_MS)
    await flushMicrotasks()
    expect(seen.probes).toBe(1)
    expect(seen.resumes).toBe(0)

    // The healthy probe proves server recovery and triggers exactly one refetch.
    pending.shift()?.(true)
    await flushMicrotasks()
    expect(seen.resumes).toBe(1)
    expect(controller.pending()).toBe(false)

    // The resumed load fails again: retries keep the same capped backoff episode.
    armTimedOutEpisode(controller)
    expect(controller.pending()).toBe(true)
    vi.advanceTimersByTime(TIMELINE_AUTO_RESUME_MAX_DELAY_MS)
    await flushMicrotasks()
    pending.shift()?.(true)
    await flushMicrotasks()
    armTimedOutEpisode(controller)
    vi.advanceTimersByTime(TIMELINE_AUTO_RESUME_MAX_DELAY_MS)
    await flushMicrotasks()
    pending.shift()?.(true)
    await flushMicrotasks()
    expect(seen.resumes).toBe(3)

    armTimedOutEpisode(controller)
    expect(controller.pending()).toBe(true)
    for (let attempt = 4; attempt <= 16; attempt++) {
      vi.advanceTimersByTime(TIMELINE_AUTO_RESUME_MAX_DELAY_MS)
      await flushMicrotasks()
      pending.shift()?.(true)
      await flushMicrotasks()
      armTimedOutEpisode(controller)
    }
    expect(controller.pending()).toBe(true)
    expect(seen.probes).toBe(16)
    expect(seen.resumes).toBe(16)
  })

  test("keeps retrying at a capped interval while the server stays unhealthy", async () => {
    const { controller, seen, pending } = setupAutoResume()
    armTimedOutEpisode(controller)

    for (let round = 0; round < 16; round++) {
      vi.advanceTimersByTime(round < 3 ? TIMELINE_AUTO_RESUME_DELAY_MS * 2 ** round : TIMELINE_AUTO_RESUME_MAX_DELAY_MS)
      await flushMicrotasks()
      pending.shift()?.(false)
      await flushMicrotasks()
    }

    expect(seen.probes).toBe(16)
    expect(seen.resumes).toBe(0)
    expect(controller.pending()).toBe(true)
  })

  test("resumes when server recovery takes longer than a minute", async () => {
    const { controller, seen, pending } = setupAutoResume()
    armTimedOutEpisode(controller)

    for (let attempt = 1; attempt <= 7; attempt++) {
      vi.advanceTimersByTime(TIMELINE_AUTO_RESUME_MAX_DELAY_MS)
      await flushMicrotasks()
      pending.shift()?.(false)
      await flushMicrotasks()
    }
    expect(seen.resumes).toBe(0)
    expect(controller.pending()).toBe(true)

    vi.advanceTimersByTime(TIMELINE_AUTO_RESUME_MAX_DELAY_MS)
    await flushMicrotasks()
    pending.shift()?.(true)
    await flushMicrotasks()
    expect(seen.probes).toBe(8)
    expect(seen.resumes).toBe(1)
  })

  test("never auto-resumes a missing session or a permanent failure", async () => {
    const { controller, seen } = setupAutoResume()
    const missing = Object.assign(new Error("missing"), { cause: { status: 404 } })

    armTimedOutEpisode(controller, { error: missing })
    armTimedOutEpisode(controller, { error: Object.assign(new Error("forbidden"), { cause: { status: 403 } }) })
    expect(controller.pending()).toBe(false)
    vi.advanceTimersByTime(TIMELINE_AUTO_RESUME_DELAY_MS)
    await flushMicrotasks()
    expect(seen.probes).toBe(0)
  })

  test("automatically retries a 499 session metadata failure after health returns", async () => {
    const { controller, seen, pending } = setupAutoResume()
    armTimedOutEpisode(controller, {
      error: Object.assign(new Error("Client closed request"), { cause: { status: 499 } }),
    })
    expect(controller.pending()).toBe(true)
    vi.advanceTimersByTime(TIMELINE_AUTO_RESUME_DELAY_MS)
    await flushMicrotasks()
    pending.shift()?.(true)
    await flushMicrotasks()
    expect(seen.resumes).toBe(1)
  })

  test("stays idle for inactive tabs and cached timelines", async () => {
    const { controller, seen } = setupAutoResume()

    armTimedOutEpisode(controller, { active: false })
    armTimedOutEpisode(controller, { cached: true })
    expect(controller.pending()).toBe(false)
    vi.advanceTimersByTime(TIMELINE_AUTO_RESUME_DELAY_MS)
    await flushMicrotasks()
    expect(seen.probes).toBe(0)
  })

  test("aborts the pending recovery when the timeline switches away or stops", async () => {
    const { controller, seen } = setupAutoResume()
    let ready = true
    armTimedOutEpisode(controller, { ready: () => ready })

    // A session switch between arming and firing flips the live readiness check.
    ready = false
    expect(controller.pending()).toBe(true)
    vi.advanceTimersByTime(TIMELINE_AUTO_RESUME_DELAY_MS)
    await flushMicrotasks()
    expect(seen.probes).toBe(0)
    expect(controller.pending()).toBe(false)

    // clearRefresh() on any source change stops a pending probe.
    armTimedOutEpisode(controller, { ready: () => true })
    expect(controller.pending()).toBe(true)
    controller.stop()
    expect(controller.pending()).toBe(false)
    vi.advanceTimersByTime(TIMELINE_AUTO_RESUME_DELAY_MS)
    await flushMicrotasks()
    expect(seen.probes).toBe(0)
    expect(seen.resumes).toBe(0)
  })

  test("keeps the budget across superseding refetches and grants each session a fresh one", async () => {
    const { controller, seen, pending } = setupAutoResume()
    armTimedOutEpisode(controller, { key: "ses_a" })
    expect(controller.pending()).toBe(true)
    vi.advanceTimersByTime(TIMELINE_AUTO_RESUME_DELAY_MS)
    await flushMicrotasks()
    pending.shift()?.(false)
    await flushMicrotasks()
    expect(seen.probes).toBe(1)

    // A reconnect-driven refetch of the same session fails again before the next probe.
    for (let attempts = 2; attempts <= 16; attempts++) {
      armTimedOutEpisode(controller, { key: "ses_a" })
      expect(controller.pending()).toBe(true)
      vi.advanceTimersByTime(TIMELINE_AUTO_RESUME_MAX_DELAY_MS)
      await flushMicrotasks()
      pending.shift()?.(false)
      await flushMicrotasks()
    }
    expect(seen.probes).toBe(16)
    expect(controller.pending()).toBe(true)

    armTimedOutEpisode(controller, { key: "ses_a" })
    expect(controller.pending()).toBe(true)

    armTimedOutEpisode(controller, { key: "ses_b" })
    expect(controller.pending()).toBe(true)
  })

  test("renews the budget once a load succeeds and resets the episode", async () => {
    const { controller, seen, pending } = setupAutoResume()
    armTimedOutEpisode(controller)
    vi.advanceTimersByTime(TIMELINE_AUTO_RESUME_DELAY_MS)
    await flushMicrotasks()
    pending.shift()?.(true)
    await flushMicrotasks()
    expect(seen.resumes).toBe(1)

    controller.reset()
    armTimedOutEpisode(controller)
    expect(controller.pending()).toBe(true)
    vi.advanceTimersByTime(TIMELINE_AUTO_RESUME_DELAY_MS)
    await flushMicrotasks()
    pending.shift()?.(true)
    await flushMicrotasks()
    expect(seen.probes).toBe(2)
    expect(seen.resumes).toBe(2)
  })

  test("keeps long-session paging limits on the auto-resumed open path", () => {
    // A recovery refetch reopens the session through the standard open path: recovery never
    // resets a long cached window and each read stays capped at the 200-message API limit.
    expect(shouldResetTimelineMessagesOnOpen(SESSION_MESSAGE_REOPEN_LIMIT, false)).toBe(false)
    expect(shouldResetTimelineMessagesOnOpen(SESSION_MESSAGE_REOPEN_LIMIT + 1, true)).toBe(false)
    expect(
      nextSessionMessageReadLimit({ limit: SESSION_MESSAGE_WINDOW_LIMIT, lookbehind: SESSION_MESSAGE_PAGE_LOOKBEHIND }),
    ).toBe(200)
  })

  test("probes the real project-scoped message route with limit 1", async () => {
    const calls: Array<{ args: unknown; options: unknown }> = []
    const client = {
      v2: {
        session: {
          messages: async (args: unknown, options?: unknown) => {
            calls.push({ args, options })
            return { data: { data: [], cursor: {} } }
          },
        },
      },
    }
    const healthy = await timelineAutoResumeProbe({ client: client as never, sessionID: "ses_probe" })
    expect(healthy).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toMatchObject({ sessionID: "ses_probe", limit: 1 })
    expect(calls[0]?.options).toMatchObject({ signal: expect.any(AbortSignal) })

    const failing = {
      v2: { session: { messages: async () => ({ error: { message: "down" } }) } },
    }
    expect(await timelineAutoResumeProbe({ client: failing as never, sessionID: "ses_probe" })).toBe(false)

    const throwing = {
      v2: {
        session: {
          messages: async () => {
            throw new Error("down")
          },
        },
      },
    }
    expect(await timelineAutoResumeProbe({ client: throwing as never, sessionID: "ses_probe" })).toBe(false)
  })
})
