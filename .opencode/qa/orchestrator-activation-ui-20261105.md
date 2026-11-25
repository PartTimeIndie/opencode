# Main-Orchestrator activation and management repair — 2026-11-05

## Scope

Continuation of the human-requested OpenCode repair before resuming PU. Target E:/GitRepros/opencode, fork-sync. Existing unrelated staged, unstaged and untracked changes preserved. No Git history/index mutation, deployment, installed-app restart, PU implementation or Unity operation. This report supersedes the manual-configuration next-step in orchestrator-commission-diagnostic-20261105.md for the new source implementation only; the installed older runtime remains unchanged.

## Acceptance → current evidence

- Explicit human submission initializes an absent Main without a management setup tour: activation.ts checks promoted interactive origin, matching latest user message, exact slash/alias, feature, host capability and skill policy before create-only settings. Defaults Shared/4/0.8. Activation unit cases cover appended slash, alias, no grant, disabled, denied, stale, unpromoted, mismatched, plugin, unknown origin and child. No tasks are created by setup.
- Existing configured/paused/retired state preserved: activation tests compare exact state. Added a real-store create race fixture; competing saved settings win unchanged. Only revision conflicts are absorbed; resources errors remain failures. Child role conflicts remain fail-closed.
- Production service wiring and native commissioning preserved: Loopback commission-fork-auto uses genuine interactive input, no manually inserted settings row or capability lease, real Location/SessionExecution and managed child. This is offline runtime evidence, not a provider cache measurement or installed acceptance.
- Readable scrollable management: plugin uses readable German labels, collapsed details and host-owned bounded scrolling; four Chromium cases cover 1280x720 and 390x844, light/dark, actual scrollTop/scrollHeight, visible save-button bounds, configure write, full-ID integrate confirmation, favorites, Escape/reopen and verified child-directory navigation.
- Compact/searchable Skills: lazy helper unit tests and two browser cases cover initially collapsed/unloaded catalog, expansion, filtering/empty results, settings-search jump, independent invocation/visibility edits, coalesced reload and disposal.
- Native assignment-package consent remains single-use; no per-helper manual setup, host approval fabrication or cache bypass introduced. Commission diagnostic reason/schema regressions retained.
- Durable owning workflow updated in .agents/instructions/v2-session-core.md, including concurrent initialization behavior. Personal OpenCode-only main-orchestrator/SKILL.md aligned with explicit submission and Shared defaults, clearly distinguishing installed availability and package consent.

## Executed verification

From packages/core:

- `bun typecheck`: exit 0 after final race fix.
- `bun test test/orchestrator-activation.test.ts test/orchestrator-commission.test.ts test/tool-orchestrator.test.ts test/capability-lease.test.ts --only-failures`: 86 pass, 0 fail, 306 assertions.
- `bun test test/session-orchestrator-runtime.test.ts --test-name-pattern 'managed child runtime: commission-fork-auto$' --only-failures`: 1 pass, 45 filtered, 0 fail after final fix.

From packages/app:

- `bun typecheck`: exit 0.
- `bun test --preload ./happydom.ts ./src/plugin/main-orchestrator-controls.test.ts ./src/components/settings-v2/skill-browser.test.ts --only-failures`: 7 pass, 0 fail, 30 assertions.
- `bun run test:e2e:controlled -- e2e/regression/main-orchestrator.spec.ts e2e/regression/skill-policy.spec.ts --workers=1 --reporter=line --max-failures=1`: 6 pass in 43.3 seconds.

From packages/app/e2e: `bun typecheck`: exit 0. Earlier unrelated known-file-tools type errors no longer reproduce on the current shared tree; no unrelated fix made here.

From packages/opencode: `bun test test/plugin/main-orchestrator-app.test.js --only-failures`: 5 pass, 0 fail, 43 assertions.

Focused `git diff --check`: exit 0; Windows LF/CRLF notices only. Required new source/tests remain untracked because staging was not authorized; they must be included in any later authorized commit.

## Browser failure investigation

Two intermediate runs failed on canceled held-input reads during child discovery. Waiting for the first response was insufficient because its query was obsolete. The final spec waits for requestfinished on the actual child held-input replacement, requires HTTP 200 and reconciles only exact-URL ERR_ABORTED reads with that observed successful completion. Other aborted endpoints and all real network failures remain red; existing /app/plugins lifecycle exemption unchanged. This is query-lifecycle reconciliation, not a blanket network-error suppression. Production session query behavior was not changed. Browser HTTP is mocked and does not prove server/provider behavior.

## Independent review

One registered review fanout, active configured reviewer list, all five collected once, no retries or substitutes:

- GLM 5.3 Flash: usable scoped source review via grep. Accepted activation revision-race finding with tests; required fresh browser run completed. Config-refresh caching rejected as inappropriate for required fresh safety checks. Duplicate-name concern resolved by source inspection: skill.ts uses Map keyed by skill.name and returns values, so activation receives unique names.
- GPT-6.1: abstained due unreadable external target; not a clean review.
- Muse: provider HTTP 403 subscription failure; no review.
- OpenRouter free: target-access abstention; no source verdict.
- MiMo: output referred to ungrounded prior conversation/closure and unspecified previous findings; not counted as an independent usable verdict.

Reviewer tools could not verify external Git diff or execute tests. Main verified branch/status and ran the checks above; no claim of reviewer diff binding.

## Source/runtime and remaining gates

Selective `bun run sync:plugins --only=main-orchestrator-app` completed after verifying the other five plugin files matched and the runtime index had the previously read hash. Source and generated runtime index now both SHA-256 ffc8480c9df2b135b823a12df7015b4eb84fc926639ab5eaf4664c3c03e993a2. This is the local generated plugin, NOT a desktop deployment.

A desktop management screenshot from the final browser run was opened and inspected: readable status, collapsed sections, no clipped content in the shown state. Full requested Visual-QA workflow, reviewed continuous final video, retention registration/cleanup and installed live-provider acceptance remain open. Host refused `skill({name:"visual-qa-testing"})` with `Skill visual-qa-testing requires an explicit /visual-qa-testing invocation`; no skill procedure was copied to bypass that gate. Ordinary authorized browser tests continued. Do not call this a full Visual-QA or installed-app completion. No deployment/restart is authorized by this report.
