import { InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"

const plugin = "@opencode-ai/plugin"

export function pluginDependency(version = InstallationVersion, local = InstallationLocal) {
  if (local) return { add: [], provided: [plugin] }
  if (version.startsWith("0.0.0-")) return { add: [] }
  return { add: [{ name: plugin, version }] }
}
