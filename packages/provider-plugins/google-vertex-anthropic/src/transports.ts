import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/google-vertex/anthropic": async (options) => (await (() =>
    import("@ai-sdk/google-vertex/anthropic").then((m) => m.createVertexAnthropic))())(options)
}
