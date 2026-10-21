import type { ProviderRequestProfile } from "@opencode-ai/plugin/provider"

export const requestProfiles = {
  "@openrouter/ai-sdk-provider": {
    "namespace": "openrouter",
    "semantics": {
      "usage": "usage",
      "reasoning": "reasoning",
      "promptCacheKey": "promptCacheKey",
      "prompt_cache_key": "promptCacheKey"
    }
  }
} satisfies Record<string, ProviderRequestProfile>
