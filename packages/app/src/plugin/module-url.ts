type PluginModuleManifest = {
  id: string
  version: string
  module: string
  hash: string
}

type RendererLocation = {
  protocol: string
  origin: string
  allowCrossOrigin?: boolean
}

export function pluginModuleUrl(plugin: PluginModuleManifest, serverUrl: string, renderer?: RendererLocation) {
  const server = new URL(serverUrl)
  if ((server.protocol !== "http:" && server.protocol !== "https:") || server.username || server.password) {
    throw new Error("App plugin server must use HTTP without URL credentials")
  }
  if (!plugin.module.startsWith("/") || plugin.module.startsWith("//") || plugin.module.includes("\\")) {
    throw new Error("App plugin modules must use a relative server path")
  }

  const url = new URL(plugin.module, server)
  if (url.origin !== server.origin || url.username || url.password) {
    throw new Error("App plugin modules must use the active server origin")
  }
  if (url.search || url.hash) throw new Error("App plugin module manifests cannot include query parameters or hashes")

  const expected = `/app/plugin/${encodeURIComponent(plugin.id)}/${encodeURIComponent(plugin.version)}/`
  if (!url.pathname.startsWith(expected) || url.pathname.length === expected.length) {
    throw new Error("App plugin module path does not match its manifest identity")
  }

  if (renderer?.protocol === "oc:") {
    return moduleUrlWithHash(`oc://renderer${url.pathname}`, plugin.hash)
  }
  if (renderer && !renderer.allowCrossOrigin && renderer.origin !== url.origin) {
    throw new Error("App plugin modules must use the current web app origin")
  }
  return moduleUrlWithHash(url.toString(), plugin.hash)
}

function moduleUrlWithHash(module: string, hash: string) {
  if (!hash) return module
  return `${module}${module.includes("?") ? "&" : "?"}hash=${encodeURIComponent(hash)}`
}
