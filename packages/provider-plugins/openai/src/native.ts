import { nativeCredential, nativeRequest, type NativeModelIntegration } from "@opencode-ai/plugin/native"

export const nativeModels: Record<string, NativeModelIntegration> = {
  "@ai-sdk/openai": {
    async resolve(input) {
      const [{ Auth }, { route, codexRoute, webSocketRoute }] = await Promise.all([import("@opencode-ai/llm/route"), import("@opencode-ai/llm/protocols/openai-responses")])
      const key = nativeCredential(input)
      const auth = !key ? Auth.none : Auth.bearer(key.type === "env" ? Auth.config(key.value) : Auth.value(key.value))
      const oauth = input.model.providerID === "openai" && input.credential?.value.type === "oauth"
      const transport = nativeRequest(input.model, oauth ? input.transport?.oauthWebSocket ? webSocketRoute : codexRoute : route, "openai")
      if (!oauth) return transport.with({ auth }).model({ id: input.model.api.id })
      const options = input.model.request.options
      const reasoning = options.reasoning
      const mode = options.reasoningMode ?? (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) ? (reasoning as Record<string, unknown>).mode : undefined)
      const apiID = input.model.api.id === "gpt-5.6" ? "gpt-5.6-sol" : input.model.api.id
      if (apiID === "gpt-5.6-sol" && mode === "pro") return { error: {
        apiID, reason: "reasoning-mode", message: "reasoning.mode=pro is not supported for gpt-5.6-sol through ChatGPT OAuth; use variant max",
      } }
      const accountID = input.credential?.value.metadata?.accountID
      return transport.with({
        endpoint: { baseURL: "https://chatgpt.com/backend-api/codex" },
        auth: accountID ? auth.andThen(Auth.headers({ "ChatGPT-Account-Id": accountID })) : auth,
        providerOptions: { openai: { store: false } },
      }).model({ id: apiID })
    },
    smallModels(input) {
      if (input.model.providerID === "openai" && input.credential?.value.type === "oauth") return ["gpt-6-luna", "gpt-6.1-sol"]
    },
  },
}
