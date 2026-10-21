import { CloudflareWorkersAuthPlugin } from "./server/cloudflare"
import type { PluginModule } from "@opencode-ai/plugin"
export default { id: "@opencode-ai/provider-cloudflare-workers-ai", server: CloudflareWorkersAuthPlugin } satisfies PluginModule
