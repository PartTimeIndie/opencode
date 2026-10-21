import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/groq": async (options) => (await (() => import("@ai-sdk/groq").then((m) => m.createGroq))())(options)
}
