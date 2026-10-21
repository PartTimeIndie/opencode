import { DigitalOceanAuthPlugin } from "./server/digitalocean"
import type { PluginModule } from "@opencode-ai/plugin"
export default { id: "@opencode-ai/provider-digitalocean", server: DigitalOceanAuthPlugin } satisfies PluginModule
