import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/amazon-bedrock": async (options) => (await (() => import("@ai-sdk/amazon-bedrock").then((m) => m.createAmazonBedrock))())(options),
"@ai-sdk/amazon-bedrock/mantle": async (options) => (await (() => import("@ai-sdk/amazon-bedrock/mantle").then((m) => m.createBedrockMantle))())(options)
}
