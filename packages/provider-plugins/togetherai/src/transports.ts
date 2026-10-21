import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/togetherai": async (options) => (await (() => import("@ai-sdk/togetherai").then((m) => m.createTogetherAI))())(options)
}
