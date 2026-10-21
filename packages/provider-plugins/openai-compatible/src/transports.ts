import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
export const transports: NonNullable<ProviderPluginModule["transports"]> = {
"@ai-sdk/openai-compatible": async (options) => (await (() =>
    import("@ai-sdk/openai-compatible").then((m) => (opts: Record<string, unknown> & { name: string; baseURL?: string }) => {
      if (!opts.baseURL) throw new Error("OpenAI-compatible providers require a baseURL")
      return m.createOpenAICompatible({ ...opts, baseURL: opts.baseURL })
    }))())(options)
}
