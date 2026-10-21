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

export const AzureCognitiveServicesPlugin: ProviderPluginModule = {
  id: "azure-cognitive-services",
  configure,
  async provider(api) {
    return {
      async "catalog.transform"(evt) {
        const resourceName = process.env.AZURE_COGNITIVE_SERVICES_RESOURCE_NAME
        if (!resourceName) return
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (!item.provider.id.includes("azure-cognitive-services")) continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.body.baseURL = `https://${resourceName}.cognitiveservices.azure.com/openai`
          })
        }
      },
      async "aisdk.language"(evt) {
        if (evt.model.providerID !== "azure-cognitive-services") return
        evt.language = selectLanguage(evt.sdk as AzureSDK, evt.model.api.id, Boolean(evt.options.useCompletionUrls))
      },
    }
  },
}

export default AzureCognitiveServicesPlugin
