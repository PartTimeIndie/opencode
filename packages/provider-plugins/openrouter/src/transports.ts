import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@openrouter/ai-sdk-provider": async (options) => (await (() => import("@openrouter/ai-sdk-provider").then((m) => m.createOpenRouter))())(options)
}
