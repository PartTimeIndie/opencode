import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/google-vertex": async (options) => (await (() => import("@ai-sdk/google-vertex").then((m) => m.createVertex))())(options)
}
