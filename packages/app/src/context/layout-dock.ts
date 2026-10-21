const DEFAULT_FILE_TREE_WIDTH = 200
const DEFAULT_SESSION_WIDTH = 600
const DEFAULT_TERMINAL_HEIGHT = 280
const DEFAULT_DOCK_TOP_HEIGHT = 160
const DEFAULT_DOCK_SIDE_WIDTH = 280

export const BUILTIN_DOCK_PANES = [
  "session",
  "review",
  "terminal",
  "fileTree",
  "gitChanges",
  "pluginManager",
  "usage",
  "browser",
] as const

export const DOCK_AREAS = ["top", "left", "middle", "right", "bottom"] as const
export type DockArea = (typeof DOCK_AREAS)[number]
export const MOBILE_DOCK_MEDIA_QUERY = "(max-width: 767px), (pointer: coarse) and (max-height: 600px)"
export const DEFAULT_MOBILE_DOCK_SIZE = 320
export const MOBILE_DOCK_MIN_SIZE = 128
export const MOBILE_DOCK_COLLAPSE_THRESHOLD = 96
export const MOBILE_DOCK_VIEWPORT_RESERVE = 240
export const MOBILE_BROWSER_DOCK_MIN_SIZE = 440
const MOBILE_DOCK_IME_MIN_INSET = 96

export function mobileDockMaxSize(viewportHeight: number) {
  return Math.max(MOBILE_DOCK_MIN_SIZE, viewportHeight - MOBILE_DOCK_VIEWPORT_RESERVE)
}

export function shouldCloseMobileDockForKeyboard(
  layoutHeight: number,
  visualHeight: number,
  baselineHeight: number,
  inputFocused: boolean,
) {
  if (!inputFocused) return false
  return (
    Math.max(
      baselineHeight - layoutHeight,
      layoutHeight - visualHeight,
      baselineHeight - visualHeight,
    ) >= MOBILE_DOCK_IME_MIN_INSET
  )
}

export type DockZoneState = {
  visible: boolean
  size: number
  tabs: string[]
  active?: string
}

export type DockItemState = {
  area: DockArea
  visible: boolean
}

export type DockItemRequest = {
  area?: DockArea
  reveal?: boolean
}

export type MobileDockState = {
  size: number
  activeItem?: string
}

export type DockState = Record<DockArea, DockZoneState> & {
  items: Record<string, DockItemState>
  mobile: MobileDockState
  schema?: number
}

export function resolveDockActiveTab(
  tabs: string[],
  active: string | undefined,
  previous?: string,
  passive?: string[],
) {
  if (active && tabs.includes(active)) return active
  if (previous && tabs.includes(previous)) return previous
  if (!passive?.length) return tabs[0]
  // Passive panes (e.g. the browser) never become the resolved fallback on
  // their own; they only stay active after an explicit activation.
  return tabs.find((item) => !passive.includes(item))
}

export function shouldSyncDockActiveTab(tabs: string[], active: string | undefined, resolved: string | undefined) {
  if (!resolved || active === resolved) return false
  return !active || !tabs.includes(active)
}

export function repairedActiveAfterClose(
  tabs: string[],
  active: string | undefined,
  closedID: string,
  isVisible: (id: string) => boolean,
  options?: { isRenderable?: (id: string) => boolean; passive?: readonly string[] },
) {
  if (active !== closedID) return active
  const remaining = tabs.filter((id) => id !== closedID)
  const visible = remaining.filter((id) => isVisible(id))
  const candidates = options?.isRenderable
    ? visible.filter(options.isRenderable)
    : visible.length > 0
      ? visible
      : remaining
  if (!options?.passive?.length) return candidates[0]
  return candidates.find((id) => !options.passive!.includes(id)) ?? candidates[0]
}

export function dockItemIsRendered(input: {
  id: string
  area: DockArea
  itemVisible: boolean
  mobile: boolean
  mobileOpened: boolean
  mobileActiveItem?: string
  areaVisible: boolean
  areaActiveItem?: string
}) {
  if (!input.itemVisible) return false
  if (input.mobile) return input.mobileOpened && input.mobileActiveItem === input.id
  if (input.area === "middle") return input.areaActiveItem === input.id
  return input.areaVisible && input.areaActiveItem === input.id
}

export function removeDockItemState(dock: DockState, id: string): DockState {
  const zone = (area: DockArea) => {
    const tabs = dock[area].tabs.filter((item) => item !== id)
    return {
      ...dock[area],
      tabs,
      active: dock[area].active === id ? tabs[0] : dock[area].active,
    }
  }
  const items = { ...dock.items }
  delete items[id]
  return {
    ...dock,
    top: zone("top"),
    left: zone("left"),
    middle: zone("middle"),
    right: zone("right"),
    bottom: zone("bottom"),
    mobile: {
      ...dock.mobile,
      activeItem: dock.mobile.activeItem === id ? undefined : dock.mobile.activeItem,
    },
    items,
  }
}

export function replaceDockItemState(dock: DockState, from: string, to: string): DockState {
  if (from === to || !dock.items[from]) return dock
  const source = dock.items[from]
  const zone = (area: DockArea) => {
    const seen = new Set<string>()
    const tabs = dock[area].tabs
      .flatMap((item) => {
        if (item === from) return [to]
        if (item === to) return []
        return [item]
      })
      .filter((item) => {
        if (seen.has(item)) return false
        seen.add(item)
        return true
      })
    return {
      ...dock[area],
      tabs,
      active:
        dock[area].active === from ? to : dock[area].active === to && !tabs.includes(to) ? tabs[0] : dock[area].active,
    }
  }
  const items = { ...dock.items, [to]: source }
  delete items[from]
  return {
    ...dock,
    top: zone("top"),
    left: zone("left"),
    middle: zone("middle"),
    right: zone("right"),
    bottom: zone("bottom"),
    mobile: {
      ...dock.mobile,
      activeItem: dock.mobile.activeItem === from ? to : dock.mobile.activeItem,
    },
    items,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function readBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback
}

function readNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function readStringList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback
  if (value.length === 0) return []
  const list = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  if (list.length === 0) return fallback
  return list
}

function isDockArea(value: unknown): value is DockArea {
  return typeof value === "string" && DOCK_AREAS.includes(value as DockArea)
}

function isDockZoneState(value: unknown): value is DockZoneState {
  return (
    isRecord(value) &&
    typeof value.visible === "boolean" &&
    typeof value.size === "number" &&
    Array.isArray(value.tabs) &&
    value.tabs.every((item) => typeof item === "string") &&
    (value.active === undefined || typeof value.active === "string")
  )
}

function isDockItemState(value: unknown): value is DockItemState {
  return isRecord(value) && isDockArea(value.area) && typeof value.visible === "boolean"
}

function isMobileDockState(value: unknown): value is MobileDockState {
  return (
    isRecord(value) &&
    typeof value.size === "number" &&
    Number.isFinite(value.size) &&
    (value.activeItem === undefined || typeof value.activeItem === "string")
  )
}

function isDockState(value: unknown): value is DockState {
  return (
    isRecord(value) &&
    DOCK_AREAS.every((area) => isDockZoneState(value[area])) &&
    isRecord(value.items) &&
    Object.values(value.items).every(isDockItemState) &&
    isMobileDockState(value.mobile)
  )
}

function readDockZone(
  dock: Record<string, unknown> | undefined,
  area: DockArea,
  fallback: DockZoneState,
): DockZoneState {
  const zone = isRecord(dock?.[area]) ? dock[area] : undefined
  const tabs = readStringList(zone?.tabs, fallback.tabs)
  const active = readString(zone?.active) ?? (Array.isArray(zone?.tabs) ? undefined : fallback.active)
  return {
    visible: readBoolean(zone?.visible, fallback.visible),
    size: readNumber(zone?.size, fallback.size),
    tabs,
    active: active && tabs.includes(active) ? active : tabs[0],
  }
}

function readDockItem(items: Record<string, unknown> | undefined, id: string, fallback: DockItemState): DockItemState {
  const item = isRecord(items?.[id]) ? items[id] : undefined
  return {
    area: isDockArea(item?.area) ? item.area : fallback.area,
    visible: readBoolean(item?.visible, fallback.visible),
  }
}

function readMobileDock(dock: Record<string, unknown> | undefined): MobileDockState {
  const mobile = isRecord(dock?.mobile) ? dock.mobile : undefined
  return {
    size: Math.max(MOBILE_DOCK_MIN_SIZE, readNumber(mobile?.size, DEFAULT_MOBILE_DOCK_SIZE)),
    activeItem: readString(mobile?.activeItem),
  }
}

const DEFAULT_DOCK_ITEMS = {
  session: { area: "middle", visible: true },
  terminal: { area: "bottom", visible: false },
  review: { area: "right", visible: true },
  fileTree: { area: "right", visible: false },
  gitChanges: { area: "right", visible: false },
} satisfies Record<string, DockItemState>

function addDockTab(zone: DockZoneState, id: string) {
  if (zone.tabs.includes(id)) return zone
  return {
    ...zone,
    tabs: [...zone.tabs, id],
  }
}

function readDockItems(items: Record<string, unknown> | undefined, defaults: Record<string, DockItemState>) {
  return {
    ...Object.fromEntries(
      Object.entries(items ?? {}).filter((entry): entry is [string, DockItemState] => isDockItemState(entry[1])),
    ),
    ...Object.fromEntries(Object.entries(defaults).map(([id, fallback]) => [id, readDockItem(items, id, fallback)])),
  }
}

function normalizeDockState(dock: DockState): DockState {
  const items = readDockItems(dock.items, DEFAULT_DOCK_ITEMS)
  const middle = addDockTab(dock.middle, "session")
  return {
    ...dock,
    schema: DOCK_SCHEMA_VERSION,
    mobile: readMobileDock(dock),
    middle: {
      ...middle,
      visible: true,
      active: middle.active ?? "session",
    },
    items: {
      ...items,
      session: {
        ...items.session,
        visible: true,
      },
    },
  }
}

function isNormalizedDockState(dock: DockState) {
  return (
    dock.schema === DOCK_SCHEMA_VERSION &&
    dock.mobile.size >= MOBILE_DOCK_MIN_SIZE &&
    dock.middle.visible &&
    dock.middle.tabs.includes("session") &&
    dock.items.session?.visible === true
  )
}

// Persistent layout storage carries a `dock.schema` version tag. Bump it
// when `DockState` shape changes so `migrateDockState` can re-derive from
// legacy state once, then short-circuit on subsequent loads.
export const DOCK_SCHEMA_VERSION = 3

export function migrateDockState(value: Record<string, unknown>): DockState {
  // Already on the current schema — trust the persisted dock verbatim.
  // Legacy flags (terminal.opened, review.panelOpened, ...) are no longer
  // consulted once a versioned dock exists, so partial migrations can't
  // resurrect closed panes on the next load.
  const persistedDock = isRecord(value.dock) ? value.dock : undefined
  if (persistedDock?.schema === DOCK_SCHEMA_VERSION && isDockState(persistedDock)) {
    if (isNormalizedDockState(persistedDock)) return persistedDock
    return normalizeDockState(persistedDock)
  }

  const dock = persistedDock
  const items = isRecord(dock?.items) ? dock.items : undefined
  const terminal = isRecord(value.terminal) ? value.terminal : undefined
  const review = isRecord(value.review) ? value.review : undefined
  const fileTree = isRecord(value.fileTree) ? value.fileTree : undefined
  const session = isRecord(value.session) ? value.session : undefined
  const terminalVisible = readBoolean(terminal?.opened, false)
  const reviewVisible = readBoolean(review?.panelOpened, true)
  const fileTreeVisible = readBoolean(fileTree?.opened, false)
  const rightVisible = reviewVisible || fileTreeVisible
  const rightActive = fileTreeVisible ? (fileTree?.tab === "all" ? "fileTree" : "gitChanges") : "review"

  return normalizeDockState({
    schema: DOCK_SCHEMA_VERSION,
    top: readDockZone(dock, "top", {
      visible: false,
      size: DEFAULT_DOCK_TOP_HEIGHT,
      tabs: [],
    }),
    left: readDockZone(dock, "left", {
      visible: false,
      size: DEFAULT_DOCK_SIDE_WIDTH,
      tabs: [],
    }),
    middle: readDockZone(dock, "middle", {
      visible: true,
      size: readNumber(session?.width, DEFAULT_SESSION_WIDTH),
      tabs: ["session"],
      active: "session",
    }),
    right: readDockZone(dock, "right", {
      visible: rightVisible,
      size: readNumber(fileTree?.width, DEFAULT_FILE_TREE_WIDTH),
      tabs: ["review", "fileTree", "gitChanges"],
      active: rightActive,
    }),
    bottom: readDockZone(dock, "bottom", {
      visible: terminalVisible,
      size: readNumber(terminal?.height, DEFAULT_TERMINAL_HEIGHT),
      tabs: ["terminal"],
      active: "terminal",
    }),
    mobile: readMobileDock(dock),
    items: readDockItems(items, {
      ...DEFAULT_DOCK_ITEMS,
      terminal: { area: "bottom", visible: terminalVisible },
      review: { area: "right", visible: reviewVisible },
      fileTree: { area: "right", visible: fileTreeVisible },
      gitChanges: { area: "right", visible: fileTreeVisible },
    }),
  })
}
