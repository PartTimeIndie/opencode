import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
import { createSDK } from "./sdk"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
  "@ai-sdk/cerebras": createSDK,
}
