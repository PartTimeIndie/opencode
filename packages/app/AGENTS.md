## Debugging

- Do not stop or restart the app or a server without explicit authorization for that process. Preparation and read-only diagnosis may proceed.

## Local Dev

- `opencode dev web` proxies `https://app.opencode.ai`, so local UI/CSS changes will not show there.
- For local UI changes, run the backend and app dev servers separately.
- Backend (from `packages/opencode`): `bun run --conditions=browser ./src/index.ts serve --port 4096`
- App (from `packages/app`): `bun dev -- --port 4444`
- Open `http://localhost:4444` to verify UI changes (it targets the backend at `http://localhost:4096`).
- For testing through the installed desktop app, follow the repository-root AGENTS.md full-package prod deploy contract: prepare from packages/opencode, then launch only with the required close/restart authorization. ASAR-only replacement and deploy-asar.ts are obsolete and must not be used. Confirm durable completed status before claiming the installed app is ready.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Composer Run Metrics

- Read [Composer run metrics](../../.agents/instructions/composer-run-metrics.md) before changing the durable Activity duration, historical model/chain, or token display in the Composer.

## Model Selector

- Open the model selector at scroll position zero, with all chains before individual models and in the exact persisted order from the chain manager. Do not pin Planning Chain, the default, or the current chain ahead of the user's order. Chain up/down arrows save immediately through the serialized config-write lane and must preserve the selected/default chain, fallback-step order and unsaved editor draft. Filtered pickers move relative to visible neighbor IDs. Do not let current-model or initial-active-item auto-scrolling hide the chains; explicit keyboard navigation may scroll to its target.

- Keep the model-chain editor vertically scrollable inside the bounded dialog body, with its title and close control outside the scroll region. Verify long chains and many saved chains on desktop and narrow viewports, including adding a step and reaching the save actions. Overflow must have a visible scrollbar without hover, not just respond to wheel input; verify the scrollbar in screenshot evidence.

- After a chain move, restore keyboard focus to the same chain's move control, or its selection button at an endpoint, without replacing the editor draft. Use the existing 44px mobile touch-target convention for adjacent reorder controls. Materialize model-selector search actions in an owned memo: List reads its search props from keyboard handlers too, so lazy JSX getters must not create computations outside a Solid owner.

## Session Favorites

- Navigator stars, session-tab pins and tab-menu Add/Remove actions must share the host session favorites store (`host.sessions.favorites` for plugins), not separate plugin state. Keep favorite controls usable before restored tab metadata finishes loading. Live status refreshes must not drop a pointer press/release on a favorite control or apply it twice; cover interrupted clicks and cancellation. Keep navigator stars at the trailing edge so revealing hover actions or delete confirmation never moves the target under the pointer; verify with real mouse movement, not only programmatic clicks. Keep the entire control hit area accessible (at least 28px in desktop tabs, 32px in navigator rows and 44px for touch).

## Tool Calling

- Batch independent reads; serialize dependent operations and mutations. Use only tool APIs available in the current harness.

## Pasted Attachments

- Reconcile optimistic and legacy user-file IDs with the stable V2 positional file IDs at both snapshot and live-event boundaries. Confirmation must remain effective after the optimistic registry entry is cleared; late compatibility events must not restore a second set of thumbnails. Preserve distinct V2 slots even when names/content match, and preserve legacy-only timelines. Cover paste, submit, delayed echo, subsequent refresh, and reload with a regression test; do not mask synchronization bugs by hiding duplicates in the renderer or extending a paste timer.

## Browser Automation

Use the browser automation exposed by the current harness. If using the installed `agent-browser` CLI, its workflow is:

Core workflow:

1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes
