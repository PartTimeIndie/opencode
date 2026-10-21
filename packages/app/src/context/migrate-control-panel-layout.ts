import { DOCK_AREAS, migrateDockState, type DockItemState, type DockState, type DockArea } from "./layout-dock"
import { migrateControlPanels } from "./migrate-control-panels"
import { normalizeControlPanelClosedKey } from "./control-panel-key"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function migrateControlPanelLayout(input: Record<string, unknown>) {
  const rawDock = migrateDockState(input)
  const aliasTargets = new Set<string>()
  const normalizeID = (id: string) => {
    const normalized = normalizeControlPanelClosedKey(id)
    if (normalized !== id) aliasTargets.add(normalized)
    return normalized
  }
  const itemGroups = new Map<string, { sourceID: string; item: DockItemState }[]>()
  for (const [sourceID, item] of Object.entries(rawDock.items)) {
    const id = normalizeID(sourceID)
    itemGroups.set(id, [...(itemGroups.get(id) ?? []), { sourceID, item }])
  }
  const items = Object.fromEntries(
    [...itemGroups.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([id, candidates]) => {
        const winner = candidates.toSorted(
          (left, right) =>
            Number(right.sourceID === id) - Number(left.sourceID === id) ||
            (left.sourceID < right.sourceID ? -1 : left.sourceID > right.sourceID ? 1 : 0),
        )[0]
        return [id, winner.item]
      }),
  ) as Record<string, DockItemState>
  const tabOccurrences = new Map<string, { area: DockArea; sourceID: string }[]>()
  for (const area of DOCK_AREAS) {
    for (const sourceID of rawDock[area].tabs) {
      const id = normalizeID(sourceID)
      tabOccurrences.set(id, [...(tabOccurrences.get(id) ?? []), { area, sourceID }])
    }
  }
  const orderedAliasTargets = [...aliasTargets].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
  const aliasAreas = new Map<string, DockArea>()
  for (const id of orderedAliasTargets) {
    const occurrences = tabOccurrences.get(id) ?? []
    const area =
      items[id]?.area ??
      occurrences.toSorted(
        (left, right) =>
          Number(right.sourceID === id) - Number(left.sourceID === id) ||
          (left.sourceID < right.sourceID ? -1 : left.sourceID > right.sourceID ? 1 : 0) ||
          DOCK_AREAS.indexOf(left.area) - DOCK_AREAS.indexOf(right.area),
      )[0]?.area
    if (area) aliasAreas.set(id, area)
  }
  let changed = false
  const remapTabs = (area: DockArea, sourceTabs: string[]) => {
    const seen = new Set<string>()
    const tabs = sourceTabs.flatMap((sourceID) => {
      const id = normalizeID(sourceID)
      if (aliasAreas.has(id) && aliasAreas.get(id) !== area) return []
      if (seen.has(id)) return []
      seen.add(id)
      return [id]
    })
    for (const id of orderedAliasTargets) {
      if (aliasAreas.get(id) !== area || !tabOccurrences.has(id) || seen.has(id)) continue
      seen.add(id)
      tabs.push(id)
    }
    return tabs
  }
  const sameIDs = (left: string[], right: string[]) =>
    left.length === right.length && left.every((id, index) => id === right[index])
  const dock: DockState = { ...rawDock }
  for (const area of DOCK_AREAS) {
    const zone = rawDock[area]
    const tabs = remapTabs(area, zone.tabs)
    let active = typeof zone.active === "string" ? normalizeID(zone.active) : zone.active
    if (typeof active === "string" && !tabs.includes(active)) active = tabs[0]
    if (!sameIDs(tabs, zone.tabs) || active !== zone.active) {
      changed = true
      dock[area] = { ...zone, tabs, active }
    }
  }
  const sameItems =
    sameIDs(Object.keys(items).sort(), Object.keys(rawDock.items).sort()) &&
    Object.entries(items).every(
      ([id, item]) => item.area === rawDock.items[id]?.area && item.visible === rawDock.items[id]?.visible,
    )
  if (!sameItems) changed = true
  dock.items = items
  if (typeof rawDock.mobile.activeItem === "string") {
    const activeItem = normalizeID(rawDock.mobile.activeItem)
    if (activeItem !== rawDock.mobile.activeItem) {
      changed = true
      dock.mobile = { ...rawDock.mobile, activeItem }
    }
  }
  const migratedDock = changed ? dock : rawDock
  return {
    rawDock,
    dock: migratedDock,
    dockChanged: migratedDock !== input.dock,
    controlPanels: migrateControlPanels(input.controlPanels),
  }
}
