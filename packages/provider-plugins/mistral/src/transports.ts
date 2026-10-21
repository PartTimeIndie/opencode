import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/mistral": async (options) => (await (() => import("@ai-sdk/mistral").then((m) => m.createMistral))())(options)
}
