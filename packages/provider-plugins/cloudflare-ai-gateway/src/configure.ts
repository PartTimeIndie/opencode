import os from "node:os"
import type { ProviderPluginModule, ProviderConfigurationResult, ProviderTransport } from "@opencode-ai/plugin/provider"
import type { ProviderConfigurationModel, ProviderConfigurationRecord } from "@opencode-ai/plugin/provider"
type Model = ProviderConfigurationModel
type Provider = ProviderConfigurationRecord
type Info = Provider
type ProviderSDK = ProviderTransport
type ProviderOptions = Record<string, unknown>

export const configure: NonNullable<ProviderPluginModule["configure"]> = async (input, dep) => {
  const loader: (provider: Info) => Promise<ProviderConfigurationResult> = async function (input: Info) {
    // When baseURL is already configured (e.g. corporate config), skip the ID checks.
    if (input.options?.baseURL) return { autoload: false }

    const auth = await dep.auth(input.id)
    const env = await dep.env()
    const accountId = env["CLOUDFLARE_ACCOUNT_ID"] || (auth?.type === "api" ? auth.metadata?.accountId : undefined)
    // The Cloudflare auth prompt stores this value as gatewayId metadata.
    const gateway = env["CLOUDFLARE_GATEWAY_ID"] || (auth?.type === "api" ? auth.metadata?.gatewayId : undefined)

    if (!accountId || !gateway) {
      const missing = [
        !accountId ? "CLOUDFLARE_ACCOUNT_ID" : undefined,
        !gateway ? "CLOUDFLARE_GATEWAY_ID" : undefined,
      ].filter((x): x is string => Boolean(x))
      return {
        autoload: false,
        async getModel() {
          throw new Error(
            `${missing.join(" and ")} missing. Set with: ${missing.map((x) => `export ${x}=<value>`).join(" && ")}`,
          )
        },
      }
    }

    // Get API token from env or auth - required for authenticated gateways
    const apiToken = env["CLOUDFLARE_API_TOKEN"] || env["CF_AIG_TOKEN"] || (auth?.type === "api" ? auth.key : undefined)

    if (!apiToken) {
      throw new Error(
        "CLOUDFLARE_API_TOKEN (or CF_AIG_TOKEN) is required for Cloudflare AI Gateway. " +
          "Set it via environment variable or run `opencode auth cloudflare-ai-gateway`.",
      )
    }

    // Use official ai-gateway-provider package (v2.x for AI SDK v5 compatibility)
    const { createAiGateway } = await import("ai-gateway-provider")
    const { createUnified } = await import("ai-gateway-provider/providers/unified")

    const metadata = iife(() => {
      if (input.options?.metadata) return input.options.metadata
      try {
        return JSON.parse(String((input.options.headers as Record<string, unknown> | undefined)?.["cf-aig-metadata"]))
      } catch {
        return undefined
      }
    })
    const opts = {
      metadata,
      cacheTtl: input.options?.cacheTtl,
      cacheKey: input.options?.cacheKey,
      skipCache: input.options?.skipCache,
      collectLog: input.options?.collectLog,
      headers: {
        "User-Agent": `opencode/${dep.version} cloudflare-ai-gateway (${os.platform()} ${os.release()}; ${os.arch()})`,
      },
    }

    const aigateway = createAiGateway({
      accountId,
      gateway,
      apiKey: apiToken,
      ...(Object.values(opts).some((v) => v !== undefined) ? { options: opts } : {}),
    } as Parameters<typeof createAiGateway>[0])
    const unified = createUnified({ apiKey: apiToken })

    return {
      autoload: true,
      async getModel(_sdk: ProviderSDK, modelID: string, _options?: ProviderOptions) {
        // Model IDs use Unified API format: provider/model (e.g., "anthropic/claude-sonnet-4-5")
        return aigateway(unified(modelID))
      },
      options: {},
    }
  }
  return loader(input)
}

function iife<T>(fn: () => T) {
  return fn()
}
