import type { ProviderCredential } from "@opencode-ai/plugin/provider"
export function tokenFromCredential(value: ProviderCredential | undefined) {
  if (!value) return
  return value.type === "oauth" ? value.access || undefined : value.key || undefined
}

export function applyToken(options: Record<string, unknown>, token: string) {
  if (token.startsWith("crsr_")) {
    options.apiKey = token
    return
  }
  options.accessToken = token
}

