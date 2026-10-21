import { configure } from "./configure"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { ProviderPluginModule, ProviderHost, ProviderAPI } from "@opencode-ai/plugin/provider"
import os from "os"

const providerID = "cloudflare-workers-ai"

export const CloudflareWorkersAIPlugin: ProviderPluginModule = {
  id: "cloudflare-workers-ai",
  configure,
  integrations: ["cloudflare-workers-ai"],
  async provider(api) {
    const credentials = api.credentials
    return {
      async "catalog.transform"(evt) {
        const account = await credentialOptions(credentials, "cloudflare-workers-ai")
        const item = evt.provider.get(providerID)
        if (!item) return
        evt.provider.update(item.provider.id, (provider) => {
          if (provider.api.type !== "aisdk") return
          if (provider.api.url) return
          const apiKey = stringOption(account, "apiKey")
          const accountIdOption = stringOption(account, "accountId")
          if (apiKey && !provider.request.body.apiKey) provider.request.body.apiKey = apiKey
          if (accountIdOption && !provider.request.body.accountId) provider.request.body.accountId = accountIdOption
          const accountId = resolveAccountId(provider.request.body)
          if (accountId) provider.api.url = workersEndpoint(accountId)
        })
      },
      async "aisdk.sdk"(evt) {
        if (evt.model.providerID !== providerID) return
        if (evt.package !== "@ai-sdk/openai-compatible") return

        const accountId = resolveAccountId(evt.options)
        if (!hasWorkersEndpoint(evt.model.api) && !accountId) return
        const mod = await import("@ai-sdk/openai-compatible")
        evt.sdk = mod.createOpenAICompatible(
          sdkOptions(api.app.version, {
            ...evt.options,
            baseURL: evt.options.baseURL ?? (accountId ? workersEndpoint(accountId) : undefined),
          }) as Parameters<typeof mod.createOpenAICompatible>[0],
        )
      },
      async "aisdk.language"(evt) {
        if (evt.model.providerID !== providerID) return
        evt.language = (evt.sdk as { languageModel(modelID: string): LanguageModelV3 }).languageModel(evt.model.api.id)
      },
    }
  },
}

function resolveAccountId(options: Record<string, unknown>) {
  return process.env.CLOUDFLARE_ACCOUNT_ID ?? stringOption(options, "accountId")
}

function workersEndpoint(accountId: string) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
}

function hasWorkersEndpoint(api: ProviderAPI) {
  return api.type === "aisdk" && Boolean(api.url)
}

function sdkOptions(version: string, options: Record<string, unknown>) {
  return {
    ...options,
    baseURL: expandAccountId(options.baseURL),
    apiKey: process.env.CLOUDFLARE_API_KEY ?? options.apiKey,
    headers: {
      "User-Agent": `opencode/${version} cloudflare-workers-ai (${os.platform()} ${os.release()}; ${os.arch()})`,
      ...(recordOption(options.headers) ?? {}),
    },
    name: providerID,
  }
}

function recordOption(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

async function credentialOptions(credentials: ProviderHost["credentials"], integrationID: string): Promise<Record<string, unknown>> {
  const latest = (await credentials.list(integrationID)).at(-1)
  return latest?.value.type === "key" ? { apiKey: latest.value.key, ...latest.value.metadata } : {}
}

function expandAccountId(baseURL: unknown) {
  if (typeof baseURL !== "string") return baseURL
  return baseURL.replaceAll("${CLOUDFLARE_ACCOUNT_ID}", process.env.CLOUDFLARE_ACCOUNT_ID ?? "${CLOUDFLARE_ACCOUNT_ID}")
}

function stringOption(options: Record<string, unknown>, key: string) {
  return typeof options[key] === "string" ? options[key] : undefined
}

export default CloudflareWorkersAIPlugin
