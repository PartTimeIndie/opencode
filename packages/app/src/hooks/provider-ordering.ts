export const popularProviders = [
  "opencode",
  "opencode-go",
  "anthropic",
  "github-copilot",
  "cursor",
  "openai",
  "google",
  "openrouter",
  "vercel",
]

export const popularProviderSet = new Set(popularProviders)

export function opencodeHasPaidModel(models: Record<string, { cost?: { input?: number } }>) {
  return Object.values(models).some((model) => (model.cost?.input ?? 0) > 0)
}

type ProviderSortItem = { id: string; name: string }

export function sortProviderList<T extends ProviderSortItem>(providers: Iterable<T>) {
  return Array.from(providers).sort((a, b) => {
    const priority = providerPriority(a.id) - providerPriority(b.id)
    if (priority !== 0) return priority
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  })
}

function providerPriority(id: string) {
  const index = popularProviders.indexOf(id)
  return index === -1 ? popularProviders.length : index
}
