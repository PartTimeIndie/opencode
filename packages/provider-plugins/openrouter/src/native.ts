import { nativeCredential, nativeRequest, type NativeModelIntegration } from "@opencode-ai/plugin/native"

export const nativeModels: Record<string, NativeModelIntegration> = {
  "@openrouter/ai-sdk-provider": {
    async resolve(input) {
      const [{ Auth }, { route }] = await Promise.all([import("@opencode-ai/llm/route"), import("@opencode-ai/llm/providers/openrouter")])
      const key = nativeCredential(input)
      const auth = !key ? Auth.none : Auth.bearer(key.type === "env" ? Auth.config(key.value) : Auth.value(key.value))
      return nativeRequest(input.model, route, "openrouter").with({ auth }).model({ id: input.model.api.id })
    },
  },
}
