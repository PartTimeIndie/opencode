import { describe, expect, test } from "bun:test"
import { resolveActiveSessionScan, updateVisiblePanelCache } from "./active-session-scan"

describe("resolveActiveSessionScan", () => {
  test("resolves only the active session while many inactive long sessions stay untouched", () => {
    const inactive = Array.from({ length: 48 }, (_, index) => `C:/repo/inactive-${index}`)
    const touched: string[] = []
    const stores = new Map([
      ["C:/repo/active", { messages: 3 }],
      ...inactive.map((directory) => [
        directory,
        {
          get messages(): never {
            throw new Error(`inactive timeline scanned: ${directory}`)
          },
        },
      ] as const),
    ])

    const scan = resolveActiveSessionScan({
      directory: "C:/repo/active",
      sessionID: "ses_active",
      resolve: (directory) => {
        touched.push(directory)
        return stores.get(directory)
      },
    })

    expect(scan?.store.messages).toBe(3)
    expect(touched).toEqual(["C:/repo/active"])
  })

  test("does not create a store without an active routed session", () => {
    let resolved = 0
    expect(
      resolveActiveSessionScan({
        directory: "C:/repo/active",
        sessionID: undefined,
        resolve: () => {
          resolved += 1
          return {}
        },
      }),
    ).toBeUndefined()
    expect(resolved).toBe(0)
  })

  test("retains only visible dock panels and releases hidden or closed entries", () => {
    const cache = new Map<string, { paneID: string }>()
    const visible = new Set<string>()
    const panel = { paneID: "surface_panel" }

    expect(updateVisiblePanelCache({ cache, active: [panel], closed: {}, visible: (id) => visible.has(id) })).toEqual([])

    visible.add(panel.paneID)
    expect(updateVisiblePanelCache({ cache, active: [panel], closed: {}, visible: (id) => visible.has(id) })).toEqual([
      panel,
    ])
    expect(updateVisiblePanelCache({ cache, active: [], closed: {}, visible: (id) => visible.has(id) })).toEqual([panel])

    visible.delete(panel.paneID)
    expect(updateVisiblePanelCache({ cache, active: [], closed: {}, visible: (id) => visible.has(id) })).toEqual([])

    visible.add(panel.paneID)
    cache.set(panel.paneID, panel)
    expect(
      updateVisiblePanelCache({ cache, active: [], closed: { [panel.paneID]: true }, visible: (id) => visible.has(id) }),
    ).toEqual([])
  })

  test("the dock shell keeps inactive tab metadata and control-panel scans on non-creating lookups", async () => {
    const source = await Bun.file(new URL("./session-dock-shell.tsx", import.meta.url)).text()
    const sessionPane = source.slice(source.indexOf("const sessionPaneForTab"), source.indexOf("const activeRoutePaneID"))
    const controlPanels = source.slice(source.indexOf("const activeControlPanels"), source.indexOf("const retainedControlPanelCache"))

    expect(sessionPane).not.toContain(".child(")
    expect(sessionPane).toContain(".existing(")
    expect(controlPanels).not.toContain("tabs.store")
    expect(controlPanels).not.toContain(".child(")
    expect(controlPanels).toContain("resolveActiveSessionScan")
  })
})
