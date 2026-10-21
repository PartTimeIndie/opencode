import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/github-copilot": async (options) => (await (() =>
    import("./transport/copilot-provider").then((m) => m.createOpenaiCompatible))())(options)
}
