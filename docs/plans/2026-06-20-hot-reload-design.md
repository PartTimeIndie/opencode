## Quick Overview

- [Goal](#goal): Add a runtime reload path so opencode changes do not require a full app restart during development.
- [How It Works](#how-it-works): A central `ReloadService` coordinates config, skills, plugins, commands, agents, tools, and MCP reloads.
- [Runtime Safety](#runtime-safety): Active turns keep their current runtime; reloads apply at safe boundaries and to idle/new sessions.
- [Plugin Reload](#plugin-reload): Plugin code reload should move toward worker isolation for clean unload/reload semantics.
- [Interfaces](#interfaces): Ship both a manual `/reload` command and an enabled watcher workflow for automatic reloads.
- [Tests](#tests): Cover registry invalidation, command/agent/skill refresh, plugin reload smoke, MCP changed-server restart, and logs/errors.

## Goal

Hot reload opencode runtime configuration and extension points so developers can iterate on plugins, skills, commands, agents, tools, and MCP setup without restarting OpenCode after every change.

The plan should favor a complete runtime design, not a temporary cache-busting hack.

## Decisions

- Scope v1 includes:
  - global/project config reload
  - skills discovery/content reload
  - plugin code reload
  - command and agent registry refresh
  - plugin-provided tool refresh
  - changed MCP server restart/reconnect
- Reload orchestration is centralized in a new `ReloadService`.
- Reload applies to new and idle sessions immediately.
- Active turns are not interrupted; they adopt the new runtime at the next safe boundary.
- Plugin reload should use worker isolation as the target architecture.
- User interface includes manual `/reload` plus watcher-driven automatic reloads in v1.

## How It Works

Introduce a `ReloadService` with one public operation, for example:

```ts
reload.reload({ scope, reason, directory })
```

The service owns the reload order:

1. Re-read and validate config.
2. Compute a diff against the active runtime snapshot.
3. Stop or replace affected plugin workers.
4. Refresh skill discovery and skill content.
5. Rebuild command and agent registries.
6. Rebuild plugin-provided tool registry entries.
7. Restart only changed MCP servers.
8. Publish a reload result event for UI/logging.

The reload should be transactional at the registry level: if a new config/plugin fails, keep the previous working registry active and report the failure.

## Runtime Safety

Reload must not mutate the runtime under an active provider stream or tool call.

Use generation-based runtime snapshots:

- Each reload creates a new runtime generation.
- New sessions use the latest generation.
- Idle sessions switch to the latest generation on next prompt.
- Active sessions finish their current provider/tool boundary with the old generation.
- At the next safe boundary, active sessions switch to the new generation.

Safe boundaries:

- before admitting a new user prompt
- after a provider turn settles
- after a tool call settles
- before opening a new queued activity

Avoid immediate interruption in v1.

## Plugin Reload

Target architecture: plugin worker isolation.

Each reloadable plugin should run in an isolated host/worker with:

- explicit startup
- explicit shutdown
- hook registration result
- owned resources tracked by the worker
- structured load errors
- version/generation metadata

On reload:

1. Start the new plugin worker.
2. Ask it to register hooks/tools/agents/commands.
3. If registration succeeds, atomically swap registries to the new generation.
4. Stop the old plugin worker after no active session references its generation.
5. If registration fails, keep old worker and report the error.

NPM-installed plugins can be reload-limited in v1 if needed, but local file plugins should be the primary supported workflow.

## Interfaces

### Slash command

Add a manual command:

```text
/reload
```

Suggested variants:

```text
/reload
/reload skills
/reload plugins
/reload config
/reload mcp
/reload --watch
```

Default `/reload` should reload changed scopes only and return a concise summary:

- config changed: yes/no
- plugins reloaded: list
- skills reloaded: count/list
- commands/agents refreshed: yes/no
- MCP servers restarted: list
- errors: list with actionable paths

### File watcher

Watcher support is part of v1, not a follow-up. It should watch reloadable config and extension files and trigger the same `ReloadService` path as `/reload`.

Suggested control:

```text
/reload --watch
/reload --watch off
/reload --watch status
```

Watcher mode should:

- debounce edits and avoid reloading during partial writes
- batch related file changes into one reload
- ignore generated/transient files where possible
- show concise reload notifications
- defer reload application for active turns until safe boundaries
- reuse the same validation and rollback behavior as manual `/reload`

Default watched paths:

- `opencode.json`, `opencode.jsonc`, `.opencode/opencode.json*`
- `.opencode/skill*/**/SKILL.md`
- configured external skill paths
- `.opencode/plugin*/*.{ts,js,mjs}`
- local plugin paths referenced from config
- `.opencode/agent*/*.md`
- `.opencode/command*/*.md`
- MCP-related config entries via config-file watching

## Key Changes

- Add `ReloadService` in the runtime layer.
- Add runtime generation tracking for reloadable registries.
- Make config reload produce a structured diff.
- Make skill discovery/content reloadable.
- Move plugin execution toward worker-hosted lifecycle.
- Make command, agent, and tool registries rebuildable from the current generation.
- Add changed-server restart support to MCP service.
- Add user-facing reload events/logs.
- Add a debounced watcher that maps changed paths to reload scopes and calls `ReloadService`.

## Tests

Required tests:

- Unit test registry invalidation and generation swap.
- Integration test `/reload` refreshes commands, agents, and skills.
- Plugin smoke test: edit local plugin, run `/reload`, verify new tool/command behavior appears without restart.
- Failure test: broken plugin reload keeps old working generation.
- MCP test: changed MCP server config restarts only that server.
- Active-session safety test: in-flight turn keeps old generation and switches after safe boundary.
- Watcher test: editing a skill/plugin/config file triggers exactly one debounced reload.
- Logging/error test: reload result includes changed scopes and actionable errors.

## Assumptions

- v1 is developer-focused, not a production clustering feature.
- Full active-turn interruption is out of scope.
- Worker isolation is the desired plugin direction, even if the first implementation needs a smaller bridge.
- Watcher mode ships in v1 alongside manual `/reload`.
