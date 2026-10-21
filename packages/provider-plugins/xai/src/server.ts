import { XaiAuthPlugin } from "./server/xai"
import type { PluginModule } from "@opencode-ai/plugin"
export default { id: "@opencode-ai/provider-xai", server: XaiAuthPlugin } satisfies PluginModule
