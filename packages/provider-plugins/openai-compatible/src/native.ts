import { nativeCredential, nativeRequest, type NativeModelIntegration } from "@opencode-ai/plugin/native"

export const nativeModels: Record<string, NativeModelIntegration> = {
  "@ai-sdk/openai-compatible": {
    async resolve(input) {
      const [{ Auth }, { route }] = await Promise.all([import("@opencode-ai/llm/route"), import("@opencode-ai/llm/protocols/openai-compatible-chat")])
      if (!input.model.api.url) return
      const key = nativeCredential(input)
      const auth = !key ? Auth.none : Auth.bearer(key.type === "env" ? Auth.config(key.value) : Auth.value(key.value))
      return nativeRequest(input.model, route, "openai").with({ auth }).model({ id: input.model.api.id })
    },
  },
}
