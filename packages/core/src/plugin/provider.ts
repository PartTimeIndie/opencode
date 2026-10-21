/** Preinstallation is declarative; these packages use the public loader. */
export const ProviderPackages = [
  "request-compatibility",
  "alibaba", "amazon-bedrock", "anthropic", "azure-cognitive-services", "azure", "cerebras",
  "cloudflare-ai-gateway", "cloudflare-workers-ai", "cohere", "cursor", "deepinfra", "gateway",
  "github-copilot", "gitlab", "google", "google-vertex-anthropic", "google-vertex", "groq", "kilo", "lmstudio",
  "llmgateway", "mistral", "nvidia", "opencode", "snowflake-cortex", "openai-compatible", "openai",
  "openrouter", "perplexity", "sap-ai-core", "togetherai", "vercel", "venice", "xai", "zenmux", "dynamic",
] as const

/** One-time legacy data imports, retaining the source for rollback. */
export const ProviderCacheMigrations = [{ owner: "cursor", source: "cursor-models.json", target: "cursor-models.json" }] as const
