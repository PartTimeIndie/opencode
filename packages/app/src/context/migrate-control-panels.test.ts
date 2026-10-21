import { describe, expect, test } from "bun:test"
import { migrateControlPanels } from "./migrate-control-panels"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { directoryKey } from "@/utils/path-key"

describe("migrateControlPanels", () => {
  test("migrates legacy pinned panel with raw directory path under single canonical key", () => {
    const legacyDirectory = "C:\\OpenCode\\AgentHandoff"
    // Canonical key is already correct (directoryKey normalized)
    const canonicalPanelId = `control-panel:pinned:${base64Encode([directoryKey(legacyDirectory), "handoff"].join("\0"))}`
    // Legacy panel ID from raw path (what panel.id currently holds)
    const legacyPanelId = `control-panel:pinned:${base64Encode([legacyDirectory, "handoff"].join("\0"))}`

    // Input matches product call: migrateControlPanels(controlPanels) where controlPanels = { pinned: {...} }
    // Single canonical key but panel has legacy inner directory AND legacy inner id
    const controlPanels = {
      pinned: {
        [canonicalPanelId]: {
          id: legacyPanelId,          // legacy inner id (not normalized)
          directory: legacyDirectory,  // legacy inner directory (not normalized)
          controlID: "handoff",
          title: "Legacy Panel",
          pinned: true,
        },
      },
    }

    const result = migrateControlPanels(controlPanels) as { pinned: Record<string, unknown> }
    expect(result).toBeDefined()
    expect(result.pinned).toBeDefined()

    const migratedPanel = result.pinned[canonicalPanelId] as Record<string, unknown> | undefined
    expect(migratedPanel).toBeDefined()
    expect((migratedPanel as Record<string, unknown>).id).toBe(canonicalPanelId)
    expect((migratedPanel as Record<string, unknown>).directory).toBe(directoryKey(legacyDirectory))
  })

  test("idempotent on already canonical directory but legacy inner id (id-only guard)", () => {
    // Regressionstest für die ergänzte id-only Guard-Bedingung (panel.id === nextID):
    // Kanonisches directory, aber stale inneres panel.id darf NICHT verworfen werden.
    const directory = "C:\\OpenCode\\AgentHandoff"
    const canonicalDirectory = directoryKey(directory)
    const canonicalPanelId = `control-panel:pinned:${base64Encode([canonicalDirectory, "handoff"].join("\0"))}`
    const legacyId = `control-panel:pinned:${base64Encode([directory, "handoff"].join("\0"))}`

    const controlPanels = {
      pinned: {
        [canonicalPanelId]: {
          id: legacyId, // stale inner id -> muss zu canonicalPanelId gemappt werden
          directory: canonicalDirectory, // already canonical
          controlID: "handoff",
          title: "CanonicalDirLegacyID",
          pinned: true,
        },
      },
    }

    const result = migrateControlPanels(controlPanels) as { pinned: Record<string, unknown> }
    const panel = (result.pinned[canonicalPanelId] as Record<string, unknown>) ?? {}
    expect(panel.id).toBe(canonicalPanelId) // id-only guard must trigger
    expect(panel.directory).toBe(directoryKey(directory))
  })

  test("idempotent on already canonical pinned panel (no double migration)", () => {
    const legacyDirectory = "C:\\OpenCode\\AgentHandoff"
    const canonicalPanelId = `control-panel:pinned:${base64Encode([directoryKey(legacyDirectory), "handoff"].join("\0"))}`

    const controlPanels = {
      pinned: {
        [canonicalPanelId]: {
          id: canonicalPanelId,
          directory: directoryKey(legacyDirectory),
          controlID: "handoff",
          title: "Canonical Panel",
          pinned: true,
        },
      },
    }

    const result = migrateControlPanels(controlPanels)
    // Should return same object (identity) when nothing changed
    expect(result).toBe(controlPanels)
  })

  test("keeps malformed pinned values stable without serializing them for change detection", () => {
    const controlPanels = { pinned: { broken: null, legacy: "not-a-record" } }

    expect(migrateControlPanels(controlPanels)).toBe(controlPanels)
  })

  test("does not let a damaged canonical alias hide a recoverable legacy pinned panel", () => {
    const directory = "C:\\OpenCode\\AgentHandoff"
    const canonicalDirectory = directoryKey(directory)
    const legacyID = `control-panel:pinned:${base64Encode([directory, "handoff"].join("\0"))}`
    const canonicalID = `control-panel:pinned:${base64Encode([canonicalDirectory, "handoff"].join("\0"))}`
    const legacyPanel = {
      id: legacyID,
      directory,
      sessionID: "ses_handoff",
      messageID: "msg_handoff",
      partID: "part_handoff",
      controlID: "handoff",
      data: { version: 1, controlID: "handoff" },
    }

    for (const pinned of [
      { [legacyID]: legacyPanel, [canonicalID]: null },
      { [canonicalID]: null, [legacyID]: legacyPanel },
    ]) {
      const result = migrateControlPanels({ pinned }) as { pinned: Record<string, typeof legacyPanel> }
      expect(result.pinned[canonicalID]).toMatchObject({ id: canonicalID, directory: canonicalDirectory })
    }
  })

  test("merges closed aliases deterministically and preserves an existing closed marker", () => {
    const directory = "C:\\OpenCode\\AgentHandoff"
    const canonicalDirectory = directoryKey(directory)
    const legacyID = `control-panel:pinned:${base64Encode([directory, "handoff"].join("\0"))}`
    const canonicalID = `control-panel:pinned:${base64Encode([canonicalDirectory, "handoff"].join("\0"))}`
    const results = [
      { [legacyID]: true, [canonicalID]: false },
      { [canonicalID]: false, [legacyID]: true },
    ].map((closed) => migrateControlPanels({ closed }) as { closed: Record<string, boolean> })

    expect(results[0]).toEqual(results[1])
    expect(results[0].closed).toEqual({ [canonicalID]: true })
  })
})
