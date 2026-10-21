import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/anthropic": async (options) => (await (() => import("@ai-sdk/anthropic").then((m) => m.createAnthropic))())(options)
}
