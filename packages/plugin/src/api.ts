/** Exact major contracts. Plugins declare only the entrypoints they consume. */
export const PLUGIN_API_VERSIONS = { app: 2, server: 2, tui: 2, provider: 1 } as const
export type PluginAPIRequirements = Partial<Record<keyof typeof PLUGIN_API_VERSIONS, number>>

export function requirePluginAPIs(plugin: string, requirements: unknown) {
  if (requirements === undefined) return
  if (!requirements || typeof requirements !== "object" || Array.isArray(requirements))
    throw new Error(`Plugin ${plugin} has invalid API requirements`)
  for (const [entrypoint, version] of Object.entries(requirements)) {
    if (!(entrypoint in PLUGIN_API_VERSIONS) || !Number.isInteger(version) || version < 1)
      throw new Error(`Plugin ${plugin} has invalid ${entrypoint} API requirement`)
    const supported = PLUGIN_API_VERSIONS[entrypoint as keyof typeof PLUGIN_API_VERSIONS]
    if (version !== supported)
      throw new Error(`Plugin ${plugin} requires ${entrypoint} API ${version}; this host provides ${supported}`)
  }
}
