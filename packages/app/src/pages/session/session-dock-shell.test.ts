import { describe, expect, test } from "bun:test"
import { shouldDockControlPanel } from "@/utils/control-panel-presentation"
import {
  isStaleRetainedHandoffRequest,
  matchesRetainedHandoffRequest,
  retainedHandoffRequest,
  shouldKeepHistoricalHandoffFallback,
  shouldKeepRetainedHandoffPanel,
  updateVisiblePanelCache,
} from "./active-session-scan"
import { controlPanelPaneId } from "./composer/session-request-tree"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { directoryKey } from "@/utils/path-key"
import { pinnedControlPanelPaneId } from "@/context/control-panel-key"

describe("shouldDockControlPanel", () => {
  test("opens control panels as popups unless docking is explicit", () => {
    expect(shouldDockControlPanel({})).toBe(false)
    expect(shouldDockControlPanel({ dock: false })).toBe(false)
    expect(shouldDockControlPanel({ dock: true })).toBe(true)
    expect(shouldDockControlPanel({ pinned: true })).toBe(true)
  })
})

describe("controlPanelPaneId", () => {
  test("keeps one pane identity across directory alias spellings", () => {
    const canonical = controlPanelPaneId("C:/OpenCode/AgentHandoff", "ses_handoff", "msg_handoff", "part_handoff")
    expect(controlPanelPaneId("C:\\OpenCode\\AgentHandoff\\", "ses_handoff", "msg_handoff", "part_handoff")).toBe(canonical)
    expect(controlPanelPaneId("c:/opencode/agenthandoff", "ses_handoff", "msg_handoff", "part_handoff")).toBe(canonical)
  })

  test("migrates a pre-change Windows alias pinned record idempotently", () => {
    const legacyID = `control-panel:pinned:${base64Encode(["C:\\OpenCode\\AgentHandoff", "handoff"].join("\0"))}`
    const canonical = `control-panel:pinned:${base64Encode([directoryKey("C:\\OpenCode\\AgentHandoff"), "handoff"].join("\0"))}`
    expect(legacyID).not.toBe(canonical)
    const decoded = (id: string) => {
      const encoded = id.slice("control-panel:pinned:".length)
      return Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    }
    expect(decoded(legacyID).split("\0")[0]).toBe("C:\\OpenCode\\AgentHandoff")
    expect(decoded(canonical).split("\0")[0]).toBe(directoryKey("C:\\OpenCode\\AgentHandoff"))
    expect(canonical).toBe(`control-panel:pinned:${base64Encode([directoryKey("c:/opencode/agenthandoff/"), "handoff"].join("\0"))}`)
  })

  test("pinned panel key normalizes directory aliases through the product helper", () => {
    const legacyDirectory = "C:\\OpenCode\\AgentHandoff"
    const canonicalDirectory = directoryKey(legacyDirectory)
    const controlID = "handoff"
    const legacyEncoded = base64Encode([legacyDirectory, controlID].join("\0"))
    const legacyID = `control-panel:pinned:${legacyEncoded}`
    const canonicalID = pinnedControlPanelPaneId(legacyDirectory, controlID)

    expect(canonicalID).toBe(`control-panel:pinned:${base64Encode([canonicalDirectory, controlID].join("\0"))}`)
    expect(legacyID).not.toBe(canonicalID)
    expect(pinnedControlPanelPaneId("c:/opencode/agenthandoff/", controlID)).toBe(canonicalID)
    expect(directoryKey(legacyDirectory)).toBe(canonicalDirectory)
  })
})

describe("retainedHandoffRequest", () => {
  test("resolves a live request by ID and detects stale revision metadata", () => {
    const live = {
      id: "que_handoff",
      revision: 2,
      tool: { messageID: "msg_handoff", callID: "call_handoff", confirmationToken: "token-two" },
      surface: { version: 1, controlID: "handoff", controls: [] },
    }
    const requests = [live]
    expect(retainedHandoffRequest({ panel: { requestID: "que_handoff" }, requests })).toBe(live)
    expect(retainedHandoffRequest({ panel: { requestID: "que_other" }, requests })).toBeUndefined()
    expect(retainedHandoffRequest({ panel: {}, requests })).toBeUndefined()
    expect(isStaleRetainedHandoffRequest({ panel: { requestRevision: 1, requestCapability: "token-one" }, request: live })).toBe(true)
    expect(isStaleRetainedHandoffRequest({ panel: { requestRevision: 2, requestCapability: "token-two" }, request: live })).toBe(false)
    expect(isStaleRetainedHandoffRequest({ panel: {}, request: live })).toBe(false)
  })
})

describe("shouldKeepHistoricalHandoffFallback", () => {
  test("keeps a blocked history fallback only until the live request snapshot is loaded", () => {
    expect(shouldKeepHistoricalHandoffFallback({ hasLiveRequest: false, requestsLoaded: false, ready: true })).toBe(true)
    expect(shouldKeepHistoricalHandoffFallback({ hasLiveRequest: true, requestsLoaded: false, ready: true })).toBe(false)
    expect(shouldKeepHistoricalHandoffFallback({ hasLiveRequest: false, requestsLoaded: true, ready: true })).toBe(false)
    expect(shouldKeepHistoricalHandoffFallback({ hasLiveRequest: false, requestsLoaded: false, ready: false })).toBe(false)
  })
})

describe("matchesRetainedHandoffRequest", () => {
  test("matches live panes by request ID and legacy panels by their source", () => {
    const request: Parameters<typeof matchesRetainedHandoffRequest>[0]["request"] = {
      id: "que_current",
      surface: { version: 1, controlID: "handoff", controls: [] },
    }
    const requestPanel = { requestID: "que_current", messageID: "que_current", controlID: "handoff" }
    const stalePanel = { ...requestPanel, requestID: "que_old" }

    expect(matchesRetainedHandoffRequest({ panel: requestPanel, request })).toBe(true)
    expect(matchesRetainedHandoffRequest({ panel: stalePanel, request })).toBe(false)
    expect(
      matchesRetainedHandoffRequest({
        panel: { messageID: "msg_handoff", controlID: "handoff" },
        request: { ...request, tool: { messageID: "msg_handoff", callID: "call_handoff" } },
      }),
    ).toBe(true)
    expect(
      matchesRetainedHandoffRequest({
        panel: { messageID: "msg_handoff", controlID: "handoff" },
        request,
      }),
    ).toBe(true)
  })
})

describe("shouldKeepRetainedHandoffPanel", () => {
  test("drops legacy fallbacks when a live request appears or its snapshot is complete", () => {
    expect(
      shouldKeepRetainedHandoffPanel({
        requestID: undefined,
        dismissed: false,
        hasLiveRequest: false,
        snapshotAvailable: true,
        requestsLoaded: false,
        ready: true,
      }),
    ).toBe(true)
    expect(
      shouldKeepRetainedHandoffPanel({
        requestID: undefined,
        dismissed: false,
        hasLiveRequest: true,
        snapshotAvailable: true,
        requestsLoaded: false,
        ready: true,
      }),
    ).toBe(false)
    expect(
      shouldKeepRetainedHandoffPanel({
        requestID: undefined,
        dismissed: false,
        hasLiveRequest: false,
        snapshotAvailable: true,
        requestsLoaded: true,
        ready: true,
      }),
    ).toBe(false)
  })

  test("keeps request panes only while the request is live or its snapshot is loading", () => {
    expect(
      shouldKeepRetainedHandoffPanel({
        requestID: "que_handoff",
        dismissed: false,
        hasLiveRequest: true,
        snapshotAvailable: true,
        requestsLoaded: true,
        ready: true,
      }),
    ).toBe(true)
    expect(
      shouldKeepRetainedHandoffPanel({
        requestID: "que_handoff",
        dismissed: false,
        hasLiveRequest: false,
        snapshotAvailable: true,
        requestsLoaded: false,
        ready: true,
      }),
    ).toBe(true)
    expect(
      shouldKeepRetainedHandoffPanel({
        requestID: "que_handoff",
        dismissed: false,
        hasLiveRequest: false,
        snapshotAvailable: true,
        requestsLoaded: true,
        ready: true,
      }),
    ).toBe(false)
    expect(
      shouldKeepRetainedHandoffPanel({
        requestID: "que_handoff",
        dismissed: true,
        hasLiveRequest: true,
        snapshotAvailable: true,
        requestsLoaded: false,
        ready: true,
      }),
    ).toBe(false)
  })

  test("drops retained panels before hydration or when the directory store is missing", () => {
    const panel = {
      requestID: "que_handoff",
      dismissed: false,
      hasLiveRequest: false,
      snapshotAvailable: false,
      requestsLoaded: false,
      ready: true,
    }

    expect(shouldKeepRetainedHandoffPanel(panel)).toBe(false)
    expect(shouldKeepRetainedHandoffPanel({ ...panel, snapshotAvailable: true, ready: false })).toBe(false)
  })
})

describe("updateVisiblePanelCache", () => {
  test("keeps a retrying handoff cleanup closed across a loaded snapshot", () => {
    const panel = {
      paneID: "handoff-pane",
      requestID: "que_handoff",
      dismissed: true,
      hasLiveRequest: true,
      snapshotAvailable: true,
      requestsLoaded: false,
      ready: true,
    }
    const cache = new Map([[panel.paneID, panel]])
    const keep = (item: typeof panel) => shouldKeepRetainedHandoffPanel(item)

    expect(updateVisiblePanelCache({ cache, active: [], closed: {}, visible: () => true, keep })).toEqual([])
    expect(cache.size).toBe(0)
    panel.hasLiveRequest = false
    panel.requestsLoaded = true
    expect(updateVisiblePanelCache({ cache, active: [], closed: {}, visible: () => true, keep })).toEqual([])
  })

  test("prunes a completed historical handoff fallback without a request ID", () => {
    const panel = {
      paneID: "historical-handoff-pane",
      requestID: undefined,
      dismissed: false,
      hasLiveRequest: false,
      handoff: true,
      requestsLoaded: false,
      ready: true,
    }
    const cache = new Map([[panel.paneID, panel]])
    const keep = (item: typeof panel) =>
      !item.handoff ||
      shouldKeepRetainedHandoffPanel({
        requestID: item.requestID,
        dismissed: item.dismissed,
        hasLiveRequest: item.hasLiveRequest,
        snapshotAvailable: true,
        requestsLoaded: item.requestsLoaded,
        ready: item.ready,
      })

    expect(
      updateVisiblePanelCache({
        cache,
        active: [],
        closed: {},
        visible: () => true,
        keep,
      }),
    ).toEqual([panel])
    panel.hasLiveRequest = true
    expect(updateVisiblePanelCache({ cache, active: [], closed: {}, visible: () => true, keep })).toEqual([])
    expect(cache.size).toBe(0)
    panel.hasLiveRequest = false
    panel.requestsLoaded = true
    cache.set(panel.paneID, panel)
    expect(updateVisiblePanelCache({ cache, active: [], closed: {}, visible: () => true, keep })).toEqual([])
    expect(cache.size).toBe(0)
  })

  test("suppresses a historical fallback while persisted cleanup is pending", () => {
    const panel = {
      paneID: "historical-handoff-cleanup",
      requestID: undefined,
      dismissed: true,
      hasLiveRequest: false,
      handoff: true,
      requestsLoaded: false,
      ready: true,
    }
    const cache = new Map([[panel.paneID, panel]])

    expect(
      updateVisiblePanelCache({
        cache,
        active: [],
        closed: {},
        visible: () => true,
        keep: (item) =>
          !item.handoff ||
          shouldKeepRetainedHandoffPanel({
            requestID: item.requestID,
            dismissed: item.dismissed,
            hasLiveRequest: item.hasLiveRequest,
            snapshotAvailable: true,
            requestsLoaded: item.requestsLoaded,
            ready: item.ready,
          }),
      }),
    ).toEqual([])
    expect(cache.size).toBe(0)
  })
})
