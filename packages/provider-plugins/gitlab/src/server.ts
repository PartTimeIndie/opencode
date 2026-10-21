import { gitlabAuthPlugin } from "opencode-gitlab-auth"
import type { PluginModule } from "@opencode-ai/plugin"
export default { id: "@opencode-ai/provider-gitlab", server: gitlabAuthPlugin } satisfies PluginModule
