import { transports } from "./transports"
import { configure } from "./configure"
import type { ProviderPluginModule, ProviderHost, ProviderAPI } from "@opencode-ai/plugin/provider"
import type { LanguageModelV3 } from "@ai-sdk/provider"

type LanguageSelector = (modelID: string) => LanguageModelV3
type AzureSDK = Partial<Record<"chat" | "responses" | "messages" | "languageModel", LanguageSelector>>

function selectLanguage(sdk: AzureSDK, modelID: string, useChat: boolean) {
  const chat = sdk.chat
  const responses = sdk.responses
  const messages = sdk.messages
  const languageModel = sdk.languageModel
  if (useChat && chat) return chat(modelID)
  if (responses) return responses(modelID)
  if (messages) return messages(modelID)
  if (chat) return chat(modelID)
  if (languageModel) return languageModel(modelID)
  throw new Error("Azure SDK did not provide a language model factory")
}

export const AzurePlugin: ProviderPluginModule = {
  id: "azure",
  transports,
  configure,
  integrations: ["azure"],
  async provider(api) {
    const credentials = api.credentials
    return {
      async "catalog.transform"(evt) {
        const account = await credentialOptions(credentials, "azure")
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/azure") continue
          const configured = item.provider.request.body.resourceName
          const resourceName =
            typeof configured === "string" && configured.trim() !== ""
              ? configured
              : stringOption(account, "resourceName") ?? process.env.AZURE_RESOURCE_NAME
          if (!resourceName) continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.body.resourceName = resourceName
          })
        }
      },
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/azure") return
        if (evt.model.providerID === "azure") {
          if (
            !evt.options.resourceName &&
            !evt.options.baseURL &&
            (evt.model.api.type !== "aisdk" || !evt.model.api.url)
          ) {
            throw new Error(
              "AZURE_RESOURCE_NAME is missing, set it using env var or reconnecting the azure provider and setting it",
            )
          }
        }
        const mod = await import("@ai-sdk/azure")
        evt.sdk = mod.createAzure(evt.options)
      },
      async "aisdk.language"(evt) {
        if (evt.model.providerID !== "azure") return
        evt.language = selectLanguage(evt.sdk as AzureSDK, evt.model.api.id, Boolean(evt.options.useCompletionUrls))
      },
    }
  },
}

async function credentialOptions(credentials: ProviderHost["credentials"], integrationID: string): Promise<Record<string, unknown>> {
  const latest = (await credentials.list(integrationID)).at(-1)
  return latest?.value.type === "key" ? { apiKey: latest.value.key, ...latest.value.metadata } : {}
}

function stringOption(options: Record<string, unknown>, key: string) {
  return typeof options[key] === "string" ? options[key] : undefined
}


export default AzurePlugin
