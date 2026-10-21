import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/gateway": async (options) => (await (() => import("@ai-sdk/gateway").then((m) => m.createGateway))())(options)
}
