# OpenCode plugin contracts

The public package exposes separate app, server, provider, native and TUI entry
points. Read the current exported source for concrete type details; declare
only the capabilities and API major versions the plugin actually consumes.

- App host integration: [`src/app.ts`](src/app.ts).
- Declarative composer toggles and diagnostic boundaries:
  [composer reference toggles](../../docs/plugins/toolbar-append-on-submit.md).
- API compatibility: [`src/api.ts`](src/api.ts).
- Read-only session context, available to all app plugins:
  [public session-context guide](../../docs/plugins/session-context.md).

Keep durable app-plugin source in `.opencode/plugin-sources`; runtime copies
under `.opencode/plugins` are generated artifacts, not the only source checkout.
