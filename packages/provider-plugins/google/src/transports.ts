import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/google": async (options) => (await (() => import("@ai-sdk/google").then((m) => m.createGoogleGenerativeAI))())(options)
}
