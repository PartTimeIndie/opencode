import { describe, expect, test } from "bun:test"
import { ServerConnection } from "@/context/server"
import {
  loadSessionTabInfo,
  notifySessionTabsRemoved,
  readSessionTabReconciledDetail,
  readSessionTabsRemovedDetail,
  sessionTabDisplayTitle,
  SESSION_TAB_RECONCILED_EVENT,
  SESSION_TABS_REMOVED_EVENT,
} from "./titlebar-session-events"

describe("titlebar session events", () => {
  test("always renders a stable tab name", () => {
    expect(sessionTabDisplayTitle({ id: "ses_1", title: "  Planning  ", slug: "planning" })).toBe("Planning")
    expect(sessionTabDisplayTitle({ id: "ses_2", title: "", slug: "startup-fix" })).toBe("startup-fix")
    expect(sessionTabDisplayTitle({ id: "ses_3", title: "   ", slug: "" })).toBe("ses_3")
  })

  test("reads a valid session tab reconciliation", () => {
    const previous = {
      type: "session" as const,
      server: ServerConnection.Key.make("https://server-a.test"),
      dirBase64: "b2xk",
      sessionId: "ses_1",
    }
    const next = { ...previous, dirBase64: "bmV3" }

    expect(
      readSessionTabReconciledDetail(
        new CustomEvent(SESSION_TAB_RECONCILED_EVENT, { detail: { previous: [previous], next } }),
      ),
    ).toEqual({ previous: [previous], next })
  })

  test("reads valid removed session tab details", () => {
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { server: "https://server-b.test", directory: "/tmp/project", sessionIDs: ["ses_1", "ses_2", 1] },
        }),
      ),
    ).toEqual({
      server: ServerConnection.Key.make("https://server-b.test"),
      directory: "/tmp/project",
      sessionIDs: ["ses_1", "ses_2"],
    })
  })

  test("rejects unsafe legacy details without an owning server", () => {
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { directory: "/tmp/project", sessionIDs: ["ses_1"] },
        }),
      ),
    ).toBeUndefined()
  })

  test("ignores invalid removed session tab details", () => {
    expect(readSessionTabsRemovedDetail(new Event(SESSION_TABS_REMOVED_EVENT))).toBeUndefined()
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { directory: "/tmp/project", sessionIDs: [] },
        }),
      ),
    ).toBeUndefined()
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { server: " ", directory: "/tmp/project", sessionIDs: ["ses_1"] },
        }),
      ),
    ).toBeUndefined()
  })

  test("cleans up only authoritative 404s while retaining valid, 500, and network-failed tabs", async () => {
    const server = ServerConnection.Key.make("https://server-a.test")
    const removed: unknown[] = []
    const missing = Object.assign(new Error("missing"), { cause: { status: 404 } })
    const failure = Object.assign(new Error("failed"), { cause: { status: 500 } })

    expect(
      await loadSessionTabInfo({
        server,
        directory: "/tmp/project",
        sessionID: "ses_valid",
        load: async () => {},
        onMissing: (detail) => removed.push(detail),
      }),
    ).toBe("loaded")
    expect(
      await loadSessionTabInfo({
        server,
        directory: "/tmp/project",
        sessionID: "ses_missing",
        load: () => Promise.reject(missing),
        onMissing: (detail) => removed.push(detail),
      }),
    ).toBe("missing")
    expect(
      await loadSessionTabInfo({
        server,
        directory: "/tmp/project",
        sessionID: "ses_failed",
        load: () => Promise.reject(failure),
        onMissing: (detail) => removed.push(detail),
      }),
    ).toBe("retained")
    expect(
      await loadSessionTabInfo({
        server,
        directory: "/tmp/project",
        sessionID: "ses_offline",
        load: () => Promise.reject(new Error("offline")),
        onMissing: (detail) => removed.push(detail),
      }),
    ).toBe("retained")
    expect(removed).toEqual([
      { server, directory: "/tmp/project", sessionIDs: ["ses_missing"] },
    ])
  })

  test("serializes concurrent tab-info loads so background tabs cannot starve the active session", async () => {
    let releaseFirst = () => {}
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    const started: string[] = []
    const server = ServerConnection.Key.make("https://server-a.test")
    const first = loadSessionTabInfo({
      server,
      directory: "/tmp/project",
      sessionID: "ses_first",
      load: async () => {
        started.push("first")
        await firstGate
      },
    })
    const second = loadSessionTabInfo({
      server,
      directory: "/tmp/project",
      sessionID: "ses_second",
      load: async () => {
        started.push("second")
      },
    })

    await Promise.resolve()
    expect(started).toEqual(["first"])
    releaseFirst()
    await Promise.all([first, second])
    expect(started).toEqual(["first", "second"])
  })

  test("deduplicates identical loads and retries one transient startup failure", async () => {
    const server = ServerConnection.Key.make("https://server-a.test")
    let calls = 0
    const input = {
      server,
      directory: "/tmp/project",
      sessionID: "ses_retry",
      load: async () => {
        calls += 1
        if (calls === 1) throw new Error("server starting")
      },
    }
    const first = loadSessionTabInfo(input)
    const second = loadSessionTabInfo(input)
    expect(first).toBe(second)
    expect(await first).toBe("loaded")
    expect(calls).toBe(2)
  })

  test("keeps metadata hydration bounded for many restored inactive tabs", async () => {
    const server = ServerConnection.Key.make("https://server-a.test")
    const directories = Array.from({ length: 60 }, (_, index) => `/tmp/project-${index}`)
    const loaded: string[] = []

    await Promise.all(
      directories.map((directory, index) =>
        loadSessionTabInfo({
          server,
          directory,
          sessionID: `ses_inactive_${index}`,
          load: async () => {
            loaded.push(directory)
          },
        }),
      ),
    )

    expect(loaded).toEqual(directories)
  })

  test("deduplicates cleanup per owner without colliding across servers", async () => {
    const events: unknown[] = []
    const listener = (event: Event) => events.push(readSessionTabsRemovedDetail(event))
    window.addEventListener(SESSION_TABS_REMOVED_EVENT, listener)
    const serverA = ServerConnection.Key.make("https://server-a.test")
    const serverB = ServerConnection.Key.make("https://server-b.test")
    const detailA = { server: serverA, directory: "/tmp/project", sessionIDs: ["ses_same"] }
    const detailB = { server: serverB, directory: "/tmp/project", sessionIDs: ["ses_same"] }

    try {
      expect(notifySessionTabsRemoved(detailA)).toBe(true)
      expect(notifySessionTabsRemoved(detailA)).toBe(false)
      expect(notifySessionTabsRemoved(detailB)).toBe(true)
      expect(events).toEqual([detailA, detailB])
      await Promise.resolve()
      expect(notifySessionTabsRemoved(detailA)).toBe(true)
    } finally {
      window.removeEventListener(SESSION_TABS_REMOVED_EVENT, listener)
    }
  })
})
