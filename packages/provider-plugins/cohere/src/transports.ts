import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/cohere": async (options) => (await (() => import("@ai-sdk/cohere").then((m) => m.createCohere))())(options)
}
