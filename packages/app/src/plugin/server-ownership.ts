import { ServerConnection } from "@/context/server"

export function isPluginServerActive(pluginServer: ServerConnection.Key, currentServer: ServerConnection.Key) {
  return pluginServer === currentServer
}
