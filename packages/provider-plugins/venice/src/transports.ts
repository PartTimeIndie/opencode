import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"venice-ai-sdk-provider": async (options) => (await (() => import("venice-ai-sdk-provider").then((m) => m.createVenice))())(options)
}
