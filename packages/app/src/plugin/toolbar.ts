export type ToolbarPlacement = "top" | "composer"
export type ToolbarAlign = "left" | "right"

export type ToolbarContext = {
  placement: ToolbarPlacement
  align: ToolbarAlign
  directory?: string
  sessionID?: string
  composerID?: string
}

export type ToolbarItemLike = {
  id: string
  title: string
  placement?: ToolbarPlacement
  align?: ToolbarAlign
  order?: number
  visible?: (context: ToolbarContext) => boolean
  enabled?: (context: ToolbarContext) => boolean
}

export type ToolbarOrderState = {
  version: 1
  global: string[]
  projects: Record<string, string[]>
}

export function toolbarPlacement(item: Pick<ToolbarItemLike, "placement">): ToolbarPlacement {
  return item.placement ?? "top"
}

export function toolbarAlign(item: Pick<ToolbarItemLike, "placement" | "align">): ToolbarAlign {
  return item.align ?? (toolbarPlacement(item) === "composer" ? "left" : "right")
}

export function filterToolbarItems<T extends ToolbarItemLike>(
  items: T[],
  context: ToolbarContext,
  order: string[] = [],
) {
  return orderToolbarItems(
    items
      .filter((item) => toolbarPlacement(item) === context.placement)
      .filter((item) => toolbarAlign(item) === context.align)
      .filter((item) => item.visible?.(context) ?? true),
    order,
  )
}

export function orderToolbarItems<T extends ToolbarItemLike>(items: T[], order: string[] = []) {
  const positions = new Map(order.map((id, index) => [id, index]))
  return items.toSorted((a, b) => {
    if (positions.has(a.id) && positions.has(b.id)) return positions.get(a.id)! - positions.get(b.id)!
    if (positions.has(a.id)) return -1
    if (positions.has(b.id)) return 1
    return (a.order ?? 1000) - (b.order ?? 1000) || a.title.localeCompare(b.title)
  })
}

export function moveToolbarItemIDs(items: ToolbarItemLike[], id: string, direction: "up" | "down") {
  const ids = items.map((item) => item.id)
  const current = items.findIndex((item) => item.id === id)
  if (current === -1) return ids
  const group = `${toolbarPlacement(items[current]!)}:${toolbarAlign(items[current]!)}`
  const target =
    direction === "up"
      ? items.findLastIndex(
          (item, index) => index < current && `${toolbarPlacement(item)}:${toolbarAlign(item)}` === group,
        )
      : items.findIndex(
          (item, index) => index > current && `${toolbarPlacement(item)}:${toolbarAlign(item)}` === group,
        )
  if (target === -1) return ids
  return ids.map((value, index) => {
    if (index === current) return ids[target]!
    if (index === target) return ids[current]!
    return value
  })
}

export function toolbarItemEnabled(item: Pick<ToolbarItemLike, "enabled">, context: ToolbarContext) {
  return item.enabled?.(context) ?? true
}
