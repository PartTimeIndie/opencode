import { SnowflakeCortexAuthPlugin } from "./server/snowflake-cortex"
import type { PluginModule } from "@opencode-ai/plugin"
export default { id: "@opencode-ai/provider-snowflake-cortex", server: SnowflakeCortexAuthPlugin } satisfies PluginModule
