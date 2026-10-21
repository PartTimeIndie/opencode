# Visual QA Smoke Test - 2026-06-27

## Scope

Requested goal: broad visual smoke test across OpenCode app functionality, with bugs collected for later fixing.

Tested package: `packages/app`

Primary runner: `bun run test:e2e:controlled` from `packages/app`

Browser stack used: Playwright controlled runner. `agent-browser` was attempted but was not installed in this shell.

Important environment note: the repo rule in `packages/app/AGENTS.md` says not to restart existing app/server processes. The controlled E2E runner starts its own Vite process and closes it afterwards.

## Runs

### Run 1 - full suite, parallel workers

Command:

```bash
bun run test:e2e:controlled
```

Result: `23 passed`, `44 failed`, `1 worker teardown error`.

Output log:

```text
C:\Users\crisc\.local\share\opencode\tool-output\tool_f085e8b76001u6gCxpSzulq3z8
```

Assessment: not reliable as a product signal because the run hit machine/browser resource exhaustion:

```text
net::ERR_INSUFFICIENT_RESOURCES
FATAL ERROR: NewSpace::EnsureCurrentCapacity Allocation failed - JavaScript heap out of memory
```

### Run 2 - full suite, serial workers, corrected QA URL

Command:

```bash
cmd /c "set PLAYWRIGHT_WORKERS=1&& set QA_URL=http://127.0.0.1:3000&& bun run test:e2e:controlled"
```

Result: partial run, user-aborted while test `51/67` was starting. At the abort point, `50` tests had completed: `31 passed`, `19 failed`.

Output log:

```text
C:\Users\crisc\.local\share\opencode\tool-output\tool_f08697de5001PJ0hsiUid8hN9e
```

### Run 3 - focused remaining interaction smoke

Command:

```bash
cmd /c "set PLAYWRIGHT_WORKERS=1&& set QA_URL=http://127.0.0.1:3000&& bun run test:e2e:controlled -- e2e/regression/composer-before-submit.spec.ts e2e/regression/control-panel.spec.ts e2e/regression/explorable-plan-review.spec.ts e2e/regression/preview-attachments.spec.ts e2e/regression/preview-automations.spec.ts e2e/regression/question-popup.spec.ts e2e/regression/slash-anywhere.spec.ts"
```

Result: `9 passed`, `9 failed`.

### Run 4 - representative reproducible failures with preserved artifacts

Command:

```bash
cmd /c "set PLAYWRIGHT_WORKERS=1&& set QA_URL=http://127.0.0.1:3000&& bun run test:e2e:controlled -- --output=e2e/smoke-results e2e/regression/dock-route-active.spec.ts e2e/regression/question-popup.spec.ts e2e/regression/slash-anywhere.spec.ts"
```

Result: `6 passed`, `6 failed`.

Preserved artifacts:

```text
C:\GitRepros\opencode\packages\app\e2e\smoke-results
```

## High Priority Findings

### 1. Session routes often stay on the home/project list instead of opening the session pane

Severity: high

Evidence:

```text
e2e/regression/slash-anywhere.spec.ts:102
Expected: locator('[data-component="session-composer"]') visible
Received: element(s) not found
```

Representative artifact paths:

```text
C:\GitRepros\opencode\packages\app\e2e\smoke-results\regression-slash-anywhere--3588a-s-a-reference-at-the-cursor-chromium\error-context.md
C:\GitRepros\opencode\packages\app\e2e\smoke-results\regression-slash-anywhere--3588a-s-a-reference-at-the-cursor-chromium\test-failed-1.png
C:\GitRepros\opencode\packages\app\e2e\smoke-results\regression-slash-anywhere--3588a-s-a-reference-at-the-cursor-chromium\video.webm
```

The Playwright accessibility snapshot shows the app remains on the home shell with `Projects`, `Recent sessions`, and the seeded session row. The expected session composer is not mounted.

Affected flows observed:

- Slash popover tests: all five slash-anywhere tests fail because `session-composer` is missing.
- Composer before-submit hooks: existing-session composer and new-session composer are missing.
- Assistant attachment rendering: timeline composer missing.
- Prompt thinking level control: composer missing.
- Session timeline smoke/regression tests: expected session headings are missing.

Likely area to inspect first:

```text
packages/app/src/pages/layout.tsx
packages/app/src/pages/session.tsx
packages/app/src/pages/session/session-dock-shell.tsx
packages/app/src/pages/session/composer/session-composer-region.tsx
packages/app/src/context/session-route.tsx
```

### 2. Routed session pane does not become active when dock active state is stale

Severity: high

Evidence:

```text
e2e/regression/dock-route-active.spec.ts:28
Expected tab "Dock route active QA follow-up" aria-selected="true"
Received aria-selected="false"
```

Representative artifact paths:

```text
C:\GitRepros\opencode\packages\app\e2e\smoke-results\regression-dock-route-acti-e2841-e-when-dock-active-is-stale-chromium\error-context.md
C:\GitRepros\opencode\packages\app\e2e\smoke-results\regression-dock-route-acti-e2841-e-when-dock-active-is-stale-chromium\test-failed-1.png
C:\GitRepros\opencode\packages\app\e2e\smoke-results\regression-dock-route-acti-e2841-e-when-dock-active-is-stale-chromium\video.webm
```

The page snapshot shows two middle dock tabs. The first session remains selected and visible, even after navigating directly to the second session route.

Likely area to inspect first:

```text
packages/app/src/pages/session/session-dock-shell.tsx
packages/app/src/context/session-route.tsx
packages/app/src/context/tabs.tsx
```

### 3. Plugin directory sync fans out to inactive restored session directories

Severity: high for performance/network, medium for functionality

Evidence from serial run:

```text
e2e/regression/plugin-loading-overlay.spec.ts:236
Expected directory sync requests only for active directory
Received 20 directories: C:/OpenCode/PluginLoadingOverlay_fanout_0 through fanout_19
```

Impact: restored or inactive tabs can trigger broad plugin directory sync traffic. This can slow startup and create unnecessary backend load.

Likely area to inspect first:

```text
packages/app/src/context/directory-sync.ts
packages/app/src/plugin/app-runtime.tsx
packages/app/src/context/server-sync.tsx
```

## Medium Priority Findings

### 4. Extension manager does not move Session Navigator cleanly between dock areas

Severity: medium

Evidence from serial run:

```text
e2e/regression/extension-manager.spec.ts:166
Expected left dock tab "Session Navigator" count 0
Received count 1
```

Expected behavior: after closing/removing from the left area, the plugin dock item should no longer remain there before adding it to the right dock.

Likely area to inspect first:

```text
packages/app/src/plugin/dock-mount.tsx
packages/app/src/pages/session/session-dock-shell.tsx
packages/app/src/plugin/mount-lifecycle.ts
```

### 5. Explorable plan review drill-down cannot navigate back in one scenario

Severity: medium

Evidence from focused interaction run:

```text
e2e/regression/explorable-plan-review.spec.ts:172
Timeout waiting for [data-slot="explorable-back"] click
```

Expected behavior: after drill-down, the Back control should remain visible/clickable and return to the root node list.

Likely area to inspect first:

```text
packages/app/src/components/control-panel
packages/app/src/components/question
packages/app/src/pages/session
```

### 6. Plugin loading overlay control is missing in the overlay timeout smoke

Severity: medium

Evidence from serial run:

```text
e2e/regression/plugin-loading-overlay.spec.ts:62
Expected button "Show Loading Overlay" visible
Received element(s) not found
```

This may be related to the broader session-route/home-shell issue, but it should be verified separately after the routing issue is fixed.

## Flaky Or Environment-Sensitive Findings

### 7. Question popup overflow mouse-wheel scroll failed once, passed on reproduction

Severity: low to medium, flaky

First focused run failed:

```text
e2e/regression/question-popup.spec.ts:339
Expected scrollTop > 0
Received scrollTop 0
```

Representative reproduction run passed the same spec. Artifacts for the passing reproduction are preserved:

```text
C:\GitRepros\opencode\packages\app\e2e\smoke-results\regression-question-popup--3f032-llable-with-the-mouse-wheel-chromium\test-finished-1.png
C:\GitRepros\opencode\packages\app\e2e\smoke-results\regression-question-popup--3f032-llable-with-the-mouse-wheel-chromium\video.webm
```

Recommendation: keep as a flaky candidate until reproduced twice in isolation.

### 8. Parallel full-suite run exhausts browser/JS resources

Severity: test-infrastructure high, product unknown

Evidence:

```text
net::ERR_INSUFFICIENT_RESOURCES
FATAL ERROR: NewSpace::EnsureCurrentCapacity Allocation failed - JavaScript heap out of memory
```

This makes the default full-suite parallel run noisy on this machine. Serial execution produced more meaningful results.

Recommendation: for local smoke, use:

```bash
cmd /c "set PLAYWRIGHT_WORKERS=1&& set QA_URL=http://127.0.0.1:3000&& bun run test:e2e:controlled"
```

## Passed Coverage Highlights

The following areas had at least one passing smoke/regression check in the serial or focused runs:

- Control Panels bottom dock rendering, docking, pinning, closing.
- Preview attachments rendering and fullscreen overlay.
- Preview automations list and weekly schedule compile.
- Several question popup flows: jump to target session, child-session popup, answer/close, stale recovery, optional follow-up suppression.
- Session Navigator core flows: listing, paging, favorites, project selection, events, limits, scroll retention.
- Session project move flows.
- Session tab startup/prefetch performance-related flows.
- Git workbench app plugin smoke.
- Dock layout desktop/mobile smoke produced screenshots in `e2e/test-results` during the serial run.

## Notes For Fixing Later

Recommended fix order:

1. Fix session route activation/home-shell issue because it blocks composer, slash, attachments, prompt-thinking, and timeline coverage.
2. Fix stale dock active route selection because it is independently reproduced with a clear selected-tab mismatch.
3. Fix plugin directory sync fanout to prevent background directory storm.
4. Re-run full serial suite.
5. Re-run focused interaction suite.
6. Only then investigate flaky question-popup scroll and overlay-specific failures.

Suggested verification commands after fixes:

```bash
cmd /c "set PLAYWRIGHT_WORKERS=1&& set QA_URL=http://127.0.0.1:3000&& bun run test:e2e:controlled -- e2e/regression/dock-route-active.spec.ts e2e/regression/slash-anywhere.spec.ts e2e/regression/composer-before-submit.spec.ts"
cmd /c "set PLAYWRIGHT_WORKERS=1&& set QA_URL=http://127.0.0.1:3000&& bun run test:e2e:controlled -- e2e/regression/plugin-loading-overlay.spec.ts e2e/regression/extension-manager.spec.ts e2e/regression/question-popup.spec.ts"
cmd /c "set PLAYWRIGHT_WORKERS=1&& set QA_URL=http://127.0.0.1:3000&& bun run test:e2e:controlled"
```

## Limitations

- This was not a literal six-hour soak run. It was a broad automated smoke pass plus targeted reproductions in the available session.
- Inline image/video attachment to chat was not available from this tool surface; preserved local paths are listed instead.
- The live always-on URL was not deeply exercised because `agent-browser` was unavailable and the controlled Playwright runner gave more deterministic mocked coverage.
- Existing worktree changes were present before the report was written; this report intentionally does not modify or revert them.
