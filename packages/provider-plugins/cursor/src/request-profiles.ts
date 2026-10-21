import type { ProviderRequestProfile } from "@opencode-ai/plugin/provider"

export const requestProfiles = {
  "cursor-opencode-provider": {
    namespace: "cursor",
    semantics: {
      cursorVariantParameters: "cursorVariantParameters",
      cursorModelId: "cursorModelId",
      reasoningEffort: "reasoningEffort",
      maxMode: "maxMode",
      opencodeCompaction: "opencodeCompaction",
    },
  },
} satisfies Record<string, ProviderRequestProfile>
