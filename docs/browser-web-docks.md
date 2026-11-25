# Named web docks

A web dock is a saved, user-owned website pane. It uses the existing Browser Dock runtime and workspace layout. It is not an agent browser target.

## Use

1. Open an HTTP(S) page in Browser.
2. Choose **Dock**, next to **Pop out**, and enter a name.
3. The running page moves into a pane with that name. It does not reload. If it was the last normal browser tab, Browser gets a fresh empty tab.

Opening the same URL again in Browser creates a separate page. It never selects or replaces the web dock. Website login storage may still be shared through the existing browser partition.

Use the pane's **More options** menu to rename it, change its fixed start address, reload, open its start address, open externally, return it to Browser, or remove it. Changing the start address deliberately navigates the live page. Reloading does not silently return to the start address. Web browsers can prevent a parent app from reloading a cross-origin iframe; in that case OpenCode reports the limitation instead of navigating to a different page.

**X**, middle-click and bulk close hide a web dock. Open it again by its saved name in the dock's plus menu. **Return to browser** moves the same running page back and removes its saved dock definition. **Remove web dock** requires confirmation and disposes its running page.

## Persistence and browser limits

Names and fixed start addresses are stored app-wide in the local profile, using `Persist.global("web-docks.v1")`. Placement, order, size and visibility use the existing dock layout. Existing server-specific layout boundaries are unchanged. Hidden saved docks do not load until first shown.

On desktop, docking saves the actual current Webview URL. In the web app, a cross-origin iframe's current location is not readable. The name dialog explains that the last address explicitly opened in OpenCode is saved instead. The live iframe still moves without reloading.

After an app reload or restart, the saved start address loads as a fresh document. DOM state, form fields and scroll position survive a live move, not a process restart. URLs with embedded usernames or passwords cannot be saved. No cookies or authentication exports are added to dock settings.

Invalid saved definitions are isolated and retained for recovery. The web-dock store decodes its raw envelope before generic persistence normalization. Invalid JSON, malformed envelopes and unknown future schemas remain byte-for-byte unchanged; editing and orphan repair stay blocked. This opt-in hydration path does not change other persisted stores. Layout repair waits for hydration and removes only absent `web-dock:` definitions; malformed definitions and unrelated pane IDs are preserved.

Web embedding can be refused by a site's CSP or frame policy. The feature does not bypass those policies. Desktop uses the existing `persist:opencode-session-browser` partition and Webview security policy.

## Ownership and failures

Browser actions and desktop transfers exclude each other in the main process. The renderer cannot claim another window's guest. Exact guest IDs and generation-bound tickets protect ownership; an old return request cannot release a newer transfer. Restored Webviews also register their new identities with this boundary.

Restored desktop guests stay hidden until Main confirms ownership. A rejected or unavailable admission destroys that guest, retains the definition and shows an error. **Open start address** explicitly retries with a fresh guest; there is no automatic retry loop.

A saved dock that has not loaded a page cannot be returned successfully: open it first. Changing its start address still works and takes effect on first display. Returning a loaded dock also creates a Browser placement when the current layout has none.

A running browser action makes docking fail without moving the source. Retry after the action ends. Pending reservations expire after 30 seconds, so an abandoned reservation cannot block normal browser actions forever. Committed dock ownership never expires automatically. Guest or host destruction clears its own reservations. Unconfirmed IPC outcomes are errors, not successful transfers.

This is an application ownership boundary, not an OS sandbox against privileged developer tools. Native dialogs and dock menus hide frame overlays while open. Slot registrations use actual pane visibility, with mount-owned cleanup for desktop/mobile transitions.

## Source navigation

- `packages/app/src/pages/session/composer/session-browser-runtime.ts`: tab identity and ownership transitions.
- `session-browser-dock.tsx` in the same directory: persistent frames and Browser/Web-Dock views. `browser-frame-slots.ts`, `browser-transfer-lock.ts` and `browser-frame-reload.ts` contain the isolated slot, concurrency and reload contracts.
- `packages/app/src/context/web-docks.tsx` and `web-dock-data.ts`: global definitions, validation and safe hydration repair.
- `packages/app/src/pages/session/session-dock-shell.tsx`: stable pane registration and menu integration.
- `packages/desktop/src/main/browser-transfer-guard.ts`, `browser-transfer-service.ts` and `browser-transfer-ipc.ts`: action exclusion, transfer generations, recovery and host/guest validation.

## Verification

Run app tests from `packages/app`, not the repository root:

```sh
bun --conditions=browser test --preload ./happydom.ts ./src/context/web-dock-store.test.ts ./src/utils/persist.test.ts ./src/pages/session/composer/browser-dock-actions.test.ts ./src/pages/session/composer/session-browser-runtime.test.ts ./src/pages/session/composer/browser-transfer-lock.test.ts ./src/pages/session/composer/browser-frame-slots.test.ts ./src/pages/session/composer/browser-frame-reload.test.ts ./src/pages/session/composer/session-browser-dock.test.ts ./src/context/web-dock-data.test.ts
bun run test:e2e:controlled -- e2e/regression/session-web-dock.spec.ts e2e/regression/session-web-dock-electron.spec.ts --output=e2e/test-results-web-docks
bun typecheck
bun run typecheck:e2e
```

The Electron test builds only its fixture entrypoints into a temporary directory. It launches the already installed Electron dependency with a separate temporary profile and uses the current app source through the controlled Vite server. It closes only its own process. It never deploys, stops or restarts the installed OpenCode application.

From `packages/desktop`:

```sh
bun test ./src/main/browser-transfer-service.test.ts ./src/main/browser-transfer-guard.test.ts ./src/main/browser-control.test.ts ./src/main/browser-target.test.ts
bun typecheck
```

Source tests and isolated browser/desktop fixtures do not attest installed readiness. A full approved production deployment is a separate operation.
