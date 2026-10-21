import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/perplexity": async (options) => (await (() => import("@ai-sdk/perplexity").then((m) => m.createPerplexity))())(options)
}
