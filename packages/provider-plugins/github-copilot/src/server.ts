import { CopilotAuthPlugin } from "./server/copilot"
import type { PluginModule } from "@opencode-ai/plugin"
export default { id: "@opencode-ai/provider-github-copilot", server: CopilotAuthPlugin } satisfies PluginModule
