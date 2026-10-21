import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  migrateDockState,
  mobileDockMaxSize,
  removeDockItemState,
  replaceDockItemState,
  resolveDockActiveTab,
  shouldCloseMobileDockForKeyboard,
  shouldSyncDockActiveTab,
} from "./layout-dock"
import { createSessionKeyReader, ensureSessionKey, pruneSessionKeys } from "./layout-helpers"
import { filterDockAddItems, type DockAddMenuItemBase } from "../pages/session/dock-add-filter"

describe("layout session-key helpers", () => {
  test("couples touch and scroll seed in order", () => {
    const calls: string[] = []
    const result = ensureSessionKey(
      "dir/a",
      (key) => calls.push(`touch:${key}`),
      (key) => calls.push(`seed:${key}`),
    )

    expect(result).toBe("dir/a")
    expect(calls).toEqual(["touch:dir/a", "seed:dir/a"])
  })

  test("reads dynamic accessor keys lazily", () => {
    const seen: string[] = []

    createRoot((dispose) => {
      const [key, setKey] = createSignal("dir/one")
      const read = createSessionKeyReader(key, (value) => seen.push(value))

      expect(read()).toBe("dir/one")
      setKey("dir/two")
      expect(read()).toBe("dir/two")

      dispose()
    })

    expect(seen).toEqual(["dir/one", "dir/two"])
  })
})

describe("pruneSessionKeys", () => {
  test("keeps active key and drops lowest-used keys", () => {
    const drop = pruneSessionKeys({
      keep: "k4",
      max: 3,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
        ["k3", 3],
        ["k4", 4],
      ]),
      view: ["k1", "k2", "k4"],
      tabs: ["k1", "k3", "k4"],
    })

    expect(drop).toEqual(["k1"])
    expect(drop.includes("k4")).toBe(false)
  })

  test("does not prune without keep key", () => {
    const drop = pruneSessionKeys({
      keep: undefined,
      max: 1,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
      ]),
      view: ["k1"],
      tabs: ["k2"],
    })

    expect(drop).toEqual([])
  })
})

describe("migrateDockState", () => {
  test("maps legacy terminal and right-panel values into dock zones", () => {
    const dock = migrateDockState({
      terminal: { opened: true, height: 320 },
      review: { panelOpened: false },
      fileTree: { opened: true, width: 260, tab: "all" },
      session: { width: 720 },
    })

    expect(dock.schema).toBe(3)
    expect(dock.bottom.visible).toBe(true)
    expect(dock.bottom.size).toBe(320)
    expect(dock.right.visible).toBe(true)
    expect(dock.right.size).toBe(260)
    expect(dock.right.active).toBe("fileTree")
    expect(dock.middle.visible).toBe(true)
    expect(dock.middle.size).toBe(720)
    expect(dock.items.session).toEqual({ area: "middle", visible: true })
    expect(dock.items.terminal).toEqual({ area: "bottom", visible: true })
    expect(dock.items.review).toEqual({ area: "right", visible: false })
    expect(dock.items.fileTree).toEqual({ area: "right", visible: true })
    expect(dock.items.gitChanges).toEqual({ area: "right", visible: true })
    expect(dock.mobile).toEqual({ size: 320, activeItem: undefined })
  })

  test("keeps an existing versioned dock state and ignores legacy flags", () => {
    const current = migrateDockState({})
    current.schema = 3
    current.left.visible = true
    current.bottom.visible = false

    // Legacy `terminal.opened: true` MUST NOT resurrect the closed bottom
    // dock once a versioned dock has been persisted.
    const dock = migrateDockState({ dock: current, terminal: { opened: true } })

    expect(dock).toBe(current)
    expect(dock.left.visible).toBe(true)
    expect(dock.bottom.visible).toBe(false)
  })

  test("re-migrates an unversioned dock state and falls back to legacy flags for missing zones", () => {
    // An unversioned dock (no schema marker) is re-derived. Persisted zone
    // values are honored, but missing zones still fall back to legacy flags
    // so a partial pre-migration state is repaired on the next load.
    const unversioned = migrateDockState({})
    delete (unversioned as Partial<typeof unversioned>).schema
    unversioned.bottom.visible = false

    // Strip the bottom zone entirely so the migrator must consult the legacy
    // `terminal.opened` fallback.
    const { bottom: _bottom, ...rest } = unversioned
    void _bottom
    const dock = migrateDockState({ dock: rest, terminal: { opened: true } })

    expect(dock.schema).toBe(3)
    expect(dock.bottom.visible).toBe(true)
    // A zone that WAS present on the unversioned dock is preserved verbatim.
    expect(dock.middle.visible).toBe(true)
  })

  test("upgrades older dock items with session while preserving plugin panes", () => {
    const dock = migrateDockState({
      dock: {
        schema: 1,
        top: { visible: false, size: 160, tabs: [], active: undefined },
        left: { visible: true, size: 280, tabs: ["plugin/pane"], active: "plugin/pane" },
        middle: { visible: true, size: 600, tabs: [], active: undefined },
        right: { visible: false, size: 280, tabs: [], active: undefined },
        bottom: { visible: false, size: 280, tabs: [], active: undefined },
        items: {
          "plugin/pane": { area: "left", visible: true },
        },
      },
    })

    expect(dock.schema).toBe(3)
    expect(dock.middle.tabs).toContain("session")
    expect(dock.items.session).toEqual({ area: "middle", visible: true })
    expect(dock.items["plugin/pane"]).toEqual({ area: "left", visible: true })
  })

  test("upgrades v2 without moving desktop panes and preserves mobile state after v3", () => {
    const v2 = migrateDockState({})
    v2.schema = 2
    v2.left.tabs = ["plugin/pane"]
    v2.left.active = "plugin/pane"
    v2.items["plugin/pane"] = { area: "left", visible: true }

    const upgraded = migrateDockState({ dock: { ...v2, mobile: undefined } })

    expect(upgraded.schema).toBe(3)
    expect(upgraded.items["plugin/pane"]).toEqual({ area: "left", visible: true })
    expect(upgraded.left.tabs).toEqual(["plugin/pane"])
    expect(upgraded.mobile).toEqual({ size: 320, activeItem: undefined })

    upgraded.mobile = { size: 412, activeItem: "plugin/pane" }
    expect(migrateDockState({ dock: upgraded })).toBe(upgraded)
  })

  test("preserves intentionally empty v2 zones after built-in panes moved elsewhere", () => {
    const v2 = migrateDockState({})
    v2.schema = 2
    v2.left.tabs = ["review", "fileTree", "gitChanges", "terminal"]
    v2.left.active = "review"
    v2.right.tabs = []
    v2.right.active = undefined
    v2.bottom.tabs = []
    v2.bottom.active = undefined
    v2.items.review = { area: "left", visible: true }
    v2.items.fileTree = { area: "left", visible: false }
    v2.items.gitChanges = { area: "left", visible: false }
    v2.items.terminal = { area: "left", visible: false }

    const upgraded = migrateDockState({ dock: { ...v2, mobile: undefined } })

    expect(upgraded.left.tabs).toEqual(["review", "fileTree", "gitChanges", "terminal"])
    expect(upgraded.right).toMatchObject({ tabs: [], active: undefined })
    expect(upgraded.bottom).toMatchObject({ tabs: [], active: undefined })
    expect(upgraded.items.review.area).toBe("left")
    expect(upgraded.items.fileTree.area).toBe("left")
    expect(upgraded.items.gitChanges.area).toBe("left")
    expect(upgraded.items.terminal.area).toBe("left")
  })
})

describe("mobile dock sizing", () => {
  test("reserves composer space and never shrinks below the touch minimum", () => {
    expect(mobileDockMaxSize(844)).toBe(604)
    expect(mobileDockMaxSize(390)).toBe(150)
    expect(mobileDockMaxSize(300)).toBe(128)
  })

  test("closes for visual-only and content-resizing keyboards but not orientation or browser chrome", () => {
    expect(shouldCloseMobileDockForKeyboard(844, 500, 844, true)).toBe(true)
    expect(shouldCloseMobileDockForKeyboard(500, 500, 844, true)).toBe(true)
    expect(shouldCloseMobileDockForKeyboard(390, 390, 390, true)).toBe(false)
    expect(shouldCloseMobileDockForKeyboard(360, 330, 390, true)).toBe(false)
    expect(shouldCloseMobileDockForKeyboard(500, 500, 844, false)).toBe(false)
  })
})

describe("removeDockItemState", () => {
  test("removes a stale pane and repairs active state without touching valid panes", () => {
    const dock = migrateDockState({})
    dock.left.tabs = ["tab:stale", "tab:valid"]
    dock.left.active = "tab:stale"
    dock.right.tabs = ["tab:stale", "review"]
    dock.items["tab:stale"] = { area: "left", visible: true }
    dock.items["tab:valid"] = { area: "left", visible: true }
    dock.mobile.activeItem = "tab:stale"

    const next = removeDockItemState(dock, "tab:stale")

    expect(next.items["tab:stale"]).toBeUndefined()
    expect(next.items["tab:valid"]).toEqual({ area: "left", visible: true })
    expect(next.left.tabs).toEqual(["tab:valid"])
    expect(next.left.active).toBe("tab:valid")
    expect(next.right.tabs).toEqual(["review"])
    expect(next.mobile.activeItem).toBeUndefined()
    expect(dock.items["tab:stale"]).toBeDefined()
  })
})

describe("replaceDockItemState", () => {
  test("moves a reconciled session pane without losing placement or active state", () => {
    const dock = migrateDockState({})
    dock.left.tabs = ["tab:old", "plugin/pane"]
    dock.left.active = "tab:old"
    dock.items["tab:old"] = { area: "left", visible: true }
    dock.mobile.activeItem = "tab:old"

    const next = replaceDockItemState(dock, "tab:old", "tab:current")

    expect(next.left.tabs).toEqual(["tab:current", "plugin/pane"])
    expect(next.left.active).toBe("tab:current")
    expect(next.items["tab:current"]).toEqual({ area: "left", visible: true })
    expect(next.items["tab:old"]).toBeUndefined()
    expect(next.mobile.activeItem).toBe("tab:current")
  })

  test("removes a prematurely registered destination from another area", () => {
    const dock = migrateDockState({})
    dock.left.tabs = ["tab:old"]
    dock.left.active = "tab:old"
    dock.right.tabs = ["tab:current", "review"]
    dock.right.active = "tab:current"
    dock.items["tab:old"] = { area: "left", visible: true }
    dock.items["tab:current"] = { area: "right", visible: true }

    const next = replaceDockItemState(dock, "tab:old", "tab:current")

    expect(next.left.tabs).toEqual(["tab:current"])
    expect(next.right.tabs).toEqual(["review"])
    expect(next.right.active).toBe("review")
    expect(next.items["tab:current"]).toEqual({ area: "left", visible: true })
  })
})

describe("resolveDockActiveTab", () => {
  test("keeps an explicit active tab ahead of the previous tab", () => {
    expect(resolveDockActiveTab(["review", "browser"], "review", "browser")).toBe("review")
  })

  test("keeps the previous visible pane instead of falling back to the first tab", () => {
    expect(resolveDockActiveTab(["review", "browser"], undefined, "browser")).toBe("browser")
    expect(resolveDockActiveTab(["review", "browser"], "missing", "browser")).toBe("browser")
  })

  test("falls back to the first tab when active and previous are unavailable", () => {
    expect(resolveDockActiveTab(["review", "browser"], undefined, "terminal")).toBe("review")
    expect(resolveDockActiveTab([], undefined, "browser")).toBeUndefined()
  })
})

describe("shouldSyncDockActiveTab", () => {
  test("syncs only missing or unknown active values", () => {
    expect(shouldSyncDockActiveTab(["review", "browser"], undefined, "browser")).toBe(true)
    expect(shouldSyncDockActiveTab(["review", "browser"], "missing", "browser")).toBe(true)
    expect(shouldSyncDockActiveTab(["review", "browser"], "review", "browser")).toBe(false)
    expect(shouldSyncDockActiveTab(["review", "browser"], "browser", "browser")).toBe(false)
    expect(shouldSyncDockActiveTab(["review", "browser"], "missing", undefined)).toBe(false)
  })
})

describe("filterDockAddItems", () => {
  const items: DockAddMenuItemBase[] = [
    { id: "session", title: "Agent Chat", category: "Built-in", defaultArea: "middle" },
    { id: "terminal", title: "Terminal", category: "Built-in", defaultArea: "bottom" },
    {
      id: "qa/route",
      title: "QA Route",
      category: "Plugin qa",
      defaultArea: "middle",
      allowedAreas: ["middle"],
    },
  ]

  test("searches title, id, and category", () => {
    expect(filterDockAddItems(items, "left", "agent").map((item) => item.id)).toEqual(["session"])
    expect(filterDockAddItems(items, "left", "terminal").map((item) => item.id)).toEqual(["terminal"])
    expect(filterDockAddItems(items, "middle", "plugin qa").map((item) => item.id)).toEqual(["qa/route"])
  })

  test("respects allowed areas", () => {
    expect(filterDockAddItems(items, "left", "qa").map((item) => item.id)).toEqual([])
    expect(filterDockAddItems(items, "middle", "qa").map((item) => item.id)).toEqual(["qa/route"])
  })

  test("searches every area for the aggregated mobile launcher", () => {
    expect(filterDockAddItems(items, undefined, "qa").map((item) => item.id)).toEqual(["qa/route"])
  })
})
