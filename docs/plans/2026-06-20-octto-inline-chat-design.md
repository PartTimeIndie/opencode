## Problem

Octto currently opens an external browser UI for interactive brainstorming. The goal is to render Octto directly inside the opencode chat, using the existing app-plugin infrastructure where possible.

Historical note from the first inline-chat pass: `/octto` is the supported command, `/occto` should stay removed, and no standalone Octto `SKILL.md` migration was needed at that time because the integration lived in the Octto plugin. Newer progressive-planning behavior is implemented through the `progressive-plan-builder` skill plus the Octto app/server plugins.

## Findings

### Chat surface

Octto selected a hybrid chat surface:

- show active questions inline as custom chat parts
- show answers/status directly in those parts after submission
- keep a compact session/branch summary card for progress and final findings

Relevant existing code:

- `packages/ui/src/components/message-part.tsx` already renders `type: "custom"` parts with a custom renderer and fallback UI.
- `packages/app/src/pages/session/timeline/message-timeline.tsx` passes `appPlugins.customPartRenderer(part)` into `MessagePart`.
- `packages/app/src/plugin/app-runtime.tsx` supports `chat:parts` and `api.chat.parts.register({ kind, mount })`.

### Plugin boundary

Octto selected a local app plugin as the first integration boundary.

Recommended first target:

- add an app plugin such as `.opencode/plugins/octto-app`
- register custom renderers for Octto part kinds
- load it from `.opencode/app.jsonc`

This matches the existing local app plugin pattern already used by `session-navigator-app`, `git-workbench-app`, and `scheduled-jobs-app`.

### Answer flow

Octto selected plugin/API submission for answers.

Recommended flow:

1. Octto emits a custom chat part for a pending question.
2. The Octto app plugin renders buttons/inputs in chat.
3. On submit, the renderer calls a narrow plugin/API method with `{ sessionID, questionID, answer }`.
4. The server-side Octto runtime records the answer and emits updated custom parts or normal assistant output.

Useful existing server-side seams:

- `packages/plugin/src/tool.ts` exposes `context.customPart(...)` to plugin tools.
- `packages/opencode/src/tool/registry.ts` persists custom parts into the session.
- `packages/plugin/src/index.ts` supports server plugin `"chat.parts"` definitions for custom part schemas.

### Cleanup migration

Octto selected only `preserve_octto_alias`: keep `/octto` and do not restore `/occto`.

Actions already done:

- Removed global `/occto` command from `C:\Users\crisc\.config\opencode\opencode.json`.
- Kept global `/octto` command.
- Removed stale `octto: github:vtemian/octto` dependency from `C:\Users\crisc\.config\opencode\package.json`.
- Removed stale `octto` entries from `C:\Users\crisc\.config\opencode\package-lock.json` and `C:\Users\crisc\.config\opencode\bun.lock`.

Notes:

- Package-manager commands and shell deletion abort locally with a WebAssembly instantiate error in this environment, so `C:\Users\crisc\.config\opencode\node_modules\octto` may still exist until it is deleted manually or package-manager cleanup works again.
- The active local plugin at `C:\Users\crisc\.config\opencode\plugins\octto\dist\index.js` was not removed.

## Recommendation

Implement Octto inline rendering as a local app plugin first.

## Implementation status

Implemented v1 locally in `C:\Users\crisc\.config\opencode`:

- Added global app plugin config: `app.jsonc` loads `./plugins/octto-app`.
- Added `plugins/octto-app` app plugin with chat renderers for `octto/session` and `octto/question`.
- Patched Octto server plugin source and `dist/index.js` to register `chat.parts` schemas.
- Patched Octto tools to emit `customPart(...)` for sessions, initial questions, pushed questions, follow-up questions, and review questions.
- Added `POST /answer` to the Octto per-session HTTP server so inline chat controls can submit answers back to Octto.
- Set Octto session store to `skipBrowser: true`, so the external Octto page should no longer open for the local plugin path.
- Patched the local app renderer submit flow so `pick_many` selections survive the pending re-render, controls disable while submitting, and timeout/error feedback is visible in chat.
- A failed multi-branch retry showed that using the full brainstorming bootstrap for renderer QA creates several simultaneous initial questions; future smoke checks should use an isolated one-question renderer/browser test first, then a one-branch Octto smoke session only after the app has reloaded the patched renderer.

### Renderer QA evidence

The patched app renderer was verified in Chromium with an isolated DOM harness:

- Mounted a `pick_many` custom part.
- Selected two checkboxes.
- Forced a renderer remount with the same `questionID`.
- Clicked Submit with a delayed fake `/answer` response.
- Verified checked state during remount and pending render.
- Verified controls disabled while pending.
- Verified no scroll movement (`scrollDelta: 0`).
- Verified submitted payload `{ selected: ["manual", "network"] }`.
- Verified no console messages.

Evidence screenshot: `C:\Users\crisc\AppData\Local\Temp\opencode\octto-renderer-qa.png`.

### Cache and reload fix

The failed in-chat retry indicated the running app can keep the old app-plugin module loaded after editing `plugins/octto-app/index.js`. Follow-up fixes:

- Bumped the local Octto app plugin version to `1.0.1` so a refreshed manifest produces a new module URL.
- Patched `packages/app/src/plugin/app-runtime.tsx` so app-plugin module URLs include the manifest hash as a query string, including the desktop `oc://renderer/app/plugin/...` path.
- Patched `packages/opencode/src/acp/service.ts` so ACP `/reload` also calls `AppPluginAssets.invalidate()` before disposing runtime instances.

Validation:

- `bun typecheck` passed in `packages/app`.
- `bun typecheck` passed in `packages/opencode`.
- Chromium renderer QA passed with no console messages.
- The full `bun test test/cli/acp/lifecycle.test.ts` run was partially blocked by Windows temp-directory `EBUSY` cleanup/timeouts, but the two relevant reload tests passed.

### Follow-up completion

The remaining Octto inline work was completed in the local plugins after the first deploy:

- Octto app plugin version bumped to `1.0.2`.
- Fixed `rank` inline submission to emit `{ ranking: Array<{ id, rank }> }` instead of falling back to `{ text }`.
- Added inline renderers for `rank`, `rate`, `show_diff`, `ask_code`, `ask_file`, `ask_image`, `emoji_react`, and richer `show_options`.
- Hardened `POST /answer` with per-question answer tokens, stricter local-origin CORS behavior, and explicit error responses.
- Rebuilt Octto server `dist/index.js` from typechecked source.
- Added persistent Visual QA and endpoint QA scripts under the local Octto plugin folders.
- Removed the stale `C:\Users\crisc\.config\opencode\node_modules\octto` package folder after confirming package and lock files no longer reference it.

Use durable custom chat parts as the bridge:

```ts
kind: "octto/question"
data: {
  sessionID: string
  branchID: string
  questionID: string
  question: OcttoQuestion
  status: "pending" | "answered" | "cancelled"
  answer?: unknown
}
```

Add a second part kind for the summary/progress card:

```ts
kind: "octto/session"
data: {
  sessionID: string
  branches: Array<{ id: string; status: string; finding?: string }>
}
```

The first implementation can be deliberately small:

1. Create `.opencode/plugins/octto-app` with `exports: { "./app": "./index.js" }`.
2. Add it to `.opencode/app.jsonc`.
3. Register `api.chat.parts.register({ kind: "question", mount })` and `api.chat.parts.register({ kind: "session", mount })` from the `octto` app plugin so they handle server parts `octto/question` and `octto/session`.
4. Render `pick_one`, `pick_many`, `confirm`, and text input first.
5. Submit answers through a narrow server endpoint or plugin API call.
6. Keep markdown fallback text complete enough that chat remains usable if the app renderer is missing.

Avoid changing core app message rendering until the app-plugin path proves insufficient.
