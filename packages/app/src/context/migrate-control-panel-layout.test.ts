import { describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { directoryKey } from "@/utils/path-key"
import { migrateControlPanelLayout } from "./migrate-control-panel-layout"
import { migrateDockState, type DockState } from "./layout-dock"

describe("migrateControlPanelLayout", () => {
  test("migrates persisted Windows alias and canonical duplicate through dock references", () => {
    const legacyDirectory = "C:\\OpenCode\\AgentHandoff"
    const normalizedDirectory = directoryKey(legacyDirectory)
    const controlID = "handoff"
    const legacyID = `control-panel:pinned:${base64Encode([legacyDirectory, controlID].join("\0"))}`
    const canonicalID = `control-panel:pinned:${base64Encode([normalizedDirectory, controlID].join("\0"))}`

    const dock: DockState = {
      schema: 3,
      top: { visible: true, size: 160, tabs: [legacyID, canonicalID], active: legacyID },
      left: { visible: false, size: 280, tabs: [] },
      middle: { visible: true, size: 600, tabs: ["session"], active: "session" },
      right: { visible: false, size: 280, tabs: [] },
      bottom: { visible: false, size: 280, tabs: [] },
      items: {
        [legacyID]: { area: "top", visible: true },
        [canonicalID]: { area: "top", visible: true },
        session: { area: "middle", visible: true },
      },
      mobile: { size: 320, activeItem: legacyID },
    }

    const persistedLayout = {
      dock,
      controlPanels: {
        pinned: {
          [legacyID]: {
            id: legacyID,
            directory: legacyDirectory,
            sessionID: "ses_handoff",
            messageID: "msg_handoff",
            partID: "part_handoff",
            controlID,
            title: "Legacy alias",
            data: { version: 1, controlID, dock: true },
          },
          [canonicalID]: {
            id: canonicalID,
            directory: normalizedDirectory,
            sessionID: "ses_handoff",
            messageID: "msg_handoff",
            partID: "part_handoff",
            controlID,
            title: "Canonical record",
            data: { version: 1, controlID, dock: true },
          },
        },
      },
    }

    const result = migrateControlPanelLayout(persistedLayout)

    expect(result.dock.top.tabs).toEqual([canonicalID])
    expect(result.dock.top.active).toBe(canonicalID)
    expect(Object.keys(result.dock.items).filter((id) => id === canonicalID)).toEqual([canonicalID])
    expect(result.dock.items[legacyID]).toBeUndefined()
    expect(result.dock.mobile.activeItem).toBe(canonicalID)

    expect(result.controlPanels).toMatchObject({
      pinned: {
        [canonicalID]: {
          id: canonicalID,
          directory: normalizedDirectory,
          controlID,
        },
      },
    })
    expect(Object.keys((result.controlPanels as { pinned: Record<string, unknown> }).pinned)).toEqual([canonicalID])
  })

  test("leaves distinct control IDs in the same directory as separate dock items", () => {
    const directory = "C:\\OpenCode\\AgentHandoff"
    const normalizedDirectory = directoryKey(directory)
    const first = `control-panel:pinned:${base64Encode([normalizedDirectory, "handoff-a"].join("\0"))}`
    const second = `control-panel:pinned:${base64Encode([normalizedDirectory, "handoff-b"].join("\0"))}`
    const dock: DockState = {
      schema: 3,
      top: { visible: true, size: 160, tabs: [first, second], active: first },
      left: { visible: false, size: 280, tabs: [] },
      middle: { visible: true, size: 600, tabs: ["session"], active: "session" },
      right: { visible: false, size: 280, tabs: [] },
      bottom: { visible: false, size: 280, tabs: [] },
      items: {
        [first]: { area: "top", visible: true },
        [second]: { area: "top", visible: true },
        session: { area: "middle", visible: true },
      },
      mobile: { size: 320, activeItem: second },
    }

    const result = migrateControlPanelLayout({ dock, controlPanels: { pinned: {} } })

    expect(result.dock.top.tabs).toEqual([first, second])
    expect(result.dock.top.active).toBe(first)
    expect(result.dock.items[first]).toEqual({ area: "top", visible: true })
    expect(result.dock.items[second]).toEqual({ area: "top", visible: true })
    expect(result.dock.mobile.activeItem).toBe(second)
  })

  test("persists a dock-only schema upgrade once and keeps the next load unchanged", () => {
    const dock = migrateDockState({})
    dock.schema = 2

    const first = migrateControlPanelLayout({ dock, controlPanels: { pinned: {} } })
    expect(first.dockChanged).toBe(true)
    expect(first.dock.schema).toBe(3)

    const second = migrateControlPanelLayout({ dock: first.dock, controlPanels: { pinned: {} } })
    expect(second.dockChanged).toBe(false)
    expect(second.dock).toBe(first.dock)
  })

  test("merges reversed aliases deterministically across dock areas and pinned records", () => {
    const directory = "C:\\OpenCode\\AgentHandoff"
    const normalizedDirectory = directoryKey(directory)
    const controlID = "handoff"
    const legacyID = `control-panel:pinned:${base64Encode([directory, controlID].join("\0"))}`
    const canonicalID = `control-panel:pinned:${base64Encode([normalizedDirectory, controlID].join("\0"))}`
    const outputs = [false, true].map((reverse) => {
      const dock = migrateDockState({})
      dock.top.tabs = [legacyID, "top-neighbor"]
      dock.top.active = legacyID
      dock.left.tabs = [canonicalID, "left-neighbor"]
      dock.left.active = canonicalID
      dock.items["top-neighbor"] = { area: "top", visible: true }
      dock.items["left-neighbor"] = { area: "left", visible: true }
      dock.items = Object.fromEntries([
        ...Object.entries(dock.items),
        ...(reverse
          ? [
              [canonicalID, { area: "left", visible: true }],
              [legacyID, { area: "top", visible: false }],
            ]
          : [
              [legacyID, { area: "top", visible: false }],
              [canonicalID, { area: "left", visible: true }],
            ]),
      ]) as DockState["items"]
      dock.mobile.activeItem = legacyID

      const legacyPanel = {
        id: legacyID,
        directory,
        sessionID: "ses_handoff",
        messageID: "msg_handoff",
        partID: "part_handoff",
        controlID,
        title: "Legacy alias",
        data: { version: 1, controlID, dock: true },
      }
      const canonicalPanel = {
        ...legacyPanel,
        id: canonicalID,
        directory: normalizedDirectory,
        title: "Canonical record",
      }
      const pinnedEntries = reverse
        ? [[canonicalID, canonicalPanel], [legacyID, legacyPanel]]
        : [[legacyID, legacyPanel], [canonicalID, canonicalPanel]]

      return migrateControlPanelLayout({
        dock,
        controlPanels: { pinned: Object.fromEntries(pinnedEntries) },
      })
    })

    expect(outputs[0]).toEqual(outputs[1])
    expect(outputs[0].dock.items[canonicalID]).toEqual({ area: "left", visible: true })
    expect(outputs[0].dock.top.tabs).toEqual(["top-neighbor"])
    expect(outputs[0].dock.top.active).toBe("top-neighbor")
    expect(outputs[0].dock.left.tabs).toEqual([canonicalID, "left-neighbor"])
    expect(outputs[0].dock.left.active).toBe(canonicalID)
    expect(outputs[0].dock.mobile.activeItem).toBe(canonicalID)
    expect((outputs[0].controlPanels as { pinned: Record<string, { title: string }> }).pinned[canonicalID].title).toBe(
      "Canonical record",
    )
  })
})
