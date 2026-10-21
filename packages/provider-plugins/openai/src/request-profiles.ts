import type { ProviderRequestProfile } from "@opencode-ai/plugin/provider"

export const requestProfiles = {
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
  }
} satisfies Record<string, ProviderRequestProfile>
