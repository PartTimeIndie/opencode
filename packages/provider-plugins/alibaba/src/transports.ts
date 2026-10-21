import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/alibaba": async (options) => (await (() => import("@ai-sdk/alibaba").then((m) => m.createAlibaba))())(options)
}
