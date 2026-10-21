// Named plugin exports must be plugin functions. SDK `create*` factories and
// non-plugin named exports are skipped by `legacyServerPlugins`.
// Test constants live in `agent-plugin.constants.ts`.
export default async () => ({
  config: async (cfg: { agent?: Record<string, unknown> }) => {
    cfg.agent = cfg.agent ?? {}
    cfg.agent["plugin_added"] = {
      description: "Added by a plugin via the config hook",
      mode: "subagent",
    }
  },
})
