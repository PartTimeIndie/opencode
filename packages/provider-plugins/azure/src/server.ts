import { AzureAuthPlugin } from "./server/azure"
import type { PluginModule } from "@opencode-ai/plugin"
export default { id: "@opencode-ai/provider-azure", server: AzureAuthPlugin } satisfies PluginModule
