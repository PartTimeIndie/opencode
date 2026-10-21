import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const DynamicProviderPlugin: ProviderPluginModule = {
  id: "dynamic-provider",
  async provider(api) {
    return {
      async "aisdk.sdk"(evt) {
        if (evt.sdk) return

        const mod = await import(await api.modules.resolve(evt.package)) as Record<string, (options: Record<string, unknown>) => unknown>
        const match = providerFactoryName(mod)
        if (!match) throw new Error(`Package ${evt.package} has no provider factory export`)

        evt.sdk = mod[match](evt.options)
      },
    }
  },
}

export function providerFactoryName(mod: Record<string, unknown>) {
  const names = Object.keys(mod).filter((name) => name.startsWith("create") && typeof mod[name] === "function")
  return names[0]
}

export default DynamicProviderPlugin
