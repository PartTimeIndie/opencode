import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/openai": async (options) => (await (() => import("@ai-sdk/openai").then((m) => m.createOpenAI))())(options)
}
