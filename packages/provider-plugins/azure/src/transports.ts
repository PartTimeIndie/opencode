import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/azure": async (options) => (await (() => import("@ai-sdk/azure").then((m) => m.createAzure))())(options)
}
