import { nativeCredential, nativeRequest, type NativeModelIntegration } from "@opencode-ai/plugin/native"

export const nativeModels: Record<string, NativeModelIntegration> = {
  "@ai-sdk/anthropic": {
    async resolve(input) {
      const [{ Auth }, { route }] = await Promise.all([import("@opencode-ai/llm/route"), import("@opencode-ai/llm/protocols/anthropic-messages")])
      const key = nativeCredential(input)
      const auth = !key ? Auth.none : Auth.header("x-api-key", key.type === "env" ? Auth.config(key.value) : Auth.value(key.value))
      return nativeRequest(input.model, route, "anthropic").with({ auth }).model({ id: input.model.api.id })
    },
  },
}
