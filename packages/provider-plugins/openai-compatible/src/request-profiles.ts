import type { ProviderRequestProfile } from "@opencode-ai/plugin/provider"

export const requestProfiles = {
  "@ai-sdk/openai-compatible": {
    "namespace": "openai",
    "semantics": {
      "store": "store",
      "promptCacheKey": "promptCacheKey",
      "reasoningEffort": "reasoningEffort",
      "reasoning_effort": "reasoningEffort"
    }
  }
} satisfies Record<string, ProviderRequestProfile>
