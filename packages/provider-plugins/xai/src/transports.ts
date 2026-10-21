import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/xai": async (options) => (await (() => import("@ai-sdk/xai").then((m) => m.createXai))())(options)
}
