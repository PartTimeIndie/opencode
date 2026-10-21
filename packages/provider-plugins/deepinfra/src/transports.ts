import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/deepinfra": async (options) => (await (() => import("@ai-sdk/deepinfra").then((m) => m.createDeepInfra))())(options)
}
