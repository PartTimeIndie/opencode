import type { AppSettingsField } from "@opencode-ai/plugin/app"

export function readPluginSetting(value: unknown, path: readonly (string | number)[], fallback: unknown): unknown {
  if (!path.length) return value === undefined ? fallback : value
  if (!value || typeof value !== "object") return fallback
  const [key, ...rest] = path
  if (!Object.prototype.hasOwnProperty.call(value, key!)) return fallback
  return readPluginSetting((value as Record<string | number, unknown>)[key!], rest, fallback)
}

export function updatePluginSetting(value: unknown, path: readonly (string | number)[], next: unknown): unknown {
  if (!path.length) return next
  const [key, ...rest] = path
  if (typeof key === "number") {
    const items = Array.isArray(value) ? [...value] : []
    items[key] = updatePluginSetting(items[key], rest, next)
    return items
  }
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  return { ...record, [key!]: updatePluginSetting(readPluginSetting(record, [key!], undefined), rest, next) }
}

export function pluginSettingDefaults(fields: readonly AppSettingsField[]) {
  // Overlay fields are pure layout containers without a stored value.
  return Object.fromEntries(
    fields.filter((field) => field.type !== "overlay").map((field) => [field.key, structuredClone(field.default)]),
  )
}

/** Overlay fields are layout containers; their children stay flat settings fields. */
export function pluginSettingsLeafFields(
  fields: readonly AppSettingsField[],
): Exclude<AppSettingsField, { type: "overlay" }>[] {
  return fields.flatMap((field) => (field.type === "overlay" ? pluginSettingsLeafFields(field.fields) : [field]))
}

export function createPluginSettingItem(field: Extract<AppSettingsField, { type: "list" }>, items: Record<string, unknown>[]) {
  const next = field.createItem ? field.createItem(structuredClone(items)) : pluginSettingDefaults(field.fields)
  if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("A plugin settings list item must be an object")
  return structuredClone(next)
}
