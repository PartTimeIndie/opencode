import path from "node:path"
import { pathToFileURL } from "node:url"
import { providerPackageDirectory } from "@opencode-ai/core/plugin/provider-loader"
import type { ConfigPlugin } from "@/config/plugin"

/** Declarative preinstallation; activation uses the normal public package loader. */
export function builtinServerPlugins(options: { experimentalWebSockets: boolean }): ConfigPlugin.Origin[] {
  const directory = providerPackageDirectory()
  const packages = [
    { name: "openai", options: { experimentalWebSockets: options.experimentalWebSockets } },
    { name: "github-copilot" }, { name: "cursor" }, { name: "gitlab" }, { name: "poe" },
    { name: "cloudflare-workers-ai" }, { name: "cloudflare-ai-gateway" }, { name: "azure" },
    { name: "digitalocean" }, { name: "snowflake-cortex" }, { name: "xai" },
  ]
  return packages.map((item) => ({
    spec: item.options ? [pathToFileURL(path.join(directory, item.name)).href, item.options] : pathToFileURL(path.join(directory, item.name)).href,
    source: "builtin-provider",
    scope: "global",
  }))
}
