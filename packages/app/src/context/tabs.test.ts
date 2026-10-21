import { describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { ServerConnection } from "./server"
import {
  migrateStoredTabs,
  moveSessionTabs,
  nextRecentLocal,
  reconcileSessionTab,
  reorderTabs,
  sessionTabDockPaneID,
  sessionTabMatchesRemoved,
  sessionTabReplacementForKey,
  tabKey,
  type SessionTab,
} from "./tabs-domain"

const server = ServerConnection.Key.make("local")
const other = ServerConnection.Key.make("other")

const sessionTab = (input: { server?: ServerConnection.Key; directory: string; sessionId: string }): SessionTab => ({
  type: "session",
  server: input.server ?? server,
  dirBase64: base64Encode(input.directory),
  sessionId: input.sessionId,
})

describe("reorderTabs", () => {
  test("moves the dragged tab to the target index", () => {
    const tabs = [
      sessionTab({ directory: "/project", sessionId: "ses_a" }),
      sessionTab({ directory: "/project", sessionId: "ses_b" }),
      sessionTab({ directory: "/project", sessionId: "ses_c" }),
    ]

    expect(reorderTabs(tabs, tabKey(tabs[0]!), tabKey(tabs[2]!))).toEqual([tabs[1], tabs[2], tabs[0]])
  })

  test("keeps the existing order for invalid moves", () => {
    const tabs = [sessionTab({ directory: "/project", sessionId: "ses_a" })]

    expect(reorderTabs(tabs, tabKey(tabs[0]!), "missing")).toBe(tabs)
  })
})

describe("nextRecentLocal", () => {
  test("skips the write when the loaded key is unchanged", () => {
    expect(nextRecentLocal({ loaded: true, write: 3, key: "local\nkey" }, "local\nkey")).toBeUndefined()
  })

  test("writes while unloaded even when the key already matches", () => {
    expect(nextRecentLocal({ loaded: false, write: 0 }, undefined)).toEqual({ loaded: true, write: 1, key: undefined })
  })

  test("advances the write counter and stores the new key", () => {
    expect(nextRecentLocal({ loaded: true, write: 1, key: "a" }, "b")).toEqual({ loaded: true, write: 2, key: "b" })
    expect(nextRecentLocal({ loaded: true, write: 1, key: undefined }, "b")).toEqual({ loaded: true, write: 2, key: "b" })
  })
})

describe("migrateStoredTabs", () => {
  test("keeps valid session and draft tabs", () => {
    const result = migrateStoredTabs(
      [
        { type: "draft", draftID: "draft_a", server, directory: "/project" },
        sessionTab({ directory: "/project", sessionId: "ses_a" }),
        { type: "session", dirBase64: base64Encode("/legacy"), sessionId: "ses_legacy" },
        { type: "session", dirBase64: base64Encode("/empty"), sessionId: "ses_empty", createdEmpty: true },
      ],
      server,
    )

    expect(result).toEqual([
      { type: "draft", draftID: "draft_a", server, directory: "/project" },
      sessionTab({ directory: "/project", sessionId: "ses_a" }),
      sessionTab({ directory: "/legacy", sessionId: "ses_legacy" }),
      { ...sessionTab({ directory: "/empty", sessionId: "ses_empty" }), createdEmpty: true },
    ])
  })

  test("preserves non-array values for the persisted helper to handle", () => {
    expect(migrateStoredTabs({ nope: true }, server)).toEqual({ nope: true })
  })

  test("deduplicates persisted paths for the same server session", () => {
    expect(
      migrateStoredTabs(
        [
          sessionTab({ directory: "/old", sessionId: "ses_a" }),
          sessionTab({ directory: "/current", sessionId: "ses_a" }),
        ],
        server,
      ),
    ).toEqual([{ ...sessionTab({ directory: "/current", sessionId: "ses_a" }), createdEmpty: undefined }])
  })
})

describe("reconcileSessionTab", () => {
  test("returns the same store for an identical open", () => {
    const tabs = [sessionTab({ directory: "/current", sessionId: "ses_a" })]

    expect(reconcileSessionTab(tabs, tabs[0]!)).toBe(tabs)
  })

  test("updates and focuses one logical session independently of its directory", () => {
    const current = sessionTab({ directory: "/current", sessionId: "ses_a" })
    const otherServer = sessionTab({ server: other, directory: "/old", sessionId: "ses_a" })

    expect(
      reconcileSessionTab(
        [
          sessionTab({ directory: "/old", sessionId: "ses_a" }),
          sessionTab({ directory: "/duplicate", sessionId: "ses_a" }),
          otherServer,
        ],
        current,
      ),
    ).toEqual([{ ...current, createdEmpty: undefined }, otherServer])
  })

  test("does not restore empty-session cleanup when any existing duplicate was used", () => {
    expect(
      reconcileSessionTab(
        [
          { ...sessionTab({ directory: "/old", sessionId: "ses_a" }), createdEmpty: true },
          sessionTab({ directory: "/duplicate", sessionId: "ses_a" }),
        ],
        sessionTab({ directory: "/current", sessionId: "ses_a" }),
      ),
    ).toEqual([{ ...sessionTab({ directory: "/current", sessionId: "ses_a" }), createdEmpty: undefined }])
  })
})

describe("sessionTabReplacementForKey", () => {
  test("retargets a stale recent key without losing the focused logical session", () => {
    const current = sessionTab({ directory: "/current", sessionId: "ses_target" })
    const tabs = [sessionTab({ directory: "/other", sessionId: "ses_other" }), current]
    const stale = sessionTab({ directory: "/stale", sessionId: "ses_target" })

    expect(sessionTabReplacementForKey(tabs, tabKey(stale))).toEqual({ previous: stale, next: current })
  })

  test("does not replace an exact or cross-server key", () => {
    const current = sessionTab({ directory: "/current", sessionId: "ses_target" })

    expect(sessionTabReplacementForKey([current], tabKey(current))).toBeUndefined()
    expect(
      sessionTabReplacementForKey(
        [current],
        tabKey(sessionTab({ server: other, directory: "/stale", sessionId: "ses_target" })),
      ),
    ).toBeUndefined()
  })
})

describe("moveSessionTabs", () => {
  test("moves matching session tabs to the destination directory", () => {
    const result = moveSessionTabs(
      [
        sessionTab({ directory: "/source", sessionId: "ses_root" }),
        sessionTab({ directory: "/source", sessionId: "ses_child" }),
        sessionTab({ directory: "/source", sessionId: "ses_other" }),
        sessionTab({ server: other, directory: "/source", sessionId: "ses_root" }),
      ],
      {
        server,
        fromDirectory: "/source",
        toDirectory: "/destination",
        sessionIDs: ["ses_root", "ses_child"],
      },
    )

    expect(result).toEqual([
      sessionTab({ directory: "/destination", sessionId: "ses_root" }),
      sessionTab({ directory: "/destination", sessionId: "ses_child" }),
      sessionTab({ directory: "/source", sessionId: "ses_other" }),
      sessionTab({ server: other, directory: "/source", sessionId: "ses_root" }),
    ])
  })

  test("deduplicates when the destination tab is already open", () => {
    const result = moveSessionTabs(
      [
        sessionTab({ directory: "/source", sessionId: "ses_root" }),
        sessionTab({ directory: "/destination", sessionId: "ses_root" }),
      ],
      {
        server,
        fromDirectory: "/source",
        toDirectory: "/destination",
        sessionIDs: ["ses_root"],
      },
    )

    expect(result).toEqual([sessionTab({ directory: "/destination", sessionId: "ses_root" })])
  })
})

describe("sessionTabMatchesRemoved", () => {
  test("does not match a same-directory same-ID tab from another server", () => {
    const sessionIDs = new Set(["ses_shared"])
    const input = { server: other, directory: "/shared", sessionIDs }

    expect(sessionTabMatchesRemoved(sessionTab({ directory: "/shared", sessionId: "ses_shared" }), input)).toBe(false)
    expect(
      sessionTabMatchesRemoved(sessionTab({ server: other, directory: "/shared", sessionId: "ses_shared" }), input),
    ).toBe(true)
    expect(sessionTabDockPaneID(sessionTab({ directory: "/shared", sessionId: "ses_shared" }))).not.toBe(
      sessionTabDockPaneID(sessionTab({ server: other, directory: "/shared", sessionId: "ses_shared" })),
    )
  })
})
