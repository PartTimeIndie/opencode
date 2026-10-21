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
    const {
      VERSION: GITLAB_PROVIDER_VERSION,
      isWorkflowModel,
      discoverWorkflowModels,
    } = await import("gitlab-ai-provider")

    const instanceUrl = (await dep.get("GITLAB_INSTANCE_URL")) || "https://gitlab.com"

    const auth = await dep.auth(input.id)
    const apiKey = auth?.type === "oauth" ? auth.access : auth?.type === "api" ? auth.key : undefined
    const token = apiKey ?? (await dep.get("GITLAB_TOKEN"))

    const providerConfig = (await dep.config()).provider?.["gitlab"]
    const directory = dep.directory

    const aiGatewayHeaders = {
      "User-Agent": `opencode/${dep.version} gitlab-ai-provider/${GITLAB_PROVIDER_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
      "anthropic-beta": "context-1m-2025-08-07",
      ...(providerConfig?.options?.aiGatewayHeaders as Record<string, string> | undefined),
    }

    const featureFlags = {
      duo_agent_platform_agentic_chat: true,
      duo_agent_platform: true,
      ...(providerConfig?.options?.featureFlags as Record<string, boolean> | undefined),
    }

    return {
      autoload: !!token,
      options: {
        instanceUrl,
        apiKey: token,
        aiGatewayHeaders,
        featureFlags,
      },
      async getModel(sdk: ProviderSDK, modelID: string, options?: ProviderOptions) {
        if (modelID.startsWith("duo-workflow-")) {
          const workflowRef = typeof options?.workflowRef === "string" ? options.workflowRef : undefined
          // Use the static mapping if it exists, otherwise use duo-workflow with selectedModelRef
          const sdkModelID = isWorkflowModel(modelID) ? modelID : "duo-workflow"
          const workflowDefinition =
            typeof options?.workflowDefinition === "string" ? options.workflowDefinition : undefined
          if (!sdk.workflowChat) throw new Error("GitLab provider SDK does not expose workflowChat")
          const model = sdk.workflowChat(sdkModelID, {
            featureFlags,
            workflowDefinition,
          })
          if (workflowRef) {
            model.selectedModelRef = workflowRef
          }
          return model
        }
        if (!sdk.agenticChat) throw new Error("GitLab provider SDK does not expose agenticChat")
        return sdk.agenticChat(modelID, {
          aiGatewayHeaders,
          featureFlags,
        })
      },
      async discoverModels(): Promise<Record<string, Model>> {
        if (!apiKey) {
          return {}
        }

        try {
          const token = apiKey
          const getHeaders = (): Record<string, string> =>
            auth?.type === "api" ? { "PRIVATE-TOKEN": token } : { Authorization: `Bearer ${token}` }

          const result = await discoverWorkflowModels({ instanceUrl, getHeaders }, { workingDirectory: directory })

          if (!result.models.length) {
            return {}
          }

          const models: Record<string, Model> = {}
          for (const m of result.models) {
            if (!input.models[m.id]) {
              models[m.id] = {
                id: m.id,
                providerID: "gitlab",
                name: `Agent Platform (${m.name})`,
                family: "",
                api: {
                  id: m.id,
                  url: instanceUrl,
                  npm: "gitlab-ai-provider",
                },
                status: "active",
                headers: {},
                options: { workflowRef: m.ref },
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                limit: { context: m.context, output: m.output },
                capabilities: {
                  temperature: false,
                  reasoning: true,
                  attachment: true,
                  toolcall: true,
                  input: {
                    text: true,
                    audio: false,
                    image: true,
                    video: false,
                    pdf: true,
                  },
                  output: {
                    text: true,
                    audio: false,
                    image: false,
                    video: false,
                    pdf: false,
                    transcription: false,
                  },
                  interleaved: false,
                },
                release_date: "",
                variants: {},
              }
            }
          }

          return models
        } catch (e) {
          return {}
        }
      },
    }
  }
  return loader(input)
}
