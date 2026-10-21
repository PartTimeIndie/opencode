import type { DockArea } from "@/context/layout-dock"

export type DockAddMenuItemBase = {
  id: string
  title: string
  category: string
  defaultArea: DockArea
  allowedAreas?: DockArea[]
}

export function canDockInArea(item: Pick<DockAddMenuItemBase, "allowedAreas">, area: DockArea) {
  if (!item.allowedAreas?.length) return true
  return item.allowedAreas.includes(area)
}

export function filterDockAddItems<T extends DockAddMenuItemBase>(
  items: T[],
  area: DockArea | undefined,
  query: string,
) {
  const needle = query.trim().toLowerCase()
  return items.filter((item) => {
    if (area && !canDockInArea(item, area)) return false
    if (!needle) return true
    return `${item.title} ${item.id} ${item.category}`.toLowerCase().includes(needle)
  })
}
