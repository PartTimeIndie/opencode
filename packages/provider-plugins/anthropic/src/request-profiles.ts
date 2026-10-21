import type { ProviderRequestProfile } from "@opencode-ai/plugin/provider"

export const requestProfiles = {
  "@ai-sdk/anthropic": {
    "namespace": "anthropic",
    "semantics": {
      "thinking": "thinking"
    }
  }
} satisfies Record<string, ProviderRequestProfile>
