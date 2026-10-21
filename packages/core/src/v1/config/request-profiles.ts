// One-time V1 migration semantics; current providers own their live request profiles.
export const legacyRequestProfiles = {
  "@ai-sdk/openai": {
    "namespace": "openai",
    "semantics": {
      "store": "store",
      "promptCacheKey": "promptCacheKey",
      "reasoning": "reasoning",
      "reasoningEffort": "reasoningEffort",
      "reasoningMode": "reasoningMode",
      "reasoningSummary": "reasoningSummary",
      "include": "include",
      "textVerbosity": "textVerbosity",
      "serviceTier": "serviceTier",
      "service_tier": "serviceTier"
    }
  },
  "@ai-sdk/openai-compatible": {
    "namespace": "openai",
    "semantics": {
      "store": "store",
      "promptCacheKey": "promptCacheKey",
      "reasoningEffort": "reasoningEffort",
      "reasoning_effort": "reasoningEffort"
    }
  },
  "@ai-sdk/anthropic": {
    "namespace": "anthropic",
    "semantics": {
      "thinking": "thinking"
    }
  },
  "@openrouter/ai-sdk-provider": {
    "namespace": "openrouter",
    "semantics": {
      "usage": "usage",
      "reasoning": "reasoning",
      "promptCacheKey": "promptCacheKey",
      "prompt_cache_key": "promptCacheKey"
    }
  }
} as const
