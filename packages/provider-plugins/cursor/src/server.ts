import { CursorAuthPlugin } from "./server/cursor"
import type { PluginModule } from "@opencode-ai/plugin"
import { CursorPlugin } from "./upstream/plugin.js"

export default {
  id: "@opencode-ai/provider-cursor",
  async server(input) {
    const hooks = await CursorPlugin(input)
    const authentication = await CursorAuthPlugin(input)
    return {
      ...hooks,
      auth: { ...hooks.auth!, methods: authentication.auth!.methods },
      async config(config) {
        await hooks.config?.(config)
        // The independently bundled server entry is separate from the AI SDK factory.
        if (config.provider?.cursor) config.provider.cursor.npm = new URL("./adapter.js", import.meta.url).href
      },
    }
  },
} satisfies PluginModule
