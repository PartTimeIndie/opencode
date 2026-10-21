import { CodexAuthPlugin } from "./server/codex"
import type { PluginModule } from "@opencode-ai/plugin"
export default { id: "@opencode-ai/provider-openai", server: CodexAuthPlugin } satisfies PluginModule
