import type { Usage } from "@opencode-ai/llm"

/** Report only numeric counters from the provider's retained raw usage, never
 * response text, account metadata or headers. Missing counters stay unknown. */
export function cacheUsage(usage: Usage | undefined) {
  const raw = usage?.providerMetadata?.openai
  const details = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.input_tokens_details : undefined
  const inputTokens = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.input_tokens : undefined
  const cachedTokens = details && typeof details === "object" && !Array.isArray(details) && "cached_tokens" in details ? details.cached_tokens : undefined
  if (typeof inputTokens !== "number" || typeof cachedTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens <= 0 ||
    !Number.isSafeInteger(cachedTokens) || cachedTokens < 0 || cachedTokens > inputTokens)
    return { inputTokens: undefined, cacheReadInputTokens: undefined, rawUsageVerified: false }
  if (usage?.inputTokens !== inputTokens || usage.cacheReadInputTokens !== cachedTokens)
    throw new Error("Mapped cache usage differs from the provider counters")
  return { inputTokens, cacheReadInputTokens: cachedTokens, rawUsageVerified: true }
}
