export const APP_PLUGIN_SETTINGS_CHANGED = "opencode:app-plugin-settings"
export const APP_PLUGIN_SETTINGS_ITEM_CHANGED = "opencode:app-plugin-settings-item"

export function dispatchAppPluginSettingsChanged(pluginID: string, key: string) {
  window.dispatchEvent(new CustomEvent(APP_PLUGIN_SETTINGS_CHANGED, { detail: { pluginID, key } }))
}

export function dispatchAppPluginSettingsItemChanged(pluginID: string) {
  window.dispatchEvent(new CustomEvent(APP_PLUGIN_SETTINGS_ITEM_CHANGED, { detail: { pluginID } }))
}

export function subscribeAppPluginSettingsChanges(onChange: (pluginID?: string) => void) {
  const listener = (event: Event) => {
    const detail = event instanceof CustomEvent ? (event.detail as { pluginID?: unknown } | undefined) : undefined
    onChange(typeof detail?.pluginID === "string" ? detail.pluginID : undefined)
  }

  window.addEventListener(APP_PLUGIN_SETTINGS_CHANGED, listener)
  window.addEventListener(APP_PLUGIN_SETTINGS_ITEM_CHANGED, listener)
  return () => {
    window.removeEventListener(APP_PLUGIN_SETTINGS_CHANGED, listener)
    window.removeEventListener(APP_PLUGIN_SETTINGS_ITEM_CHANGED, listener)
  }
}
