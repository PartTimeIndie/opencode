import { createStore } from "solid-js/store"

export function createPluginSettingsRevisions() {
  const [state, setState] = createStore({
    global: 0,
    plugins: {} as Record<string, number>,
  })

  return {
    get(pluginID: string) {
      return state.global + (state.plugins[pluginID] ?? 0)
    },
    bump(pluginID?: string) {
      if (!pluginID) {
        setState("global", (value) => value + 1)
        return
      }
      setState("plugins", pluginID, (value) => (value ?? 0) + 1)
    },
  }
}
