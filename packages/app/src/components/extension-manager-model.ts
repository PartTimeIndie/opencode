export type ExtensionKind = "plugin" | "skill"

export type ExtensionItem = {
  id: string
  kind: ExtensionKind
  name: string
  target?: string
  targets?: string[]
  source: string
  scope: string
  spec?: string
  path?: string
  file?: string
  configFile?: string
  description?: string
  removable: boolean
  reason?: string
  availableIn?: string
}

export type ExtensionSortField = "name" | "target" | "source" | "location" | "availability" | "status"

export type ExtensionSortDirection = "asc" | "desc"

export function extensionTargetText(item: ExtensionItem) {
  if (item.targets?.length) return item.targets.join(", ")
  return item.target ?? "-"
}

export function extensionStatusText(item: ExtensionItem) {
  if (item.removable) return "Projektlokal"
  return item.reason ?? "Nicht projektlokal"
}

export function filterAndSortExtensions(
  items: ExtensionItem[],
  options: {
    query: string
    source?: string
    removable?: boolean
    sortBy: ExtensionSortField
    direction: ExtensionSortDirection
    availableIn?: (item: ExtensionItem) => string | undefined
  },
) {
  const query = options.query.trim().toLowerCase()
  const availableIn = (item: ExtensionItem) => options.availableIn?.(item) ?? item.availableIn
  const filtered = items.filter((item) => {
    if (options.source && item.source !== options.source) return false
    if (options.removable !== undefined && item.removable !== options.removable) return false
    if (!query) return true

    return [
      item.name,
      item.description,
      extensionTargetText(item),
      item.source,
      item.path,
      item.spec,
      availableIn(item),
      extensionStatusText(item),
      item.reason,
      item.scope,
    ].some((value) => value?.toLowerCase().includes(query))
  })

  return filtered.sort((left, right) => {
    const leftValue = extensionSortValue(left, options.sortBy, availableIn)
    const rightValue = extensionSortValue(right, options.sortBy, availableIn)
    const comparison = leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: "base" })
    if (comparison) return options.direction === "asc" ? comparison : -comparison

    return (
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }) ||
      left.id.localeCompare(right.id)
    )
  })
}

function extensionSortValue(
  item: ExtensionItem,
  field: ExtensionSortField,
  availableIn: (item: ExtensionItem) => string | undefined,
) {
  if (field === "name") return item.name
  if (field === "target") return extensionTargetText(item)
  if (field === "source") return item.source
  if (field === "location") return item.path ?? item.spec ?? ""
  if (field === "availability") return availableIn(item) ?? ""
  return extensionStatusText(item)
}
