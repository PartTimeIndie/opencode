import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/vercel": async (options) => (await (() => import("@ai-sdk/vercel").then((m) => m.createVercel))())(options)
}
