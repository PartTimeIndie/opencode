import type { Tab } from "@/context/tabs-domain"
import { decode64 } from "@/utils/base64"

export const MAX_PLUGIN_TAB_DIRECTORIES = 4

export function pluginTabDirectory(tab: Tab) {
  return tab.type === "draft" ? tab.directory : decode64(tab.dirBase64)
}

export function resolveActivePluginDirectories(input: {
  tabs: readonly Tab[]
  routeDirectory?: string
  server?: string
  maxTabDirectories?: number
}) {
  const routeDirectory = input.routeDirectory?.length ? input.routeDirectory : undefined
  const selected = new Set(routeDirectory ? [routeDirectory] : [])
  const maxTabDirectories = Math.max(0, input.maxTabDirectories ?? MAX_PLUGIN_TAB_DIRECTORIES)
  const tabDirectories = input.tabs.toReversed().reduce<string[]>((directories, tab) => {
    if (directories.length >= maxTabDirectories) return directories
    if (input.server && tab.server !== input.server) return directories

    const directory = pluginTabDirectory(tab)
    if (!directory || selected.has(directory)) return directories

    selected.add(directory)
    directories.push(directory)
    return directories
  }, [])

  return routeDirectory ? [routeDirectory, ...tabDirectories] : tabDirectories
}
