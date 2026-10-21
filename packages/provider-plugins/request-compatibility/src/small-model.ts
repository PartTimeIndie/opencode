import type { ProviderConfigurationRecord } from "@opencode-ai/plugin/provider"
export function selectSmallModel(provider: ProviderConfigurationRecord) {
  const providerID = provider.id
  const defaultPriority = [
    "claude-haiku-4-5",
    "claude-haiku-4.5",
    "3-5-haiku",
    "3.5-haiku",
    "gemini-3-flash",
    "gemini-2.5-flash",
    "gpt-5-nano",
  ]
  const priority = providerID.startsWith("opencode")
    ? ["gpt-5-nano"]
    : providerID.startsWith("github-copilot")
      ? ["gpt-5-mini", "claude-haiku-4.5", ...defaultPriority]
      : defaultPriority
  for (const item of priority) {
    if (providerID === "amazon-bedrock") {
      const crossRegionPrefixes = ["global.", "us.", "eu."]
      const candidates = Object.keys(provider.models).filter((m) => m.includes(item))

      const globalMatch = candidates.find((m) => m.startsWith("global."))
      if (globalMatch) return globalMatch

      const region = provider.options?.region
      if (typeof region === "string" && region) {
        const regionPrefix = region.split("-")[0]
        if (regionPrefix === "us" || regionPrefix === "eu") {
          const regionalMatch = candidates.find((m) => m.startsWith(`${regionPrefix}.`))
          if (regionalMatch) return regionalMatch
        }
      }

      const unprefixed = candidates.find((m) => !crossRegionPrefixes.some((p) => m.startsWith(p)))
      if (unprefixed) return unprefixed
    } else {
      for (const model of Object.keys(provider.models)) {
        if (model.includes(item)) return model
      }
    }
  }

  return undefined
}
