import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"gitlab-ai-provider": async (options) => (await (() => import("gitlab-ai-provider").then((m) => m.createGitLab))())(options)
}
