import { transports } from "./transports"
import { configure } from "./configure"
import type { ProviderPluginModule, ProviderHost } from "@opencode-ai/plugin/provider"
import type { createGitLab } from "gitlab-ai-provider"
import { oauth, requireInstanceUrl, requireCredentialInstanceUrl } from "./auth"
import os from "os"

export const GitLabPlugin: ProviderPluginModule = {
  id: "gitlab",
  transports,
  configure,
  integrations: ["gitlab"],
  async provider(api) {
    const integrations = api.integrations
    await integrations.update((editor) => editor.method.update(oauth))
    return {
      async "aisdk.sdk"(evt) {
        if (evt.package !== "gitlab-ai-provider") return
        const mod = await import("gitlab-ai-provider")
        const configured = typeof evt.options.apiKey === "string"
        const account = configured ? undefined : await activeAccount(integrations)
        const instanceUrl = account
          ? account.instanceUrl
          : requireInstanceUrl(
              typeof evt.options.instanceUrl === "string"
                ? evt.options.instanceUrl
                : (process.env.GITLAB_INSTANCE_URL ?? "https://gitlab.com"),
            )
        evt.sdk = mod.createGitLab({
          ...evt.options,
          instanceUrl,
          apiKey:
            typeof evt.options.apiKey === "string" ? evt.options.apiKey : (account?.token ?? process.env.GITLAB_TOKEN),
          aiGatewayHeaders: {
            "User-Agent": `opencode/${api.app.version} gitlab-ai-provider/${mod.VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
            "anthropic-beta": "context-1m-2025-08-07",
            ...record(evt.options.aiGatewayHeaders),
          },
          featureFlags: {
            duo_agent_platform_agentic_chat: true,
            duo_agent_platform: true,
            ...record(evt.options.featureFlags),
          },
        })
      },
      async "aisdk.language"(evt) {
        if (evt.model.providerID !== "gitlab") return
        const featureFlags = Object.fromEntries(
          Object.entries(record(evt.options.featureFlags)).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
        )
        if (evt.model.api.id.startsWith("duo-workflow-")) {
          const gitlab = await import("gitlab-ai-provider")
          const workflowRef =
            typeof evt.model.request.body.workflowRef === "string" ? evt.model.request.body.workflowRef : undefined
          const workflowDefinition =
            typeof evt.model.request.body.workflowDefinition === "string"
              ? evt.model.request.body.workflowDefinition
              : undefined
          const language = (evt.sdk as ReturnType<typeof createGitLab>).workflowChat(
            gitlab.isWorkflowModel(evt.model.api.id) ? evt.model.api.id : "duo-workflow",
            {
              featureFlags,
              workflowDefinition,
            },
          )
          if (workflowRef) language.selectedModelRef = workflowRef
          evt.language = language
          return
        }
        evt.language = (evt.sdk as ReturnType<typeof createGitLab>).agenticChat(evt.model.api.id, {
          aiGatewayHeaders: record(evt.options.aiGatewayHeaders) as Record<string, string>,
          featureFlags,
        })
      },
    }
  },
}

async function activeAccount(service: ProviderHost["integrations"]) {
  const connection = await service.connection.forIntegration("gitlab")
  if (connection?.type !== "credential") return
  const credential = await service.connection.credential(connection.id)
  if (!credential) return
  return {
    token: credential.value.type === "key" ? credential.value.key : credential.value.access,
    instanceUrl: requireCredentialInstanceUrl(credential.value),
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export default GitLabPlugin
