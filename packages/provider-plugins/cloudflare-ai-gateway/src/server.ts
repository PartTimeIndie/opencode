import { CloudflareAIGatewayAuthPlugin } from "./server/cloudflare"
import type { PluginModule } from "@opencode-ai/plugin"
export default { id: "@opencode-ai/provider-cloudflare-ai-gateway", server: CloudflareAIGatewayAuthPlugin } satisfies PluginModule
