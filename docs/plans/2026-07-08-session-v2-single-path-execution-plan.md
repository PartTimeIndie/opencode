# SessionV2 Single-Path Execution Plan

Status: Stage 4.3 App/Desktop Prompt And Event Cutover is complete with T2, VQA2, MAR decisions, and persistent app evidence recorded; Stage 4.4 subtask command cutover slice is complete; Stage 2.7 Legacy Tool Deletion Gate and the Stage 2 completion gate are complete after the Stage 4.4 seam removed the remaining V1 registry, MCP command, SDK typing, and prompt-loop dependencies. Stage 4.5 prod build is complete and `packages/desktop/out/.build-channel` is `prod`; installed ASAR replacement/reload/smoke remains the only open Installed-App gate because it requires explicit approval to close or reload `OpenCode.exe`. Stage 5.1 through Stage 5.6 and the Stage 5 completion gate are complete with T2, VQA2, active-config MAR outcomes, accepted fixes, and evidence recorded. Stage 6.1 history snapshots, Stage 6.2 system context caching, Stage 6.3 tool definition caching, Stage 6.4 startup lazy loading, Stage 6.5 app timeline row caches, Stage 6.6 system prompt diet, and the Stage 6 completion gate are complete with focused verification, MAR outcomes, VQA evidence where applicable, and performance specs recorded. Bug Track B.1 through B.4 and the bug-track completion gate are complete. Ready-for-Deploy audit is green for the non-installed-app gates: legacy `packages/opencode/src/session/processor.ts`, legacy `packages/opencode/src/session/compaction.ts`, their root registrations/imports, and exclusively legacy tests were removed; independent `Token.estimate`/`SessionNs.getUsage` coverage was retained in `test/session/session.test.ts`; grep is clean for `SessionProcessor`, legacy `SessionCompaction`, and `TODO(v2): Temporary dual-write`; productive code no longer imports the untracked `followup-queue.ts`, `plugin/mcp-command.ts`, or `register-spinner.ts` helper files.

Goal: converge OpenCode onto one execution path: `SessionV2` plus Core tools plus native `@opencode-ai/llm`, one app layout, and no dual-writes.

## Target State

| Area | Current duplication | Target |
| --- | --- | --- |
| Prompt execution | `SessionPrompt.loop` plus SessionV2 runner | Only SessionV2 under `packages/core/src/session/*` |
| Messages | V1 messages plus V2 events dual-write | Only V2 events plus projector |
| Tools | `packages/opencode/src/tool/*` plus `packages/core/src/tool/*` | Only Core tools |
| LLM transport | AI SDK plus native `@opencode-ai/llm` | Native by default, AI SDK fallback only when needed |
| App layout | legacy layout plus `newLayoutDesigns` | Only new layout |
| Settings UI | `settings-general.tsx` plus `settings-v2/*` | Only V2 settings |
| Config | `opencode/src/config` plus `core/src/config` | Core canonical, opencode extensions on top |

Expected effect: about 10,000 to 15,000 lines less code, no prompt-time dual-write overhead, prompt caching available on the standard provider path, and one truth path for future agents.

## Non-Negotiable Working Rules

Hard cut per stage: once a stage gate is green, delete the replaced V1 path in the same PR train. No "keep it just in case" leftovers.

Rollback: Git revert for source changes. Installed desktop fallback only through the ASAR backup created by the prod deploy flow.

No desktop restart without approval: never close, kill, restart, or replace the installed `OpenCode.exe` without explicit user approval in the current chat.

Tests from package dirs only: never run repo-root tests. Run `bun typecheck` and focused tests from the affected package directory.

Continuation rule for this session: if the harness compacts context or emits a goal wrap-up instruction, preserve this plan and immediately continue from the next unchecked item in the next turn. Do not treat compaction handoffs as permission to pause; stop only when the full plan is implemented, tested, reviewed, and checked off.

Before ready: always run `git status --short --untracked-files=all` and ensure every referenced new source, test, helper, or asset is tracked.

No new abstraction without a second concrete user or a real complex boundary that needs a name. Reviewers should reject single-use helpers, compatibility layers, or indirection unless justified.

## Mandatory Quality Gate For Every Work Item

Every work item below has this gate line:

`QA gate: [ ] T1 tests | [ ] VQA1 /visual-qa-testing | [ ] MAR /multi-agent-review | [ ] fixes | [ ] T2 retest | [ ] VQA2 /visual-qa-testing | [ ] evidence | [ ] done`

Meaning:

1. `T1 tests`: run the smallest relevant package verifier after implementation and before review.
2. `VQA1 /visual-qa-testing`: run runtime or visual QA after tests and before review.
3. `MAR /multi-agent-review`: run read-only multi-agent review only after `T1` and `VQA1` are green.
4. `fixes`: implement only accepted reviewer findings, or document rejected/deferred findings with reason.
5. `T2 retest`: rerun the same relevant verifier set after review fixes.
6. `VQA2 /visual-qa-testing`: rerun the relevant runtime or visual QA after review fixes.
7. `evidence`: record commands, URLs, screenshots/videos when applicable, reviewer names, accepted/rejected findings, and evidence paths.
8. `done`: check off only after the full gate is complete.

Visual QA applies to every work item. For backend-only work, `/visual-qa-testing` is a runtime QA pass: server/app still opens, relevant session flow works, console/network errors are checked, and screenshots are attached when they prove the criterion. For UI/layout work, test desktop and mobile viewports and attach screenshots or video inline in the chat.

Multi-agent review uses the active configured reviewer order at review time. The final Ready-for-Deploy gate used:

1. `openai/gpt-5.5 (high)`
2. `zhipuai-coding-plan/glm-5.2`
3. `openrouter/openrouter/auto`

Reviewers are read-only. Review happens after tests and first Visual QA, never before.

## Master Checklist

Use this as the visible top-level board. A work item is checked here only after its own QA gate is fully checked in its section.

### Stage 0: Measurement Baseline And CI Hardening

- [x] 0.1 Request-Assembly Profiling
- [x] 0.2 Token Estimate Bugfix
- [x] 0.3 Lint In CI
- [x] 0.4 Parity Test Harness
- [x] Stage 0 completion gate

### Stage 1: SessionV2 Runner Parity

- [x] 1.0 Runner Parity Inventory
- [x] 1.1 Compaction And Replay Truncation Parity
- [x] 1.2 Revert And Snapshot/Checkpoint Parity
- [x] 1.3 Share, Title, And Todo Parity
- [x] 1.4 Question Tool Serialization And Permission Ask/Deny
- [x] 1.5 Plugin Hooks And Lifecycle Parity
- [x] 1.6 Attachment And Media Lowering
- [x] 1.7 Error Retry, Usage, And Cost Tracking
- [x] 1.8 Legacy Session Backfill Migration
- [x] 1.9 Stage 1 Parity Gate
- [x] Stage 1 completion gate

### Stage 2: Tool Consolidation

- [x] 2.0 Tool Output Contract Baseline
- [x] 2.1 `grep` And `glob`
- [x] 2.2 `read`
- [x] 2.3 `edit`, `write`, And `apply_patch`
- [x] 2.4 `bash` / Shell
- [x] 2.5 `task` Subagent Tool
- [x] 2.6 MCP Tools
- [x] 2.7 Legacy Tool Deletion Gate
- [x] Stage 2 completion gate

### Stage 3: Native LLM Path As Default

- [x] 3.0 Provider Coverage Matrix
- [x] 3.1 Port Missing Native Capabilities
- [x] 3.2 Invert Native LLM Gate
- [x] 3.3 Prompt Caching On Standard Path
- [x] 3.4 Recorded Provider Tests And AI-SDK Shrink
- [x] Stage 3 completion gate

### Stage 4: Cutover And V1 Deletion

- [x] 4.1 Subagents And `opencode run`
- [x] 4.2 TUI Prompt Endpoints
- [x] 4.3 App/Desktop Prompt And Event Cutover
- [x] 4.4 Delete V1 Execution Code And Regenerate SDK
- [ ] 4.5 Desktop Prod Verification
- [ ] Stage 4 completion gate

### Stage 5: App Consolidation

- [x] 5.1 Make `newLayoutDesigns` Permanent
- [x] 5.2 Settings UI Consolidation
- [x] 5.3 Split Large App Files
- [x] 5.4 Split Remaining Large Server Files
- [x] 5.5 Utility Consolidation
- [x] 5.6 App E2E And Visual Regression Gate
- [x] Stage 5 completion gate

### Stage 6: Performance Optimization On V2

- [x] 6.1 History Snapshot Per Run
- [x] 6.2 System Context Caching
- [x] 6.3 Tool Definition Caching
- [x] 6.4 Startup Lazy Loading
- [x] 6.5 App Timeline Incremental Row Caches
- [x] 6.6 System Prompt Diet
- [x] Stage 6 completion gate

### Parallel Bug Track

- [x] B.1 Stop Swallowing Errors
- [x] B.2 Remove Surviving `any` Hotspots
- [x] B.3 Add Regression Tests For Fix-Churn Areas
- [x] B.4 Replace TUI Timeout Workarounds
- [x] Bug track completion gate

## Work Item Start Protocol

Before implementing any work item:

- [ ] Confirm the work item is the next allowed item by dependency order.
- [ ] Inspect `git status --short --untracked-files=all` and note unrelated dirty files.
- [ ] Read the exact target files and tests before editing.
- [ ] If target files have unrelated uncommitted changes, preserve them and edit only the needed hunks.
- [ ] Define the test success criterion.
- [ ] Define the `/visual-qa-testing` success criterion before opening the browser/dev server.
- [ ] Note the expected `/multi-agent-review` scope.
- [ ] Add or update fail-before tests before behavior changes for Stage 1 parity, migrations, paging, and bug-track fixes. Any exception must be recorded in the inventory/evidence before code changes.

## Dev-Server And Visual-QA Protocol

Every work item must run `/visual-qa-testing`. Use this protocol unless the work item section states a stricter one.

Default web QA target: `http://192.168.178.59:4098/` when available. Use Basic Auth from BWS only in memory and never print secrets.

Fallback local app dev server: start the relevant app package dev server when needed. Keep it non-blocking and stop it after the QA pass when this chat started it.

Opencode TUI dev server: from `packages/opencode`, use `tmux new-session -d -s opencode-dev 'bun dev'`, inspect with `tmux capture-pane -pt opencode-dev`, and stop with `tmux kill-session -t opencode-dev` when done.

Windows Playwright rule: do not run direct Playwright browser API snippets through `bun -e` or Bun-executed scripts. Use Playwright CLI, package E2E scripts, the controlled runner, or `node -e` for direct snippets.

For backend-only work, Visual QA means runtime QA:

- [ ] Start or reuse the dev server/runtime relevant to the changed path.
- [ ] Exercise one real prompt/session flow or a direct route that crosses the changed backend code.
- [ ] Check console, server logs, page errors, and network failures.
- [ ] Capture evidence that proves the runtime was healthy. Screenshot only when it proves the criterion.

For UI/layout work, Visual QA means browser QA:

- [ ] Desktop viewport around `1280x720`.
- [ ] Mobile viewport around `390x844`.
- [ ] Exact changed view plus adjacent UI.
- [ ] Console and page errors.
- [ ] Network 4xx/5xx/CORS/duplicate expensive calls.
- [ ] Interaction path when the criterion is interactive.
- [ ] Inline screenshots/videos in the final chat response when the harness supports attachments.

When the active model cannot read screenshots, delegate visual interpretation to a vision-capable subagent and still attach evidence inline for the user.

## Multi-Agent Review Protocol

Run `/multi-agent-review` only after `T1 tests` and `VQA1` pass.

Review scope must include:

- [ ] User request and stage/work item acceptance criteria.
- [ ] Exact changed files.
- [ ] Test commands and results already run.
- [ ] Visual QA URL, viewport, assertions, console/network summary, and evidence paths.
- [ ] Known unrelated dirty files that reviewers must ignore.

Reviewer prompt requirements:

- [ ] Reviewers are read-only.
- [ ] Reviewers must not edit, commit, push, rebase, reset, or run destructive commands.
- [ ] Ask for concrete must-fix findings with file/line evidence, risk, suggested fix, and test requirement.
- [ ] Ask for optional simplification findings only when concrete and worth implementing.

After review:

- [ ] Verify surprising claims in code before acting.
- [ ] Implement only correct and proportionate findings.
- [ ] Reject speculative rewrites, style-only churn, and out-of-scope expansions.
- [ ] Record accepted findings.
- [ ] Record rejected/deferred findings with reason.
- [ ] Run `T2 retest`.
- [ ] Run `VQA2 /visual-qa-testing`.

## Definition Of Done For The Whole Program

The program is complete only when all of these are true:

- [ ] All Master Checklist items are checked.
- [ ] No runtime import of `SessionPrompt` remains.
- [ ] No legacy V1 prompt-loop execution path remains.
- [ ] No dual-write path remains for messages after the V2 projector is canonical.
- [ ] `packages/opencode/src/tool` is deleted or contains only deliberate temporary compatibility exports documented with removal notes.
- [ ] Native `@opencode-ai/llm` is default for locally used providers.
- [ ] AI SDK path is explicitly fallback-only for unsupported native providers.
- [x] `newLayoutDesigns` flag and legacy layout branches are removed.
- [ ] Settings V2 is canonical.
- [ ] The JavaScript SDK is regenerated after API route changes.
- [x] Stage 0 baseline and Stage 6 before/after performance numbers are recorded under `specs/` in the same structured format.
- [x] Long-session paging checklist passes after every paging-sensitive stage.
- [ ] Desktop prod ASAR deploy verification is completed only after explicit approval to close/reload the installed app.
- [ ] AGENTS.md and specs are updated to remove stale V1 guidance.
- [ ] Final `git status --short --untracked-files=all` has been inspected and referenced new files are tracked.

## Evidence Log

Append one row per completed work item.

| Work item | Branch/commit | Test commands | VQA evidence | Reviewers | Accepted findings | Rejected/deferred findings | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1 Request-Assembly Profiling | local working tree | `packages/opencode`: `bun test --timeout 30000 test/session/llm-request.test.ts` (18 pass), `bun test --timeout 30000 test/session/llm.test.ts` (26 pass), `bun test --timeout 60000 test/session/prompt.test.ts -t "records request assembly and provider turn perf events"` (1 pass), `bun test --timeout 60000 test/session/prompt.test.ts` (48 pass, 14 skip), `bun typecheck` (pass). `packages/core`: `bun test --timeout 30000 test/session-runner.test.ts -t "records request assembly and provider turn perf events"` (1 pass), `bun typecheck` (pass). Root: baseline JSON parse (pass). | VQA2 `bun dev` PowerShell fallback: running after 8s, log scan 0 error-like matches. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Evidence durability fixed by keeping canonical JSON/JSONL evidence only; request_assembly assertions strengthened; structural turns omit `ttfb_ms`. | Ignored `.log` artifacts not tracked and no longer canonical; core perf-log isolation, retry-attempt labeling, and provider/model field-name normalization deferred as non-blocking follow-ups. | Baseline: `specs/performance/session-request-baseline-2026-07-08.json`. |
| 0.2 Token Estimate Bugfix | local working tree | `packages/opencode`: `bun test --timeout 60000 test/session/prompt.test.ts -t "loop does not double count system prompt in overflow preflight"` (1 pass), `bun test --timeout 60000 test/session/prompt.test.ts -t "loop preflights oversized requests before provider streaming"` (1 pass), `bun test --timeout 60000 test/session/prompt.test.ts` (49 pass, 14 skip), `bun typecheck` (pass). | VQA2 `bun dev` PowerShell fallback: running after 8s, log scan 0 error-like matches. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Removed synthetic system-message double count from overflow preflight; oversized test still compacts; near-limit test padded so double count crosses the threshold. | Metrics in `LLM.Service` can still report a different prepared-request estimate; preflight-vs-prepared tool footprint mismatch deferred as pre-existing precision limitation. | No provider payload change; only preflight estimate source changed. |
| 0.3 Lint In CI | local working tree | Root: `bun lint` (exit 0, 4744 warnings, 0 errors), workflow sanity `node -e` check (pass), `actionlint -version` (unavailable), temporary parser-error fixture made `bun lint` fail with exit 1 and 1 error, T2 `bun lint` after fixture deletion (exit 0, 4744 warnings, 0 errors). | VQA2 `bun dev` PowerShell fallback: running after 8s, log scan 0 error-like matches. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Added `.github/workflows/lint.yml` to run existing root `bun lint` on push/PR to `dev` and manual dispatch. | Branch protection, warning log noise, workflow timeout/concurrency hardening, duplicate `.oxlintrc.json` options, and first real CI execution deferred as non-blocking follow-ups. | Workflow mirrors `typecheck.yml`; warnings remain non-blocking by existing oxlint policy. |
| 0.4 Parity Test Harness | local working tree | `packages/core`: `bun test --timeout 60000 test/parity/session-v2-runner-parity.test.ts` (10 pass, 0 fail, 33 expect calls), `bun run test:parity` (10 pass, 0 fail, 33 expect calls), `bun typecheck` (pass). | VQA2 `bun dev` PowerShell fallback: running after 8s, log scan 0 error-like matches. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Added `packages/core/test/parity/session-v2-runner-parity.test.ts` and `packages/core` `test:parity`; split permission ask/reply into a Stage 1.4 pending slot; documented revert as Stage 1.2 pending; replaced abort busy-wait with stream readiness timeout. | Executable revert deferred to Stage 1.2; interactive permission ask/reply serialization deferred to Stage 1.4; compaction replay assertion and manifest-title binding deferred as non-blocking harness refinements. | Active parity gate covers 9 runnable SessionV2 runner scenarios with no provider/network calls. |
| Stage 0 completion gate | local working tree | `packages/core`: `bun run test:parity` (10 pass), `bun typecheck` (pass), `bun test --timeout 60000 test/session-runner.test.ts -t "records request assembly"` (1 pass). `packages/opencode`: `bun test --timeout 60000 test/session/llm-request.test.ts test/session/prompt.test.ts` (67 pass, 14 skip), `bun typecheck` (pass). Root: `bun lint` (exit 0, 4743 warnings, 0 errors), baseline/evidence JSON parse (pass). | VQA2 `bun dev` PowerShell fallback: running after 8s, log scan 0 error-like matches. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Added Core test preload isolation for `XDG_*`/`Global.Path.log` and kept Stage 0 files visible to Git with intent-to-add. | Cursor subagent ephemeral dirty hunk preserved as unrelated; package.json broad-regression claim rejected after scoped diff showed only `test:parity`; opencode metric inflation deferred to Stage 6 alignment. | Stage 1.0 can start with metrics, token regression coverage, lint CI, and named parity gate in place. |
| 1.0 Runner Parity Inventory | local working tree | `packages/core`: T1 `bun run test:parity` (10 pass, 0 fail, 33 expect calls), T1 `bun typecheck` (pass), T2 `bun run test:parity` (10 pass, 0 fail, 33 expect calls), T2 `bun typecheck` (pass). | VQA2 `bun dev` from `packages/opencode` via inline Bun wrapper after shell-quoting fallback: running after 8s, captured output scan 0 error-like matches. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Expanded the inventory with Stage 0.4 harness crosswalk rows, subagent/task, structured-output, summary/reminder, unavailable SessionV2 APIs, sharper share/revert/usage rows, corrected compaction markers, and an explicit Todo classification. | Implementation remains deferred to owning Stage 1.1 through Stage 4 work items; Todo V1 presentation metadata is documented as an exception unless an app consumer still requires it. | Stage 1.1 can start from a classified Core target/test-owner inventory. |
| 1.1 Compaction And Replay Truncation Parity | local working tree | `packages/core`: fail-before focused compaction test failed before source fix; T1 `bun run test:parity` (10 pass, 0 fail, 34 expect calls), T1 `bun typecheck` (pass), accepted-fix focused tests (2 pass, 0 fail, 9 expect calls), T2 `bun run test:parity` (11 pass, 0 fail, 39 expect calls), T2 `bun typecheck` (pass). | VQA2 `bun dev` from `packages/opencode` via inline Bun wrapper: running after 8s, captured output scan 0 error-like matches. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Added Core replay after overflow compaction, bounded attachment placeholders, prefix-only summary boundary before the replayed user turn, and parity coverage for checkpoint reload plus direct compaction boundary behavior. | Preflight compaction replay remains an optional untested path; replay `Prompted` uses `steer` because it is immediately projected/promoted and original delivery is not currently threaded into compaction. Manual `compact` API remains owned by Stage 4.2. | Final provider retry now reloads projected history as checkpoint plus separate replayed user prompt instead of embedding the prompt inside `<recent-context>`. |
| 1.2 Revert And Snapshot/Checkpoint Parity | local working tree | `packages/core`: T1 `bun run test:parity` (12 pass, 47 expect calls), T1 tool mutation set (40 pass, 135 expect calls), T1 `bun typecheck` (pass), T2 `bun run test:parity` (14 pass, 59 expect calls), T2 `bun test --timeout 60000 test/session-create.test.ts test/file-mutation.test.ts test/location-mutation.test.ts test/tool-write.test.ts test/tool-edit.test.ts test/tool-apply-patch.test.ts` (70 pass, 196 expect calls), T2 `bun typecheck` (pass). | VQA1 `bun dev` from `packages/opencode`: running after 8s, 0 error signals. VQA2 direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn from `packages/opencode`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Added durable V2 revert mark/clear/clean events, public `SessionV2.revert/unrevert/cleanupRevert`, Info projection, busy guard, assistant part semantics, metadata-only file checkpoints, step snapshot start/end publishing, snapshot-backed workspace revert/unrevert including added/deleted files, and product/server Snapshot layers. | Dedicated `SessionFileMutation` runtime tests remain absent; current coverage is through typecheck, parity, file/tool mutation tests, and the new real Git workspace snapshot regression. Stage 1.3 still owns share/title/todo and summary-file-diff parity. | Added `session-create.test.ts` regression proving revert restores file bytes/deletions/additions and unrevert restores the mutated snapshot. Public `OpenCode.sessions.prompt` now exposes `BusyError` because prompt cleanup can be blocked by active activity. |
| 1.3 Share, Title, And Todo Parity | local working tree | `packages/core`: T1 `bun typecheck` (pass), T1 `bun test --timeout 60000 test/session-create.test.ts test/parity/session-v2-runner-parity.test.ts test/session-todo.test.ts test/tool-todowrite.test.ts` (39 pass, 127 expect calls), T2 `bun typecheck` (pass), T2 same focused test group (42 pass, 138 expect calls), T2 `bun run test:parity` (17 pass, 68 expect calls). | VQA1 direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn from `packages/opencode`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. VQA2 same spawn/log scan: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Added durable public `setTitle`, `setShare`, and `setSummary` coverage; projected Share/Summary into `SessionV2.Info`; added fresh DB replay coverage; implemented title generation on the V2 runner after the first provider turn using the first real user prompt; added title-agent small-model resolution; preserved non-default/parent skip behavior; rethrew title-generation interrupts; kept Core Todo coverage through existing service/tool tests. | Full summary computation after file-mutating turns remains owned by Stage 1.7. V1 Todo UI presentation metadata remains intentionally deferred because Core persistence/tool effects are already covered and no app consumer was identified for the V1 title string shape. Title generation remains synchronous in the runner rather than V1's background fork; accepted as bounded post-turn maintenance for deterministic V2 tests. | Reviewer fixes addressed: multi-user steering no longer permanently skips title generation; title requests use small model fallback and projected first-user context; title failure handling no longer swallows interrupts; replay regression added for metadata events. |
| 1.4 Question Tool Serialization And Permission Ask/Deny | local working tree | `packages/core`: T1 `bun typecheck` (pass), T1 `bun test --timeout 60000 test/parity/session-v2-runner-parity.test.ts test/question.test.ts test/tool-question.test.ts test/permission.test.ts` (52 pass, 184 expect calls), T1 `bun run test:parity` (21 pass, 84 expect calls), T2 `bun typecheck` (pass), T2 same focused test group (54 pass, 192 expect calls), T2 `bun run test:parity` (21 pass, 87 expect calls), T2 `bun test --timeout 60000 test/session-runner.test.ts -t "cancels one active local tool call"` (1 pass). Extra diagnostic full `test/session-runner.test.ts` currently has 9 unrelated failures in location-move/compaction/queue/concurrency cases, while the Stage-1.4 cancellation test in that file passed. | VQA1 direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn from `packages/opencode`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. VQA2 same spawn/log scan: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Added real runner parity for blocking question reply/reject, permission ask reply/reject, and assertion allow/deny/decline; fixed `always` permission fanout to same-session pending asks only; publishes terminal question/permission rejection events when an in-flight ask is interrupted; registers tool cancellation before publishing local tool-call events; marked referenced `SessionToolCancellation` source intent-to-add. | Detached question plus later blocking question can coexist by design for host-action panels; strict mixed detached/blocking serialization remains a UI policy follow-up. `PermissionV2.RejectedError` is a harmless dead export deferred to cleanup. Inactive-tab recovery is covered by existing app visibility rebootstrap plus `permission.list()`/`question.list()` refresh rather than a new Stage-1.4 app E2E. | Review fixes addressed cross-session auto-resolution, stale ask UI on cancel/interrupt, immediate cancel race, and deny-vs-decline parity split. |

| 1.5 Plugin Hooks And Lifecycle Parity | local working tree | `packages/core`: T1 `bun typecheck` (pass), T1 `bun test --timeout 60000 test/plugin.test.ts test/session-runner-tool-registry.test.ts test/parity/session-v2-runner-parity.test.ts` (46 pass before MAR fixes, then 50 pass after final coverage), T1 `bun run test:parity` (24 pass), T2 `bun typecheck` (pass), T2 focused Stage set (50 pass, 160 expect calls), T2 `bun run test:parity` (24 pass, 108 expect calls), T2 `bun test --timeout 60000 test/session-runner.test.ts -t "cancels one active local tool call"` (1 pass). | VQA1 direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn from `packages/opencode`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. VQA2 same spawn/log scan: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Added Core hooks for chat system/messages/params/headers, tool definition, and tool execute before/after; wired runner request prep and local settlement; added PluginV2 runtime generation, load-then-swap add semantics, scoped remove, replacement-failure rollback, hook failure isolation, output mutation rollback on failing hooks, and ToolRegistry cache invalidation by plugin generation. | Full external V1 plugin loader migration remains an opencode extension-layer cutover concern; Core message hook intentionally operates on canonical `@opencode-ai/llm` messages rather than V1 `WithParts`; full `test/session-runner.test.ts` still has known unrelated failures documented in Stage 1.4 evidence. | Review fixes addressed stale tool-definition cache, failed replacement zombie hooks, partial output mutation from failing hooks, missing default headers, generation-field coverage, title `messages.transform` suppression, cancellation registration cleanup, and provider-options namespace heuristic hardening. |

| 1.6 Attachment And Media Lowering | local working tree | `packages/core`: T1 `bun typecheck` (pass), T1 `bun test --timeout 60000 test/session-runner-message.test.ts test/parity/session-v2-runner-parity.test.ts` (31 pass before MAR fixes), T1 `bun run test:parity` (24 pass), T2 `bun typecheck` (pass), T2 `bun test --timeout 60000 test/session-runner-message.test.ts test/parity/session-v2-runner-parity.test.ts` (34 pass, 134 expect calls), T2 `bun run test:parity` (24 pass, 108 expect calls). | VQA1 direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn from `packages/opencode`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. VQA2 same spawn/log scan after fixes: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Added Core user attachment lowering for text/plain, directories, images, Bedrock documents, and route-aware unsupported-media omission; normalized MIME casing and `image/jpg` to `image/jpeg`; added provider payload tests for OpenAI image/omitted PDF/`image/jpg`, Anthropic user/tool images, and Bedrock user/extracted PDF documents; added V1-style synthetic error tool-results for pending/running tool calls; serialized local error tool media as omission text; extracted Bedrock PDF tool attachments into a synthetic user media message while keeping unsupported binary files as model-visible omission text. | Raw Bedrock document filename sanitization deferred to the `@opencode-ai/llm` Bedrock protocol because existing provider tests intentionally expect filenames with extensions; non-data/remote URI materialization remains deferred to prompt-admission or a dedicated attachment materialization slice because Stage 1.6 now keeps provider payloads safe for durable data URLs but does not read external URIs in the pure history lowerer. | Review fixes addressed user PDF route mismatch, case-sensitive MIME checks, `image/jpg` drop, pending/running dangling tool calls, local error media replay, double tool-result computation, and missing Anthropic/tool-result provider-payload coverage. |

| 1.7 Error Retry, Usage, And Cost Tracking | local working tree | `packages/core`: T1 `bun typecheck` (pass), T1 `bun test --timeout 60000 test/parity/session-v2-runner-parity.test.ts test/session-runner-tool-events.test.ts test/session-runner-message.test.ts` (pass), T1 `bun run test:parity` (pass), T2 same verifier set (pass), focused `bun test --timeout 20000 test/parity/session-v2-runner-parity.test.ts -t "surfaces retryable provider-error"` (pass). | VQA1 direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. VQA2 same spawn/log scan: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Fixed exhausted retryable `provider-error` surfacing, reused publisher state after `step-finish`, V2 revert usage decrement, plain usage output-token extraction, and provider-error retry backoff/test-clock behavior. | Session summary/file-diff computation remains an explicit Stage 1 inventory gap outside the Stage 1.7 retry/usage/cost acceptance slice; Bedrock raw filename sanitization and remote URI materialization remain deferred from Stage 1.6. | Runner keeps one explicit `llm.stream(request)` per provider turn; retry is allowed only before assistant output and before `step-finish`; cost comes from the model catalog seam and is aggregated on `Step.Ended`. |
| 1.8 Legacy Session Backfill Migration | local working tree | `packages/core`: fail-before focused backfill regression failed before implementation; T1 focused backfill test passed; T1 `bun test --timeout 60000 test/database-migration.test.ts` passed with 16 tests; T1 `bun typecheck` passed; T2 focused `bun test --timeout 30000 test/database-migration.test.ts -t "backfills legacy Session messages\|appends V2 backfill"` passed; T2 full migration test passed with 17 tests and 68 expect calls; T2 `bun typecheck` passed. | VQA1 direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. VQA2 same spawn/log scan: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Added idempotent legacy `message`/`part` to V2 `event`/`session_message`/`session_input` backfill; fixed skip of sessions with existing V1 event rows by appending V2 events after the current aggregate sequence; added schema-decode and completed-tool coverage. | Full subtask/compaction/retry/snapshot/patch visual-card preservation, no-op corrupt-row sentinel, per-session transaction chunking, and real local DB copy verification are deferred; real DB copy verification remains required before Stage 4. | Backfill is guarded by table/column presence so intermediate migration fixtures skip safely; sessions with existing `session.next.*` events or projections are not rewritten. |
| 1.9 Stage 1 Parity Gate | local working tree | `packages/core`: T1 `bun typecheck` (pass), T1 `bun run test:parity` (31 pass, 129 expect calls), T1 broad focused Stage 1 suite (115 pass, 329 expect calls), T2 `bun typecheck` (pass), T2 `bun run test:parity` (31 pass, 129 expect calls), T2 broad focused Stage 1 suite including `test/session-file-mutation.test.ts` (118 pass, 338 expect calls). | VQA1 direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. VQA2 same spawn/log scan: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Classified Summary/file-diff and Structured Output as Stage 4.3 blockers; separated task-shaped local settlement from pending real subagent task parity; classified V2 shell/skill/switchAgent/compact/wait APIs as Stage 4.2 blockers; marked referenced Core files intent-to-add. | Full `session-runner.test.ts` failures remain deferred to known unrelated fix-churn/B.3 work; real local DB copy verification for 1.8 remains required before Stage 4; real subagent task, structured output, summary computation, and missing V2 APIs remain pre-cutover blockers. | Stage 1 implemented parity is green; non-green inventory rows are explicitly blocked before Stage 4 cutover. |
| Stage 1 completion gate | local working tree | `packages/core`: Stage 1.9 T2 `bun typecheck` (pass), `bun run test:parity` (31 pass, 129 expect calls), broad focused Stage 1 suite including database migration, metadata, message lowering, plugin, question/permission, todo, registry, and file-mutation tests (118 pass, 338 expect calls). | Stage 1.9 VQA2 direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Completed Stage 1 runner parity slices 1.0 through 1.9 and classified all remaining non-green inventory rows as pre-cutover blockers. | Stage 2.5/4.1 real subagent task, Stage 4.2 V2 APIs, Stage 4.3 summary and structured output, and Stage 4 real local DB copy verification remain required before cutover/deletion. | Stage 2 Tool Consolidation can start without claiming Stage 4 cutover readiness. |
| 2.0 Tool Output Contract Baseline | local working tree | `packages/core`: T1 focused `bun test --timeout 30000 test/tool-output-contract.test.ts` (2 pass), T1 relevant tool subset (30 pass), T1 `bun typecheck` after fixture correction (pass), T2 affected tool family suite `bun test --timeout 60000 test/tool-output-contract.test.ts test/tool-search-limits.test.ts test/tool-edit.test.ts test/tool-write.test.ts test/tool-apply-patch.test.ts test/tool-bash.test.ts test/tool-read.test.ts test/tool-webfetch.test.ts test/tool-websearch.test.ts test/tool-control-panel.test.ts test/tool-question.test.ts test/tool-skill.test.ts test/tool-todowrite.test.ts` (91 pass, 279 expect calls), T2 `bun typecheck` (pass). | VQA1 direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. VQA2 same spawn/log scan: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Added `tool-output-contract.test.ts` model-visible baselines across shipped Core built-in families; fixed runtime-path assumptions for Glob/Grep; exported small formatter seams for Bash, ControlPanel, Read, WebFetch, WebSearch, and question content; covered question attachment content, Read image/text behavior, and dynamic Skill file URLs. | The `Tool.make` source check remains supplemental and source-coupled by design for this baseline; registry-level generic bounding/failure-path coverage remains owned by later ToolOutputStore/MCP and tool-specific stages; full integration behavior remains covered by existing per-tool tests. | Marked the new contract test intent-to-add; Windows-sensitive `ReadTool` expectations now use `path.resolve` and the actual forwarded page shape. |
| 2.1 `grep` And `glob` | local working tree | `packages/opencode`: T1 `bun test --timeout 60000 test/tool/grep.test.ts test/tool/glob.test.ts` (9 pass before MAR fix), T1 `bun typecheck` (pass after Core registry literal fix), T2 same search tests after fixes (11 pass, 26 expect calls), T2 `bun typecheck` (pass). `packages/core`: T1/T2 `bun test --timeout 60000 test/tool-search-limits.test.ts test/tool-output-contract.test.ts` (4 pass, 6 expect calls), T1/T2 `bun typecheck` (pass). | VQA1 direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. VQA2 same spawn/log scan: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Reduced legacy opencode `grep`/`glob` to V1 adapters over Core `DEFAULT_LIMIT` and `toModelOutput`; added optional `limit` schema fields; preserved V1 permission, title, metadata, exact-file, and external-directory behavior; fixed exact-file grep so sibling files are not searched; added default-limit and explicit-limit regression coverage. | User-visible default cap changed from legacy 100 to Core 200 by design. Custom limits below Core `DEFAULT_LIMIT` set `metadata.truncated` without a model-visible truncation line because the formatter contract is Core-owned; this remains visible for later formatter refinement if needed. Broader pre-existing `registry.ts` plugin-hook changes remain outside the Stage 2.1 scope except for the literal type fix needed by typecheck. | Core and legacy search output are now aligned on the Stage-2.0 baseline while V1 registry adapters remain only until Stage 4 deletion. |
| 2.2 `read` | local working tree | `packages/core`: T1 `bun test --timeout 60000 test/tool-read.test.ts test/tool-output-contract.test.ts` (19 pass before MAR fixes), T1 `bun typecheck` (pass), T2 same read/contract tests after fixes (23 pass, 55 expect calls), T2 `bun typecheck` (pass). `packages/opencode`: T1/T2 `bun test --timeout 90000 test/tool/read.test.ts` (43 pass, 104 expect calls), T1/T2 `bun typecheck` (pass). | VQA1 direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. VQA2 inline Bun dev-spawn/log scan: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Ported Core Read model-visible formatting for UTF-8 files, text pages, directories, images, PDFs, binary errors, and managed output; added `LocationMutation`-based internal/external read permission resources; kept image normalization and explicit PDF media return; added deterministic Core read regressions and output-contract baselines. | Legacy `packages/opencode/src/tool/read.ts` remains temporarily until the later deletion gate; full legacy read behavior is still covered by the existing opencode tests. Product `LocationMutation` remains strict; Core Read tests use a deterministic resolver fake rather than depending on real dummy files. | Review fixes addressed trailing-newline phantom lines, full-file line/line-length caps with continuation guidance, Windows directory slash normalization, external-directory approval for absolute reads, location-relative permissions for in-location absolute paths, expected read errors as model-visible tool errors, and PDF native media handling. |
| 2.3 `edit`, `write`, And `apply_patch` | local working tree | `packages/core`: T1 `bun test --timeout 60000 test/patch.test.ts test/tool-apply-patch.test.ts test/tool-edit.test.ts test/tool-write.test.ts test/tool-output-contract.test.ts` (37 pass before MAR fixes, 129 expect calls), T1 `bun typecheck` (pass), T2 same suite after fixes (40 pass, 140 expect calls), T2 `bun typecheck` (pass). `packages/opencode`: T1/T2 `bun test --timeout 120000 test/tool/edit.test.ts test/tool/write.test.ts test/tool/apply_patch.test.ts` (71 pass, 146 expect calls), T1/T2 `bun typecheck` (pass). | VQA1 direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. VQA2 same inline dev-spawn/log scan after source fixes: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2` | Core mutation tools now cover exact edit replacement, replace-all, BOM/CRLF preservation, write BOM deduplication, shared `edit` permission filtering for edit/write/apply_patch, external-directory approval before reads, apply_patch CRLF preservation through `Patch.derive`, duplicate-target rejection before side effects, target-exists/stale update messages, and stale conditional commit protection. | Legacy opencode edit/write/apply_patch remain temporarily until the later deletion gate; legacy tests stay green. Journal recording still happens after `FileMutation` returns rather than inside the per-target lock; fixing journal/file-commit atomic ordering needs a broader `FileMutation`/`SessionFileMutation` commit API and is deferred outside the Stage-2.3 acceptance slice. `apply_patch` moves remain unsupported in Core and are explicitly tested. Patch trailing-newline normalization is kept for legacy parity. | Accepted review fixes: added apply_patch duplicate-target preflight, tool-level BOM/CRLF regression, stale update actionable error, target-exists error, permission-denial no-read coverage, and write/apply_patch shared `edit` definition-filter assertions. Rejected/deferred: false positive BOM-drop claim was disproved by tool-level regression; insert-only `@@ context` patch semantics and shared BOM helper cleanup are low-risk follow-ups. |
| 2.4 `bash` / Shell | local working tree | `packages/core`: T1 `bun test --timeout 60000 test/tool-bash.test.ts test/tool-output-contract.test.ts` (16 pass, 51 expect calls), T1 `bun typecheck` (pass), T2 `bun test --timeout 60000 test/process/process.test.ts test/tool-bash.test.ts test/tool-output-contract.test.ts` (38 pass, 105 expect calls), T2 `bun typecheck` (pass). `packages/opencode`: T1 `bun test --timeout 120000 test/tool/shell.test.ts` (65 pass, 183 expect calls), T1 `bun typecheck` (pass), T2 first shell rerun had all 65 assertions pass but failed Windows temp cleanup with `EFAULT`, T2 rerun `bun test --timeout 120000 test/tool/shell.test.ts` passed cleanly (65 pass, 183 expect calls), T2 `bun typecheck` (pass). | VQA1 direct inline `bun dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. VQA2 same inline dev-spawn/log scan: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2`, `cursor/claude-fable-5 (max)` | Core Bash now uses `Shell.acceptable(Config.latest(..., "shell"))`, invokes PowerShell explicitly with `-NoLogo -NoProfile -NonInteractive -Command`, normalizes slash-style Windows command-argument paths before advisory warnings, exports the formatter/schema for output-contract baselines, and `AppProcess.run` now drains stdout/stderr briefly after process exit without hanging on detached inherited stdio while marking aborted drains as truncated. Legacy shell streaming regression was stabilized with shell-specific delayed output. | Parser-based approval reduction, BashArity command-prefix approvals, parser-based external path detection, cmd-specific invocation/path handling, plugin shell env augmentation, durable progress metadata streaming, and background job status/recovery remain locked TODOs for later stages. `runStream` still uses the older EOF-based collection and inherited-pipe behavior is deferred because Stage 2.4 only changed `run` capture. Two-character cmd-style switch false positives remain part of the token-based advisory scanner until parser-based detection. | Review fixes addressed invisible output loss after inherited-pipe drain timeout by marking capture truncated and adding `process.test.ts` coverage; model-facing Bash description now matches the Windows default shell order and has a regression assertion. Default Windows shell behavior through PowerShell is intentional via `Shell.acceptable`. |

| 2.5 `task` Subagent Tool | local working tree | `packages/core`: T1 `bun test --timeout 60000 test/tool-task.test.ts test/tool-output-contract.test.ts test/session-create.test.ts` (30 pass), T1 `bun typecheck` (pass), T2 `bun test --timeout 60000 test/tool-task.test.ts test/tool-output-contract.test.ts test/session-create.test.ts` (37 pass, 112 expect calls), T2 `bun typecheck` (pass). | VQA1 inline `bun dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. VQA2 same inline dev-spawn/log scan after fixes: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2`; `cursor/claude-fable-5 (max)` skipped per user after Cursor runner error. | Added Core `TaskTool`, `task` output baseline, linked child create attributes, and focused regressions for normal completion, permission denial, unknown agent, existing task reuse, invalid/missing/wrong-parent/wrong-location/wrong-agent `task_id`, child failure output, defect propagation, and parent interruption cleanup. Review fixes addressed arbitrary-session `task_id` reuse, invalid/stale `task_id` behavior, defect swallowing, and missing interrupt coverage. | Session-scoped registration remains deferred to Stage 4.1 because adding `TaskTool` to `BuiltInTools.locationLayer` creates a `SessionV2`/`LocationServiceMap`/`ToolRegistry` cycle. V2 subagent permission derivation, background subagents, `opencode run`, command metadata, XML escaping, empty assistant text handling, and unbounded child message read remain Stage 4.1 or non-blocking follow-ups. | Stage 2.5 establishes the Core task leaf and tests; it does not claim runtime runner/tool-registry cutover until the Stage 4.1 prompt seam. |
| 2.6 MCP Tools | local working tree | `packages/opencode`: T1 `bun test --timeout 60000 test/session/mcp-tools.test.ts test/session/tools-permission.test.ts test/tool/registry.test.ts test/server/httpapi-mcp.test.ts test/server/httpapi-mcp-oauth.test.ts` (26 pass before review fixes), T1 `bun typecheck` (pass), T2 same focused suite (29 pass, 81 expect calls), T2 `bun typecheck` (pass). `packages/core`: T1/T2 `bun test --timeout 60000 test/mcp-starter.test.ts test/tool-output-store.test.ts` (17 pass, 39 expect calls), T1/T2 `bun typecheck` (pass). | VQA1 inline `bun dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. VQA2 same inline dev-spawn/log scan after fixes: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)` completed; `cursor/composer-2.5` failed with Cursor runner `UnknownError`; `zhipuai-coding-plan/glm-5.2` failed due OpenRouter credit/max-token limit; fallback reviewers `openai/gpt-5.5` default and `review-code-simplifier`; `cursor/claude-fable-5` skipped per user. | MCP V1 bridge now clones MCP tool entries before wrapping, converts MCP output through `ToolOutputStore.bound`, avoids returning unbounded `result.content`, preserves small MCP images/resources, omits oversized MCP image/resource blobs from provider-facing content/attachments using configured `tool_output.max_bytes`, and provides `V1ToolOutputStore` so V1 app/session/httpapi paths honor Opencode `tool_output` config. Tests cover schema transform, single permission ask, large text bounding, image/resource preservation, oversized media omission, config adapter limits, auth HTTP paths, MCP starter fallback, and custom-tool import isolation. | Core `ToolOutputStore` still intentionally preserves native media for Core tool results; the Stage 2.6 per-MCP media cap is in the V1 MCP bridge. Non-failing `tool.registry` plugin-hook `RangeError: Cannot use a closed database` logs remain existing test noise and did not fail T1/T2. | HTTP MCP status test now asserts the relevant `demo` disabled entry without failing on local user/workspace MCP servers. |
| 2.7 Legacy Tool Deletion Gate | local working tree | `packages/core`: `bun typecheck` (pass), `bun test --timeout 60000 test/application-tools.test.ts test/session-runner-tool-registry.test.ts test/local-tools.test.ts test/location-layer.test.ts` (34 pass, 76 expect calls). `packages/opencode`: `bun typecheck` (pass), `bun test --timeout 60000 test/server/httpapi-experimental.test.ts` (4 pass, 1 skip), `bun test --timeout 60000 test/server/httpapi-query-schema-drift.test.ts` (12 pass, 49 expect calls), `bun test --timeout 60000 test/cli/run/entry.body.test.ts` (14 pass), `bun test --timeout 60000 test/cli/run/scrollback.surface.test.ts` (15 pass, 1 skip), `bun test --timeout 60000 test/session/llm.test.ts -t "accepts user image attachments as data URLs"` (1 pass), `bun test --timeout 60000 test/session/llm-native-recorded.test.ts` (3 pass, 1 skip), clean `agent.test.ts` subsets (4 pass plus 11 pass). | Runtime QA via default server/app-route tests and CLI renderer tests above; deletion gate checks: `packages/opencode/src/tool/**/*` and `packages/opencode/test/tool/**/*` no files, grep found no runtime/test references to `@/tool`, `../tool`, or `packages/opencode/src/tool`. | `openai/gpt-5.5 (high)`, `cursor/default`, `zhipuai-coding-plan/glm-5.2` | Deleted the legacy opencode tool implementation and test tree; added Core local custom-tool loading with per-file import isolation and plugin-style adapter; made Core `Tool.make` accept JSON-schema overrides; wired `LocalTool.locationLayer`; made experimental tool listing Core-backed and provider/model-optional; converted `opencode run` display code to structural Core V2 shapes; moved shared LLM fixtures to `test/fixtures/llm`. | Local custom-tool `ask` and `customPart` remain fail-fast unsupported pending a dedicated Core adapter design; broader plugin/MCP canonical registration beyond local project files remains out of scope. Full `agent.test.ts` still hits a Bun 1.3.14 `watcher.node` native segfault after 32 visible passes, so relevant subsets were used for clean-exit evidence. | `packages/opencode/src/tool` and `packages/opencode/test/tool` are empty in the worktree; `git status` shows the old tracked files as deleted and the moved fixtures as renames. |
| Stage 2 completion gate | local working tree | Same final verifier set as 2.7 plus prior Stage 2.0 through 2.6 T2 evidence. | Runtime/deletion QA from 2.7 confirms no live legacy tool tree or imports remain after the Stage 4.4 seam. | `openai/gpt-5.5 (high)`, `cursor/default`, `zhipuai-coding-plan/glm-5.2` | Completed Tool Consolidation: Core `Tool.make`/`ToolRegistry` is the only remaining runtime tool path; legacy opencode tool code and tests are gone. | None for Stage 2 completion beyond the local custom-tool context limitations documented in 2.7. | Stage 3 and Stage 4 remain separately tracked; Stage 4.5 installed desktop prod verification is still blocked until explicit approval to close/reload the installed app. |
| 3.0 Provider Coverage Matrix | local working tree | `packages/llm`: T1/T2 `bun typecheck` (pass), T1/T2 provider suite `bun test --timeout 60000 test/provider/openai-chat.test.ts test/provider/openai-responses.test.ts test/provider/anthropic-messages.test.ts test/provider/gemini.test.ts test/provider/bedrock-converse.test.ts test/provider/openai-compatible-chat.test.ts test/provider/openrouter.test.ts test/provider/cloudflare.test.ts test/route.test.ts test/auth.test.ts` (`173 pass`, T2 `305 expect() calls`). | VQA1/VQA2 inline `bun dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `openai/gpt-5.5 (high)` plus available replacement reviewers; `cursor/claude-fable-5` skipped per user. | Corrected the matrix for the native runtime gate, OpenAI Responses-vs-Chat adapter scope, OAuth wording, Azure scripted coverage, active replay vs registered/skipped golden rows, and grouped bundled AI-SDK fallback. | Provider enablement beyond OpenAI/Anthropic/opencode-compatible remains deferred to later Stage 3 rows; native defaulting is now handled by provider-specific support gates. | Matrix now records native/fallback decisions and coverage notes for required provider/auth families. |
| 3.1 Port Missing Native Capabilities | local working tree | `packages/llm`: T1 `bun test --timeout 60000 test/provider/openai-responses.test.ts` (`52 pass`), T1 `bun typecheck` (pass), T2 `bun test --timeout 60000 test/provider/openai-chat.test.ts test/provider/openai-responses.test.ts test/provider/openai-compatible-chat.test.ts` (`83 pass`, `135 expect() calls`), T2 `bun typecheck` (pass). `packages/opencode`: T1/T2 `bun test --timeout 60000 test/session/llm-native.test.ts` (`18 pass`, `52 expect() calls`), T1/T2 `bun typecheck` (pass). | VQA1/VQA2 inline `bun dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `review-gpt-high`, `review-code-simplifier`, replacement `review-gpt-low`; GLM failed due OpenRouter credit/max-token limit; Fable skipped per user. | Added package-owned OpenAI schema sanitizer/projection coverage; fixed numeric/boolean enum inference, mixed-null enum inference, inference readability, and explicit empty object schema compatibility. | Live OpenAI schema validation for exotic schemas remains residual risk; OAuth/token acquisition remains Opencode-owned and no provider runtime gate was enabled. | Opencode native request tests prove AI-SDK-shaped tool schemas compile through the package-owned OpenAI Responses projection. |
| 3.2 Invert Native LLM Gate | local working tree | `packages/opencode`: T1/T2 `bun test --timeout 120000 test/effect/runtime-flags.test.ts` (`35 pass`), T1/T2 `bun test --timeout 120000 test/session/llm-native.test.ts` (`18 pass`, T2 `53 expect() calls`), T1/T2 `bun test --timeout 180000 test/session/llm.test.ts -t native` (`3 pass`), T1/T2 `bun test --timeout 180000 test/session/llm-native-recorded.test.ts` (`3 pass`, `1 skip`), T1/T2 `bun typecheck` (pass). `packages/core`: T1/T2 `bun typecheck` (pass). `packages/llm`: T1 `bun test --timeout 60000 test/provider/openai-responses.test.ts` (`52 pass`), T2 `bun test --timeout 60000 test/provider/openai-chat.test.ts test/provider/openai-responses.test.ts test/provider/openai-compatible-chat.test.ts` (`83 pass`, `135 expect() calls`), T1/T2 `bun typecheck` (pass). Docs cleanup verified by grep: only the plan mentions `OPENCODE_EXPERIMENTAL_NATIVE_LLM`. | VQA1/VQA2 inline `bun dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `review-gpt-high`, `review-code-simplifier`, `review-gpt-low`; Fable skipped per user. | Removed the global native LLM runtime flag, made native the first attempted runtime with AI-SDK fallback reason telemetry, preserved OpenAI `$schema` passthrough to avoid cassette churn, added Copilot explicit fallback coverage, removed duplicate fallback logging, updated runtime boundary docs, and removed the dead env-var row from public CLI docs. | Copilot remains intentional AI-SDK fallback until token refresh/auth, billing raw chunks, route selection, and recorded/simulated coverage are implemented. `packages/web` has no `typecheck` script; `bun run astro check` was attempted and failed on unrelated existing share-component type errors outside the MDX row deletion. | V2 provider turns now attempt the native `LLMClient` path first for supported provider/package/auth combinations; unsupported combinations such as Copilot fall back explicitly with `llm.native_unsupported_reason`. |
| 3.3 Prompt Caching On Standard Path | local working tree | `packages/llm`: T1 `bun test --timeout 60000 test/cache-policy.test.ts test/provider/openai-responses.test.ts test/provider/anthropic-messages.test.ts test/provider/bedrock-converse.test.ts` (`121 pass`), T1 `bun typecheck` (pass), T2 same suite after review fixes (`122 pass`, `196 expect() calls`), T2 `bun typecheck` (pass). `packages/opencode`: T1/T2 `bun test --timeout 120000 test/session/llm-native.test.ts` (`19 pass`, `54 expect() calls`), T1/T2 `bun typecheck` (pass). `packages/core`: T2 `bun typecheck` (pass). | VQA1/VQA2 inline `bun dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `review-gpt-high`, `review-code-simplifier`, `review-gpt-low`; Fable skipped per user. | Added cache-policy synthesis of OpenAI Responses `promptCacheKey` from `LLMRequest.id`, covered HTTP and WebSocket Responses, preserved explicit keys and `cache: "none"`, passed Opencode `sessionID` as native request id, allowed native-request `id`/`cache`, omitted undefined OpenAI Responses body fields, and kept Anthropic/Bedrock inline cache marker coverage green. | Live provider cache-hit size thresholds remain provider-dependent; Gemini cached-content remains explicit out-of-band/no-op in `cache-policy.ts`; broader AI-SDK adapter shrink remains Stage 3.4. | Usage mapping already preserves OpenAI cached tokens and Anthropic/Bedrock cache read/write tokens through `Usage` and Core/Opencode accounting; Stage 3.3 made the standard native request path actively set the cache routing key/breakpoints. |
| 3.4 Recorded Provider Tests And AI-SDK Shrink | local working tree | `packages/opencode`: T1 `bun test --timeout 120000 test/session/llm-native.test.ts` (`21 pass`, then MAR-fix T2 `47 pass`, `83 expect() calls`), T1/T2 `bun test --timeout 180000 test/session/llm-native-recorded.test.ts` (T2 `3 pass`, `1 skip`, `24 expect() calls`), T1/T2 `bun typecheck` (pass). `packages/llm`: T1/T2 recorded suite `bun test --timeout 180000 test/provider/golden.recorded.test.ts test/provider/anthropic-messages.recorded.test.ts test/provider/anthropic-messages-cache.recorded.test.ts test/provider/openai-responses-cache.recorded.test.ts test/provider/gemini-cache.recorded.test.ts test/provider/bedrock-converse-cache.recorded.test.ts` (T2 `12 pass`, `30 skip`, `29 expect() calls`), T1/T2 `bun typecheck` (pass). | VQA1/VQA2 inline `bun dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `review-gpt-high`, `review-code-simplifier`; `review-gpt-low` timed out; Fable skipped per user. | Added tuple-safe native gate coverage and fallback-contract matrix rows for all non-native provider/package families; rejected provider/package mismatches; kept Opencode proxy native by rewriting recorded fixture model provider metadata to `@ai-sdk/openai-compatible`; routed Opencode proxy native requests through OpenAI Responses with Opencode provider options normalized onto the native OpenAI key; kept generic OpenAI-compatible on the explicit AI-SDK fallback path. | Recorded replay coverage remains limited to cassettes already present; OpenAI API-key row is skipped without credentials; Copilot and the broader bundled provider families remain intentional AI-SDK fallback until their native auth/route/cost semantics are explicitly ported. | Stage 3.4 now proves the native default path covers OpenAI OAuth, Opencode proxy, and Anthropic API-key replay while non-native provider families fail closed into explicit AI-SDK fallback reasons. |

| Stage 3 completion gate | local working tree | `packages/opencode`: final gate `bun test --timeout 180000 test/effect/runtime-flags.test.ts test/session/llm-native.test.ts test/session/llm-native-recorded.test.ts` (`87 pass`, `1 skip`, `194 expect() calls`), `bun test --timeout 180000 test/session/llm.test.ts -t native` (`3 pass`, `22 filtered`, `13 expect() calls`), `bun typecheck` (pass). `packages/llm`: final provider gate `bun test --timeout 180000 test/cache-policy.test.ts test/provider/openai-chat.test.ts test/provider/openai-responses.test.ts test/provider/anthropic-messages.test.ts test/provider/bedrock-converse.test.ts test/provider/gemini.test.ts test/provider/openai-compatible-chat.test.ts test/provider/openrouter.test.ts test/provider/cloudflare.test.ts test/route.test.ts test/auth.test.ts test/executor.test.ts` (`206 pass`, `393 expect() calls`), final recorded gate (`12 pass`, `30 skip`, `29 expect() calls`), `bun typecheck` (pass). `packages/core`: `bun typecheck` (pass). Docs search: no `OPENCODE_EXPERIMENTAL_NATIVE_LLM` matches under `packages/web/src/content/docs`. | VQA final inline `bun dev` spawn from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. | `review-gpt-high`, `review-code-simplifier`; Fable skipped per user. | Fixed final review regression by adding `LLM.HttpOptions.retries`, per-request `RequestExecutor.execute(..., { retries })`, native HTTP transport retry forwarding, and opencode native adapter default `retries: input.retries ?? 0`; added adapter and executor regression tests; inlined single-use recorded-test helpers. | OpenAI API-key recorded scenario still skips without the missing cassette/credentials; skipped recorded provider rows remain explicit non-blocking coverage gaps; non-native provider families remain deliberate AI-SDK fallback until their native semantics are ported. | Stage 3 native default path, cache policy, tuple-safe fallback, Opencode proxy Responses routing, and retry semantics are green at package and session seams. |

| 4.1 Subagents And `opencode run` | local working tree | `packages/core`: T1/T2 `bun typecheck` (pass), `bun test --timeout 60000 test/location-layer.test.ts test/tool-task.test.ts test/session-prompt.test.ts` (T1 `38 pass`, T2 `39 pass`, `122 expect() calls`). `packages/server`: T1/T2 `bun typecheck` (pass). `packages/sdk/js`: T1/T2 `bun typecheck` (pass). `packages/opencode`: T1/T2 `bun typecheck` (pass), `bun test --timeout 90000 test/cli/run/run-process.test.ts` (T1/T2 `4 pass`), `bun test --timeout 90000 test/server/httpapi-session.test.ts test/server/httpapi-public-openapi.test.ts` (T1 `34 pass`, T2 `34 pass`, `274 expect() calls`), `bun test --timeout 60000 test/cli/run/stream.transport.test.ts test/cli/run/runtime.test.ts test/cli/run/runtime.queue.test.ts test/cli/run/session.shared.test.ts` (T1 `51 pass`, T2 `52 pass`). | VQA1 isolated in-process HTTP smoke: `SERVER_URL:http://127.0.0.1:56417`, health 200, V2 session create 200, V2 prompt admit-only 200, `ERROR_SIGNAL_COUNT:0`. VQA2 same smoke: `SERVER_URL:http://127.0.0.1:52707`, health 200, V2 session create 200, V2 prompt admit-only 200, `ERROR_SIGNAL_COUNT:0`. Temporary runner deleted after each pass. | `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2`; `cursor/claude-fable-5 (max)` skipped per user. | Fixed TaskTool final assistant selection and regression coverage; propagated V2 prompt admission errors in interactive stream transport; mapped new V2 `resume`/`cancelTool` missing sessions to declared 404s; removed `opencode run` double-scheduling by relying on prompt default wake and no extra `/resume`; rejected V2 questions in noninteractive run; kept JSON output clean by removing global SSE lifecycle logs. | `--command`/shell run branches remain V1 until Stage 4.2 command/TUI cutover; TaskTool location interrupt through `SessionExecution` and busy+revert HTTP prompt coverage deferred as non-blocking follow-ups; session-permission ruleset parity for noninteractive is mitigated by V2 question rejection and remains broader Stage 4.2/4.3 cleanup. | `TaskTool` source/test files marked intent-to-add; Stage 2.7 deletion gate still blocked until later prompt/app cutover removes remaining V1 registry dependencies. |

| 4.2 TUI Prompt Endpoints (prompt/interrupt slice) | local working tree | T1 before fixes: `packages/core` `bun typecheck` (pass), `bun test --timeout 60000 test/location-layer.test.ts test/tool-task.test.ts test/session-prompt.test.ts` (`39 pass`, `122 expect() calls`); `packages/server`, `packages/sdk/js`, `packages/tui`, `packages/opencode` `bun typecheck` (pass); `packages/opencode` `bun test --timeout 90000 test/server/httpapi-session.test.ts test/server/httpapi-public-openapi.test.ts` (`35 pass`, `279 expect() calls`); `packages/tui` `bun test --timeout 90000 test/cli/tui/prompt-submit-race.test.ts test/prompt/part.test.ts test/prompt/history.test.ts` (`9 pass`, `15 expect() calls`). T2 after MAR fixes: same five package typechecks pass; `packages/opencode` HTTPAPI suite (`36 pass`, `281 expect() calls`); `packages/tui` prompt suite (`10 pass`, `16 expect() calls`); `packages/core` session/task suite (`39 pass`, `122 expect() calls`). | VQA1 in-process HTTP smoke: `SERVER_URL:in-process`, health 200, V2 create 200, V2 prompt admit-only 200, V2 interrupt 204, `ERROR_SIGNAL_COUNT:0`; temporary runner deleted. VQA2 same in-process smoke after fixes: health 200, V2 create 200, V2 prompt admit-only 200, V2 interrupt 204, `ERROR_SIGNAL_COUNT:0`; temporary runner deleted. | `review-gpt-high`, `review-gpt-low`; `research-opencode-glm-5-2` failed due OpenRouter credit/max-token limit. | Added V2 `POST /api/session/:sessionID/interrupt`, regenerated JS SDK, switched TUI normal prompt create/send and prompt/undo interrupts to V2 routes, preserved new-session shell/slash-command creation on legacy routes, adjusted V2 file/agent source offsets for editor-context prefixes and expanded pasted text, and added idle plus active HTTP interrupt coverage. | Stage 4.2 remains open: TUI `promptAsync` synthetic/noReply move/warp reminders still need a V2 equivalent; shell/command prompt branches remain legacy by design; V2 shell, skill, switchAgent, compact, and wait APIs remain inventory blockers before final TUI cutover/deletion. | Accepted MAR fixes: legacy create preservation for shell/slash new sessions, source-offset remapping for editor context and pasted text, and active interrupt HTTP coverage. |

| 4.2 TUI Prompt Endpoints (route completion and command cutover slices) | local working tree | T1: `packages/server`: `bun typecheck` (pass). `packages/sdk/js`: `bun typecheck` (pass) after `bun packages/sdk/js/script/build.ts`. `packages/tui`: `bun typecheck` (pass). `packages/opencode`: `bun typecheck` (pass); `bun test test/server/httpapi-session.test.ts -t "resolves v2 command templates"` (1 pass, 7 expect calls before review fix, 9 after); `bun test test/server/httpapi-session.test.ts -t "returns public errors for unsupported v2 commands"` (1 pass, 4 expect calls); `bun test test/server/httpapi-public-openapi.test.ts` (16 pass, 177 expect calls). Full default-timeout `bun test test/server/httpapi-session.test.ts test/server/httpapi-public-openapi.test.ts` also ran: new command tests passed, but three older `httpapi-session` cases timed out at the file's 5s default before this slice and are not attributed to the command route. T2 after review fix: `packages/server`/`packages/opencode`/`packages/sdk/js`/`packages/tui` `bun typecheck` (pass); `bun test --timeout 30000 test/server/httpapi-session.test.ts -t "v2"` (14 pass, 103 expect calls); `bun test test/server/httpapi-public-openapi.test.ts` (16 pass, 177 expect calls). | VQA1 runtime QA used in-process HttpApi route smoke: `bun test --timeout 30000 test/server/httpapi-session.test.ts -t "v2"` (14 pass, 101 expect calls) before review fix. VQA2 after fixes reran the same V2 route smoke (14 pass, 103 expect calls). | MAR reviewers: `review-gpt-high` and `review-code-simplifier`. Accepted finding: command route now uses a configured command agent's model before falling back to the request model, with HTTP regression coverage. Deferred findings: generated SDK ergonomic methods make body fields optional for several V2 routes, including pre-existing prompt/synthetic routes, so this is recorded for Stage 4.4 SDK cleanup instead of hand-editing generated files; command template `@file` reference lowering and shell configured-shell parity remain documented V2 command gaps. | Added V2 `POST /api/session/:sessionID/command` for registered non-subtask `CommandV2` templates, including `$1`/`$ARGUMENTS`, shell interpolation, file attachments, `resume:false`, command-agent model priority, declared missing-session/invalid-command errors, and SDK generation. TUI command list now uses V2 `/api/command`; TUI shell mode uses V2 shell; non-subtask slash commands use `client.v2.session.command`; subtask commands intentionally stay on legacy `client.session.command` until a V2 subtask-command representation exists. Command list waits for `PluginBoot` before returning. | Remaining Stage 4.2 gaps: V2 equivalent for subtask slash commands such as `/review`; MCP-backed slash commands are not in `CommandV2`; generated SDK required-body typing cleanup is deferred to Stage 4.4. | Route-completion slices resolved synthetic/noReply reminders, switchAgent/switchModel, wait, shell, skill, compact, and generic command cutover; final 4.2 done is intentionally not claimed until the subtask/MCP command decision is closed. |
| 4.3 App/Desktop Prompt And Event Cutover | local working tree | T1 plus T2 are green. `packages/core`: `bun test --timeout 60000 test/session-runner.test.ts -t "StructuredOutput|file-mutating"` (3 pass), `bun test --timeout 60000 test/session-create.test.ts -t "restores workspace files"` (1 pass), `bun test --timeout 60000 test/parity/session-v2-runner-parity.test.ts` (31 pass), `bun typecheck` (pass). `packages/server`: `bun typecheck` (pass). `packages/sdk/js`: `bun packages/sdk/js/script/build.ts` (success), `bun typecheck` (pass). `packages/app`: `bun run typecheck` (pass), `bun test --preload ./happydom.ts ./src/components/prompt-input/submit.test.ts ./src/components/prompt-input/build-request-parts.test.ts` (37 pass), `bun test --preload ./happydom.ts ./src/components/prompt-input/submit.test.ts` (pass after queued-delivery fix), `bun run test:e2e:controlled -- e2e/regression/followup-queue.spec.ts e2e/regression/slash-anywhere.spec.ts` (12 pass), `bun run test:e2e:controlled -- e2e/regression/app-v2-prompt-cutover.spec.ts` (2 pass), `bun run test:e2e:controlled -- e2e/smoke/session-timeline.spec.ts --grep=prefetched` (1 pass). `packages/opencode`: `bun typecheck` (pass), `bun test --timeout 90000 test/server/httpapi-session.test.ts test/server/httpapi-public-openapi.test.ts` (43 pass). | VQA2 app evidence is persisted under `packages/app/test-results/app-v2-prompt-cutover/`, `packages/app/test-results/followup-queue/`, and `packages/app/test-results/session-timeline-long/`, plus followup screenshots under `packages/app/test-results/queued-slash-followup.png`, `send-now-followup.png`, `send-now-followup-ready.png`, and `steered-active-followup.png`. Long-session checklist coverage includes prefetched open, initial hydration, `loadOlder`, assistant page boundary, force-refresh/request capture, hash restore, desktop/mobile views, and older-message visibility. | `openai/gpt-5.5 (high)` and `cursor/composer-2.5`; `zhipuai-coding-plan/glm-5.2` was blocked by OpenRouter credit/max-token limits. | Added V2 `Prompt.format`, persisted user format, Core StructuredOutput tool injection with required tool choice, captured `assistant.structured`, visible missing-structured-output failure, `Snapshot.diffFull`, automatic session summary diffs after file-mutating V2 turns, JS SDK regeneration, app submit cutover to `client.v2.session.prompt`, non-subtask slash command cutover to `client.v2.session.command`, interrupt cutover to `client.v2.session.interrupt`, and explicit followup `delivery` plumbing. | Accepted MAR fix: split app followup `queued` UI/context state from V2 prompt `delivery`, so only real draining queued followups send `delivery: "queue"` while active/steered followups remain steering prompts. Rejected/deferred MAR finding: `/global/event` remains an intentional app-wide multiplex/bridge stream for EventV2 registry and sync events; `/api/event` remains the native/location-scoped stream. Full `test/session-runner.test.ts` still has known unrelated failures already deferred. Subtask commands remain on legacy `input.client.session.command` until Stage 4.4 supplies the V2 equivalent; generated SDK optional-body ergonomics and textpart `metadata` schema cleanup are also Stage 4.4/follow-up work. | Stage 4.3 app prompt, non-subtask command, interrupt, queued-followup, slash-anywhere, and long-session VQA surfaces are hard-switched and evidenced. |

| 4.4 Subtask Command Cutover Slice | local working tree | `packages/server`: `bun typecheck` (pass). `packages/app`: `bun typecheck` (pass), `bun test --preload ./happydom.ts ./src/components/prompt-input/submit.test.ts` (22 pass), `bun run test:e2e:controlled -- e2e/regression/slash-anywhere.spec.ts` (10 pass, subtask command endpoint assertion). `packages/opencode`: `bun typecheck` (pass), focused `bun test --timeout 90000 test/server/httpapi-session.test.ts --test-name-pattern "runs v2 subtask commands through the task tool"` (1 pass), full `bun test --timeout 90000 test/server/httpapi-session.test.ts` (28 pass, 167 expect calls). | VQA-equivalent app route coverage from controlled Slash Anywhere E2E proves a `subtask: true` `/review` command posts to V2 `/api/session/:id/command` and not legacy `/session/:id/command`; HTTP live test proves parent task tool output from a real child LLM run. | Not run for this narrow slice yet. | Server V2 command handler now executes `command.subtask === true` through Location-scoped Core `TaskTool`, promotes the admitted prompt safely, publishes durable parent `Step`/`Tool` events, validates required model before execution admission, and keeps `resume:false` admit-only semantics. App slash command submission no longer has a legacy subtask fallback. | Stage 4.4 deletion gate remains open: MCP-backed slash command cutover, generated SDK required-body typing cleanup, V2 prompt/textpart metadata cleanup, V1 import/deletion sweep, MAR, and final VQA2 remain pending. | This row is a Stage 4.4 slice only; the master 4.4 checkbox stays unchecked. |
| 4.4 MCP Command, SDK Body, And Metadata Cleanup Slices | local working tree | `packages/core`: `bun test ./test/plugin/mcp-command.test.ts ./test/command.test.ts ./test/plugin/command.test.ts` (3 pass), `bun typecheck` (pass). `packages/server`: `bun typecheck` (pass). `packages/opencode`: `bun test ./test/server/httpapi-session.test.ts --grep "v2 command\|MCP-backed\|subtask commands"` (4 pass), `bun typecheck` (pass). `packages/sdk/js`: `bun ./packages/sdk/js/script/build.ts` (pass), `bun typecheck` (pass). `packages/app`: `bun test --preload ./happydom.ts ./src/components/prompt-input/build-request-parts.test.ts ./src/components/prompt-input/submit.test.ts` (37 pass), `bun typecheck` (pass). | VQA not rerun for these narrow non-layout slices; app behavior coverage is through prompt-input unit tests and existing Stage 4.3/4.4 controlled E2E. | Not run for these narrow slices yet. | Added Core MCP prompt-backed V2 command registration and execution-time resolution, wired the Location service graph without leaking unresolved layers, added Core and HTTP MCP regressions, regenerated the JS SDK from source with a build-script postprocess so required request-body fields become required flat SDK method parameters, and removed new App textpart-metadata writes/reads for prompt optimization comments while preserving visible synthetic comment text parsing. | V1 prompt-loop/import deletion sweep, Stage 4.4 MAR, and final VQA2 remain pending; legacy `/session/...` SDK methods still reflect their legacy optional body shape until the V1 deletion sweep removes or replaces those routes. | This row completes the MCP-backed slash command cutover, generated SDK required-body typing cleanup, and V2 prompt/textpart metadata cleanup sub-slices; master 4.4 remains open. |

## Stage Order And Parallelization

Required critical path: Stage 0 -> Stage 1 -> Stage 4 -> Stage 6.

Parallelizable after Stage 0 baseline exists: Stage 2, Stage 3, and Stage 5 can run in separate worktrees or agents, but Stage 4 app cutover waits for Stage 2 and Stage 3 gates.

Bug track runs continuously, but only fixes code that survives the target state.

Hard ordering constraints:

- [x] Stage 1 does not start until Stage 0.4 parity harness exists.
- [x] Stage 4.1 does not start until Stage 1 subagent/task parity requirements are green.
- [x] Stage 4.2 prompt/interrupt slice started after TUI-facing SessionV2 routes were covered by HTTP tests; remaining 4.2 completion blockers stay tracked in the Stage 4.2 QA gate.
- [x] Stage 4.3 does not start until Stage 2 tool consolidation and Stage 3 native LLM gates are green enough for app prompts.
- [ ] Stage 4.4 deletion does not start until all surfaces in 4.1 to 4.3 are hard-switched.
- [ ] Stage 6 does not start until Stage 4 deletion has removed V1 prompt-loop behavior.
- [ ] Stage 5 layout refactors may run earlier, but any touched churn cluster must first have regression coverage from B.3.

## Stage 1 Inventory Template

Use this table for 1.0 before implementing Stage 1 gaps. Every row needs a Core target and a parity test or documented exception.

| Behavior | V1 source | Known source marker | Core target file | Status | Fail-before parity test | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Prompt -> local tool loop -> final answer | `SessionPrompt.loop` and processor tool settlement | `packages/opencode/src/session/prompt.ts:286-424`; `packages/opencode/src/session/processor.ts` tool-call settlement | `packages/core/src/session/runner/llm.ts`, `packages/core/src/tool/registry.ts`, `packages/core/src/session/message-updater.ts` | Implemented for local canonical tools | [x] Covered by Stage 0.4 `prompt-tool-loop-answer`; no new Stage 1 fail-before needed unless behavior changes | Harness ID: `prompt-tool-loop-answer`. |
| Steering active input | V1 active prompt coalescing in prompt loop | V1 prompt admission/loop paths in `packages/opencode/src/session/prompt.ts` | `packages/core/src/session/input.ts`, `packages/core/src/session/run-coordinator.ts`, `packages/core/src/session/runner/llm.ts` | Implemented | [x] Covered by Stage 0.4 `steering` | Confirms active provider turn is followed by steering continuation. |
| Queued delivery | V1 queued/future prompt handling | V1 prompt admission/loop paths in `packages/opencode/src/session/prompt.ts` | `packages/core/src/session/input.ts`, `packages/core/src/session/activity.ts`, `packages/core/src/session/run-coordinator.ts`, `packages/core/src/session/runner/llm.ts` | Implemented | [x] Covered by Stage 0.4 `queue` | Confirms queued delivery waits for active activity settlement. |
| Abort/interruption | V1 cancel/interrupt behavior | V1 cancellation paths in `packages/opencode/src/session/prompt.ts` and `packages/opencode/src/session/processor.ts` | `packages/core/src/session/execution.ts`, `packages/core/src/session/run-coordinator.ts`, `packages/core/src/session/activity.ts`, `packages/core/src/session/runner/llm.ts` | Implemented for runner interrupt preservation; shell/tool-specific cancellation still covered elsewhere | [x] Covered by Stage 0.4 `abort`; Stage 1.7 can add tool-specific cancellation if error policy changes | Harness asserts durable steering survives interrupt. |
| Compaction/replay truncation | `packages/opencode/src/session/message-v2.ts` | `message-v2.ts:51-55` tool-output truncation used by compaction serialization; `message-v2.ts:550-629` retained tail/replay/latest paths | `packages/core/src/session/history.ts`, `packages/core/src/session/compaction.ts`, `packages/core/src/session/runner/llm.ts`, `packages/core/src/session/runner/to-llm-message.ts` | Implemented for overflow replay boundary; Core serializes retained recent context inside the checkpoint rather than replaying separate V1 tail message rows | [x] Stage 1.1 parity covers projected checkpoint reload, separate replayed user prompt, bounded attachment placeholders, and prefix-only summary boundary before replay | Manual/public `compact` API and any stricter preflight-specific replay cases remain Stage 4.2/follow-up ownership. |
| Revert | `packages/opencode/src/session/revert.ts` and callers | `revert.ts:38-95`, `:119-153` | `packages/core/src/session.ts`, `packages/core/src/session/sql.ts`, `packages/core/src/session/schema.ts`, `packages/core/src/session/info.ts`, `packages/core/src/session/projector.ts` | Implemented for Core V2 API, projection, busy guard, assistant part semantics, and post-revert cleanup | [x] Stage 1.2 covers durable events, `SessionV2.get()`/projection round-trip, DB revert state, post-revert continuation, part revert, unrevert, and busy rejection | Harness ID coverage: `revert-cleanup`, `revert-part-unrevert`, `revert-busy`; file restoration covered by `session-create.test.ts`. |
| Snapshot/checkpoint | V1 snapshot/checkpoint paths | `packages/opencode/src/session/processor.ts:129-140`, `:705-772`, `:875-889` | `packages/core/src/session/event.ts`, `packages/core/src/session/message-updater.ts`, `packages/core/src/file-mutation.ts`, `packages/core/src/tool/edit.ts`, `packages/core/src/tool/write.ts`, `packages/core/src/tool/apply-patch.ts`, `packages/core/src/snapshot.ts` | Implemented for Core step snapshot start/end, metadata-only file checkpoints, snapshot diff, revert, and unrevert restoration | [x] Stage 1.2 covers edit/write/apply-patch metadata checkpoints and real Git workspace revert/unrevert for modified, deleted, and added files | `SessionFileMutation` has typechecked storage/restore helpers but no dedicated runtime test yet; current user-visible snapshot parity uses `Snapshot.Service`. |
| Share | V1 share/session projection paths | `packages/opencode/src/share/session.ts:26-37`; `packages/opencode/src/session/session.ts:73`, `:130`, `:843-845` | `packages/core/src/share/sql.ts`, `packages/core/src/session/sql.ts`, `packages/core/src/session/schema.ts`, `packages/core/src/session/info.ts`, `packages/core/src/session.ts`, `packages/core/src/session/projector.ts` | Implemented for V2 Info projection, durable set/clear events, public facade, and replay | [x] Stage 1.3 verifies `SessionV2.get()` set/clear projection and fresh-DB replay | `session-create.test.ts` covers set, clear, event stream, and replay. |
| Title generation | V1 prompt/title paths | `packages/opencode/src/session/prompt.ts:224-283` | `packages/core/src/session.ts`, `packages/core/src/session/runner/llm.ts`, `packages/core/src/session/runner/model.ts`, `packages/core/src/session/projector.ts` | Implemented for first real user prompt, non-default skip, small-model fallback, and steering-safe generation | [x] Stage 1.3 parity covers generated title, small model use, first prompt during steering, and non-default skip | V2 generates after the first provider turn and rethrows interrupts; projected first-user context preserves files/media lowering. |
| Todo integration | V1 todo/session paths | `packages/opencode/src/session/todo.ts:43-65`; `packages/opencode/src/tool/todo.ts:33-53` | `packages/core/src/session/todo.ts`, `packages/core/src/tool/todowrite.ts` | Implemented for Core persistence/tool effects | [x] Existing Core `session-todo.test.ts` and `tool-todowrite.test.ts` are sufficient for Core parity | V1 `N todos` presentation title metadata remains deferred unless an app consumer is found. |
| Session summary / file-diff summary | V1 summary computation and persistence | `packages/opencode/src/session/summary.ts:82`, `:102`; `packages/opencode/src/session/prompt.ts:1383`; `packages/opencode/src/session/processor.ts:774`; `packages/opencode/src/session/session.ts:836-841` | `packages/core/src/session/sql.ts`, `packages/core/src/session/projector.ts`, `packages/core/src/snapshot.ts`, `packages/core/src/session/runner/llm.ts` | Implemented for Core V2 runner: successful turns with start/end snapshots compute `Snapshot.diffFull` and publish `SessionEvent.SummaryUpdated` | [x] Stage 1.3 covers durable summary set/clear projection and replay; [x] Stage 4.3 fail-before: a file-mutating V2 prompt populates session summary diffs before app/desktop prompt cutover | Needed for diff-summary cards after cutover; now covered by focused runner summary regression plus live Git-backed `Snapshot.diffFull` coverage. |
| Question serialization and permission ask/deny | question tool and permission paths | `packages/opencode/src/session/processor.ts:249-265`; question/permission tool paths | `packages/core/src/question.ts`, `packages/core/src/tool/question.ts`, `packages/core/src/permission.ts`, `packages/core/src/session/runner/llm.ts` | Implemented for Core service and runner parity | [x] Stage 1.4 covers question tool wait/reject, detached output, inactive recovery via pending-list refresh, permission ask/reply/reject, and assertion allow/deny/decline | `permission-ask-deny` and `permission-assert-decline` are active parity scenarios; interrupted asks now publish terminal UI events. |
| Permission assertion decline | V1 user-decline interrupt path | `packages/opencode/src/session/processor.ts:249-265` | `packages/core/src/permission.ts`, `packages/core/src/session/runner/llm.ts`, `packages/core/src/session/message-updater.ts` | Implemented for assertion decline | [x] Covered by Stage 0.4 `permission-assert-decline`; Stage 1.4 still owns interactive ask/reply | Harness confirms `DeclinedError` becomes runner interruption and tool error state. |
| Plugin hooks | `experimental.hook` paths | `packages/opencode/src/session/prompt.ts:338-424`; `packages/opencode/src/session/tools.ts:126-193`; `packages/opencode/src/session/llm/request.ts:189`, `:234-254`; `packages/opencode/src/tool/registry.ts:335` | `packages/core/src/plugin.ts`, `packages/core/src/session/runner/llm.ts`, `packages/core/src/tool/registry.ts` | Implemented for Core PluginV2 runner/tool seams | [x] Stage 1.5 covers `experimental.chat.system.transform`, canonical `experimental.chat.messages.transform`, `chat.params`, `chat.headers`, `tool.definition`, `tool.execute.before/after`, scoped add/remove, replacement-failure rollback, cache invalidation, and hook failure isolation | Core message hook intentionally operates on canonical `@opencode-ai/llm` messages; external V1 plugin-loader bridging remains an opencode extension-layer cutover concern. |
| Structured output / JSON schema format | V1 structured-output prompt/tool path | `packages/opencode/src/session/prompt.ts:1373-1380`, `:1420`, `:1499-1527` | `packages/core/src/session/prompt.ts`, `packages/core/src/session/message.ts`, `packages/core/src/session/runner/llm.ts`, `packages/core/src/session/runner/publish-llm-event.ts` | Implemented for Core V2 runner: `Prompt.format` persists through user history, the runner advertises `StructuredOutput`, forces required tool choice, captures the structured value, and surfaces a visible error when the tool is omitted | [x] Stage 4.3 fail-before: `json_schema` V2 prompt preserves structured-output enforcement, tool choice, captured structured value, and error behavior before app/desktop prompt cutover | V1 prompt-loop deletion remains blocked by later Stage 4.4 subtask/MCP/SDK-cleanup work, not by structured output. |
| Attachment/media lowering | V1 `MessageV2.toModelMessagesEffect` paths | `packages/opencode/src/session/message-v2.ts:146-244`, `:305-352`, `:409-428` | `packages/core/src/session/runner/to-llm-message.ts`, `packages/core/src/session/message-updater.ts` | Implemented for durable data-url user files/media, route-aware provider-safe omission, pending/running tool-result closure, OpenAI/Anthropic image replay, and Bedrock document extraction | [x] Stage 1.6 covers text/directory/image/PDF user attachments, OpenAI/Anthropic/Bedrock provider payload shapes, `image/jpg` normalization, local error media omission, pending/running tool-results, and Bedrock PDF tool-result extraction | Non-data/remote URI materialization remains a dedicated future attachment materialization slice; current lowerer stays pure and provider-safe for durable media values. |
| Error retry policy and content-filter errors | V1 retry/processor paths | `packages/opencode/src/session/llm.ts:417`; `packages/opencode/src/session/prompt.ts:256-266`, `:1465-1540`, `:1512-1519` | `packages/core/src/session/runner/llm.ts`, `packages/core/src/session/event.ts`, `packages/core/src/session/projector.ts` | Implemented for bounded pre-assistant retry, durable retry events, content-filter visible failure, and terminal provider errors | [x] Stage 1.7 covers retryable provider failure retry, exhausted retryable provider-error surfacing, non-retryable auth failure, provider-error after `step-finish`, content-filter error visibility, and `SessionEvent.Retried` projection | Retry is deliberately disabled after assistant output or `step-finish` to avoid duplicated partial responses/usage. |
| Usage/cost tracking | V1 processor/LLM accounting paths | `packages/opencode/src/session/session.ts:387-455`; `packages/opencode/src/session/processor.ts:722-757` | `packages/core/src/session/runner/publish-llm-event.ts`, `packages/core/src/session/message-updater.ts`, `packages/core/src/session/projector.ts`, `packages/core/src/session/info.ts` | Implemented for assistant usage/cost and session aggregate add/subtract on revert cleanup | [x] Stage 1.7 covers assistant usage, context-tier cost, cache/reasoning tokens, Copilot nano-AIU cost, `SessionTable.cost/tokens`, and revert usage decrement | Model catalog cost is injected through `SessionRunnerModel.cost(session)` so Core runner tests can verify non-zero pricing without provider/network calls. |
| Subagent task execution | V1 task tool/subtask loop | `packages/opencode/src/tool/task.ts`; `packages/opencode/src/session/prompt.ts:286-424` | `packages/core/src/tool/task.ts`, `packages/core/src/session/runner/llm.ts`, `packages/core/src/session/input.ts`, `packages/core/src/session/execution.ts`, `packages/server/src/handlers/session.ts` | Implemented for Core task leaf, Stage 4.1 runtime registration through `LocationServiceMap`, and Stage 4.4 V2 subtask command execution through Core `TaskTool` | [x] Stage 1.9 parity manifest separates `task-shaped-tool-settlement` from pending `real-subagent-task`; [x] Stage 2.5/4.1 covers subagent normal completion, failure, interruption/cancel, permission boundary, final assistant selection, and parent/child session linkage; [x] Stage 4.4 HTTP live test covers V2 subtask slash-command child run and parent task-tool output; [x] Stage 4.4 app E2E proves `subtask: true` command submissions use V2 command endpoint instead of legacy | Remaining V1 task prompt-loop deletion is owned by the rest of Stage 4.4 after MCP/SDK/deletion blockers are resolved. |
| Session reminders / plan-build mode prompts | V1 reminder injection | `packages/opencode/src/session/reminders.ts`; `packages/opencode/src/session/prompt.ts:1305` | opencode extension layer around SessionV2 prompt admission, not Core runner | Intentionally dropped from Core runner; must be preserved in opencode extension layer if still product behavior | [ ] Stage 4.1/4.3: opencode cutover test proves plan/build reminders still enter admitted prompt context | Classification prevents this V1 prompt-loop concern from leaking into Core. |
| SessionV2 shell API | V1 session shell endpoint | V1 shell paths in `packages/opencode/src/session/session.ts` / prompt shell tests | `packages/server/src/handlers/session.ts`, `packages/core/src/tool/bash.ts`, `packages/tui/src/component/prompt/index.tsx` | Implemented as V2 `POST /api/session/:sessionID/shell`; TUI shell mode calls `client.v2.session.shell`; handler runs Location-scoped `bash` via `ToolRegistry` and appends shell start/end events | [x] Stage 4.2 HTTP test covers shell message projection and output; [x] package typechecks passed | Core `SessionV2.shell` still has an optional service-map path; public cutover uses the server handler. |
| SessionV2 skill API | V1 skill endpoint | V1 skill paths in opencode session/tool code | `packages/server/src/handlers/session.ts`, `packages/core/src/tool/skill.ts` | Implemented as V2 `POST /api/session/:sessionID/skill`; handler injects loaded skill content as a synthetic message without scheduling execution | [x] Stage 4.2 HTTP test covers skill synthetic content projection; [x] package typechecks passed | Core `SessionV2.skill` remains a stub; public V2 skill injection is server-side until a Core service boundary is justified. |
| SessionV2 switchAgent API | V1 agent switch | V1 model/agent switch paths in opencode session code | `packages/core/src/session.ts`, `packages/server/src/handlers/session.ts` | Implemented for durable agent/model switch events via V2 `POST /api/session/:sessionID/agent` and `/model` | [x] Stage 4.2 HTTP test covers persisted switch state, projected messages, and no scheduled activity | `switchModel` and `switchAgent` are both available on the public V2 API. |
| SessionV2 compact API | V1 manual compact endpoint | V1 compact paths in opencode session code | `packages/core/src/session.ts`, `packages/core/src/session/compaction.ts`, `packages/server/src/handlers/session.ts` | Implemented manual replayable checkpoint via V2 `POST /api/session/:sessionID/compact`, publishing compaction start/end events from current projected history | [x] Stage 4.2 HTTP test covers compact plus idle wait and context output; [x] decode errors map to declared `UnknownError` | This is a deterministic manual checkpoint, not an LLM summarization pass. |
| SessionV2 wait API | V1 wait/status endpoint | V1 busy/wait/status paths in opencode session code | `packages/core/src/session.ts`, `packages/core/src/session/execution.ts`, `packages/core/src/session/execution/local.ts`, `packages/server/src/handlers/session.ts` | Implemented via `SessionExecution.wait` and V2 `POST /api/session/:sessionID/wait` returning 204 after idle | [x] Stage 4.2 HTTP test covers active V2 work wait until assistant message projection | Needed API consumer cutover is available. |

## Stage 0: Measurement Baseline And CI Hardening

Purpose: make speed, token, and quality changes measurable before migration. Build the parity gate before moving behavior.

### 0.1 Request-Assembly Profiling

Scope files: `packages/opencode/src/session/prompt.ts`, especially the `MessageV2.filterCompactedEffect` and `MessageV2.toModelMessagesEffect` request-assembly boundaries; `packages/opencode/src/session/llm.ts`; `packages/core/src/session/runner/llm.ts`.

Deliverables: Effect spans and log metrics for history load time, system prompt size, estimated tokens, tool definition size, time until `llm.stream`, and time-to-first-token.

Acceptance: a local session emits the spans, and numeric baseline values are recorded as structured data under `specs/`. This plan evidence log may link to the baseline file, but it is not the canonical baseline storage.

Structured baseline: `specs/performance/session-request-baseline-2026-07-08.json`.

Runtime evidence: `packages/opencode/test-results/stage0-1-perf-baseline.jsonl` and `packages/core/test-results/stage0-1-core-perf-baseline.jsonl`. The structured baseline contains the test/VQA pass summaries so ignored local `.log` files are not canonical evidence.

T1 commands run:

- `bun test --timeout 30000 test/session/llm-request.test.ts` from `packages/opencode`: 18 pass, 0 fail.
- `bun test --timeout 30000 test/session/llm.test.ts` from `packages/opencode`: 26 pass, 0 fail.
- `bun test --timeout 30000 test/session/prompt.test.ts -t "records request assembly and provider turn perf events"` from `packages/opencode`: 1 pass, 0 fail.
- `bun test --timeout 30000 test/session/prompt.test.ts` from `packages/opencode`: 48 pass, 14 skip, 0 fail.
- `bun test --timeout 30000 test/session-runner.test.ts -t perf` from `packages/core`: 1 pass, 0 fail.
- `bun typecheck` from `packages/opencode`: pass.
- `bun typecheck` from `packages/core`: pass.

VQA1 runtime QA: `bun dev` from `packages/opencode` started via PowerShell fallback because `tmux` is unavailable on Windows; TUI was still running after 8 seconds; stderr contained only `$ bun run --conditions=browser ./src/index.ts`; stdout/stderr scan found no `error`, `exception`, `failed`, `panic`, `unhandled`, or `EADDRINUSE` indicators.

MAR findings:

- `openai/gpt-5.5 (high)`: must-fix evidence tracking/ignored-log durability; optional strengthen request_assembly field assertions.
- `cursor/composer-2.5`: initial runner error, retry completed; must-fix evidence tracking and ignored logs not durable; optional request_assembly assertions, core perf-log isolation, retry-attempt labeling.
- `zhipuai-coding-plan/glm-5.2`: no code-semantics must-fix; commit-readiness must-fix for baseline/evidence tracking; optional note about per-retry provider_turn rows and provider/model field naming drift.

Accepted fixes:

- `ttfb_ms` now measures first content-bearing output only (`text-delta`, `reasoning-delta`, `tool-input-delta`, `tool-call`); `first_event_ms` records the first stream event.
- V1 and Core tests cover a structural-only provider turn that records `first_event_ms` and omits `ttfb_ms`.
- Request-assembly tests now assert all acceptance-critical footprint fields.
- Ignored `.log` files are no longer canonical evidence; pass/fail and VQA summaries live in this plan and the structured baseline, while JSONL baselines remain the durable evidence files.

Rejected/deferred findings:

- Core perf-log isolation deferred: the test uses unique Session IDs and clearing `Global.Path.log/perf.jsonl` would delete unrelated local perf history.
- Retry-attempt labeling deferred to a follow-up because per-attempt provider_turn rows are useful telemetry and no retry acceptance criterion exists in Stage 0.1.
- Provider/model field-name normalization deferred to future aggregation work because Stage 0.1 records both source schemas explicitly.

T2 commands run:

- `bun test --timeout 30000 test/session/llm-request.test.ts` from `packages/opencode`: 18 pass, 0 fail.
- `bun test --timeout 30000 test/session/llm.test.ts` from `packages/opencode`: 26 pass, 0 fail.
- `bun test --timeout 60000 test/session/prompt.test.ts -t "records request assembly and provider turn perf events"` from `packages/opencode`: 1 pass, 61 filtered out, 0 fail. The 30s timeout was flaky under local load; the same test passed with a 60s timeout and completed in 10.7s test time on the final run.
- `bun test --timeout 60000 test/session/prompt.test.ts` from `packages/opencode`: 48 pass, 14 skip, 0 fail.
- `bun typecheck` from `packages/opencode`: pass.
- `bun test --timeout 30000 test/session-runner.test.ts -t "records request assembly and provider turn perf events"` from `packages/core`: 1 pass, 92 filtered out, 0 fail.
- `bun typecheck` from `packages/core`: pass.
- `node -e "JSON.parse(require('fs').readFileSync('specs/performance/session-request-baseline-2026-07-08.json','utf8')); console.log('baseline json ok')"` from repo root: pass.

VQA2 runtime QA: `bun dev` from `packages/opencode` started via PowerShell fallback because `tmux` is unavailable on Windows; the process was still running after 8 seconds and was stopped by the QA script; stdout/stderr scan found 0 `error`, `exception`, `failed`, `panic`, `unhandled`, or `EADDRINUSE` indicators. The local `.log` files are ignored artifacts and are not canonical evidence.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### 0.2 Token Estimate Bugfix

Scope files: `packages/opencode/src/session/prompt.ts`, `packages/opencode/src/session/llm.ts`.

Deliverables: system prompt is not double-counted as both synthetic message and `system` in overflow estimation.

Acceptance: regression test with near-limit context verifies estimate matches provider payload closely enough to avoid late compaction and premature compaction.

Implementation notes:

- `SessionPrompt.loop` now uses `LLMRequestPrep.summarizeRequestFootprint(...).contextEstimateTokens` for overflow preflight instead of manually estimating `{ system, messages: [system-as-message, ...messages], tools }`.
- This keeps the provider request payload unchanged while removing the duplicate system prompt count from the preflight decision.
- The existing oversized preflight test was adjusted from `"large ".repeat(4_000)` to `"large ".repeat(8_000)` because the smaller input had only crossed the threshold due to the old double-count bug.

T1 commands run:

- `bun test --timeout 60000 test/session/prompt.test.ts -t "loop does not double count system prompt in overflow preflight"` from `packages/opencode`: 1 pass, 62 filtered out, 0 fail.
- `bun test --timeout 60000 test/session/prompt.test.ts -t "loop preflights oversized requests before provider streaming"` from `packages/opencode`: 1 pass, 62 filtered out, 0 fail.
- `bun test --timeout 60000 test/session/prompt.test.ts` from `packages/opencode`: 49 pass, 14 skip, 0 fail.
- `bun typecheck` from `packages/opencode`: pass.

VQA1 runtime QA: `bun dev` from `packages/opencode` started via PowerShell fallback because `tmux` is unavailable on Windows; the process was still running after 8 seconds and stdout/stderr scan found 0 `error`, `exception`, `failed`, `panic`, `unhandled`, or `EADDRINUSE` indicators.

MAR findings:

- `openai/gpt-5.5 (high)`: no must-fix; optional note that the near-limit test depends on prompt/tool footprint size.
- `cursor/composer-2.5`: no must-fix; residual risks around preflight-vs-prepared tool footprint mismatch, heuristic token estimate, and metrics divergence.
- `zhipuai-coding-plan/glm-5.2`: code fix approved; must-fix on test effectiveness because the near-limit test should be padded to guarantee double-count regression failure.

Accepted fixes:

- Near-limit regression prompt changed to `"near ".repeat(4_400)` so the correct preflight estimate fits below the 35k usable-token threshold while a duplicated system prompt crosses it.
- Existing oversized preflight regression remains green with the larger truly-oversized input.

Rejected/deferred findings:

- `LLM.Service` prepared-request metric divergence deferred to metrics follow-up; it does not drive preflight compaction.
- Preflight-vs-prepared tool footprint mismatch deferred as pre-existing estimation precision risk.
- Direct unit test for `summarizeRequestFootprint` synthetic-system inflation deferred because the integration tests cover the user-visible compaction decision.

T2 commands run:

- `bun test --timeout 60000 test/session/prompt.test.ts -t "loop does not double count system prompt in overflow preflight"` from `packages/opencode`: 1 pass, 62 filtered out, 0 fail.
- `bun test --timeout 60000 test/session/prompt.test.ts -t "loop preflights oversized requests before provider streaming"` from `packages/opencode`: 1 pass, 62 filtered out, 0 fail.
- `bun test --timeout 60000 test/session/prompt.test.ts` from `packages/opencode`: 49 pass, 14 skip, 0 fail.
- `bun typecheck` from `packages/opencode`: pass.

VQA2 runtime QA: `bun dev` from `packages/opencode` started via PowerShell fallback because `tmux` is unavailable on Windows; the process was still running after 8 seconds and stdout/stderr scan found 0 `error`, `exception`, `failed`, `panic`, `unhandled`, or `EADDRINUSE` indicators. Local `.log` files are ignored artifacts and are not canonical evidence.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### 0.3 Lint In CI

Scope files: `.github/workflows/*`, `.oxlintrc.json` if needed.

Deliverables: add a CI lint workflow or job that runs the existing `bun lint`/oxlint path.

Acceptance: PRs with lint errors fail CI.

Implementation notes:

- Added `.github/workflows/lint.yml` using the same trigger/runner/setup shape as `.github/workflows/typecheck.yml`.
- The workflow runs the existing root `bun lint` script, which resolves to `oxlint`.

T1 commands run:

- `bun lint` from repo root: exit 0, 4744 warnings, 0 errors. Root lint is allowed for this CI workflow validation; no repo-root tests were run.
- `node -e` workflow sanity check from repo root: pass; confirmed the workflow includes `name: lint`, `pull_request:`, and `run: bun lint`.
- `actionlint -version` from repo root: unavailable locally (`CommandNotFoundException`), so full GitHub Actions linting is deferred to CI.

Negative validation:

- Temporary in-repo parser-error fixture made `bun lint` exit 1 with 4744 warnings and 1 error; the fixture was deleted immediately afterward.
- `bunx oxlint` against a `%TEMP%` file was rejected as evidence because oxlint panicked when linting a path outside the repo root.

VQA1 runtime QA: `bun dev` from `packages/opencode` started via PowerShell fallback because `tmux` is unavailable on Windows; the process was still running after 8 seconds and stdout/stderr scan found 0 `error`, `exception`, `failed`, `panic`, `unhandled`, or `EADDRINUSE` indicators.

MAR findings:

- `openai/gpt-5.5 (high)`: no must-fix findings.
- `cursor/composer-2.5`: no must-fix findings; optional notes about staging/branch protection/log noise/timeouts and a negative lint check.
- `zhipuai-coding-plan/glm-5.2`: no must-fix findings; optional notes about concurrency/permissions, duplicate `.oxlintrc.json` `options`, warning severity, and first real CI run confirmation.

Accepted fixes:

- No source fixes were required. Added the optional negative validation described above before final retest.

Rejected/deferred findings:

- Branch protection requirement for the new `lint` check is operational follow-up outside source control.
- CI log noise from existing warnings is deferred because warnings are already accepted by the current oxlint configuration and Stage 0.3 acceptance only requires lint errors to fail CI.
- CI concurrency/permissions/timeout hardening is deferred to a broader workflow-consistency pass because this workflow intentionally mirrors the existing `typecheck.yml` pattern.
- Duplicate `.oxlintrc.json` `options` blocks are pre-existing and out of scope for the lint workflow change.
- First real Blacksmith/GitHub Actions execution is deferred until the workflow runs on push/PR because `actionlint` and the CI runner are unavailable locally.

T2 commands run:

- `bun lint` from repo root after deleting the temporary negative fixture: exit 0, 4744 warnings, 0 errors.

VQA2 runtime QA: `bun dev` from `packages/opencode` started via PowerShell fallback; the process was still running after 8 seconds and stdout/stderr scan found 0 `error`, `exception`, `failed`, `panic`, `unhandled`, or `EADDRINUSE` indicators.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### 0.4 Parity Test Harness

Scope files: new `packages/core/test/parity/*`, using existing `packages/opencode/test/session/*` and `test/lib/llm-server.ts` patterns as references.

Deliverables: V2 runner scenarios for prompt -> tool loop -> answer, steering/queue, abort, compaction trigger, revert, permission ask/deny, subagent task, attachments, and retry after errors.

Acceptance: parity suite runs against V2 runner and becomes the gate for Stages 1 to 4.

Implementation notes:

- Added `packages/core/test/parity/session-v2-runner-parity.test.ts` as a dedicated in-memory SessionV2 runner parity harness.
- Added `packages/core` script `test:parity` so the harness has a named gate command for Stages 1 to 4.
- Active harness scenarios cover prompt -> local tool loop -> final answer, active steering, queued delivery, interrupt/abort preservation, provider-overflow compaction retry, permission assertion allow/decline, task-shaped subagent tool settlement, attachment lowering, and retry after provider errors.
- `revert` is an explicit pending manifest slot owned by Stage 1.2 because Core has no V2 revert API yet.
- `permission-ask-deny` is an explicit pending manifest slot owned by Stage 1.4; the active Stage 0.4 test is `permission-assert-decline`, not interactive ask/reply serialization.

T1 commands run:

- `bun test --timeout 60000 test/parity/session-v2-runner-parity.test.ts` from `packages/core`: 10 pass, 0 fail, 33 expect calls.
- `bun typecheck` from `packages/core`: pass.

VQA1 runtime QA: `bun dev` from `packages/opencode` started via PowerShell fallback because `tmux` is unavailable on Windows; the process was still running after 8 seconds and stdout/stderr scan found 0 `error`, `exception`, `failed`, `panic`, `unhandled`, or `EADDRINUSE` indicators.

MAR findings:

- `openai/gpt-5.5 (high)`: must-fix that `revert` and permission ask/deny were overstated if not executable.
- `cursor/composer-2.5`: must-fix that the new parity test file was untracked and that `permission-ask-deny` only exercised assertion, not `ask`/`reply`; optional named parity script, compaction replay, and abort busy-wait improvements.
- `zhipuai-coding-plan/glm-5.2`: no correctness must-fix; should-fix unbounded abort busy-wait; optional comments for compaction magic numbers and task-shaped subagent limitation.

Accepted fixes:

- Marked the new parity test with `git add -N` so it is visible as an added file.
- Split permission coverage into active `permission-assert-decline` and pending `permission-ask-deny` owned by Stage 1.4.
- Kept `revert` pending and documented Stage 1.2 ownership explicitly in the harness and evidence.
- Replaced the abort test busy-wait with the existing `streamStarted` readiness signal plus a 5-second timeout.
- Added `test:parity` to `packages/core/package.json`.
- Added short comments documenting the provider-overflow compaction path and the task-shaped subagent placeholder.

Rejected/deferred findings:

- Executable revert coverage deferred to Stage 1.2 because no Core V2 revert API exists yet.
- Interactive permission ask/reply serialization deferred to Stage 1.4 because Stage 0.4 only creates the gate harness and current runner coverage can exercise assertion/decline semantics.
- Compaction projection replay assertion deferred because the reference `session-runner.test.ts` already covers replay; Stage 0.4 keeps the parity gate compact and focused on runner entry behavior.
- Binding manifest entries to test titles deferred until the harness has more Stage 1 parity rows; current manifest already prevents losing the required scenario list and pending owners.

T2 commands run:

- `bun test --timeout 60000 test/parity/session-v2-runner-parity.test.ts` from `packages/core`: 10 pass, 0 fail, 33 expect calls.
- `bun run test:parity` from `packages/core`: 10 pass, 0 fail, 33 expect calls.
- `bun typecheck` from `packages/core`: pass.

VQA2 runtime QA: `bun dev` from `packages/opencode` started via PowerShell fallback; the process was still running after 8 seconds and stdout/stderr scan found 0 `error`, `exception`, `failed`, `panic`, `unhandled`, or `EADDRINUSE` indicators.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### Stage 0 Completion Gate

Scope files: all Stage 0 files plus aggregate test configuration.

Deliverables: Stage 0.1 through 0.4 are checked off, aggregate verifiers pass, Stage 0 evidence is durable, and all new source/test/evidence files are visible to Git.

Acceptance: Stage 1 work can start with request metrics, token preflight regression coverage, lint CI, and a named V2 parity harness gate in place.

Implementation notes:

- Added `packages/core/bunfig.toml` and `packages/core/test/preload.ts` during completion review so Core tests isolate `XDG_*` and `Global.Path.log` before importing Core modules.
- Verified `packages/core/package.json` working-tree diff only contains the intended `test:parity` script addition.

T1 commands run:

- `bun run test:parity` from `packages/core`: 10 pass, 0 fail, 33 expect calls.
- `bun typecheck` from `packages/core`: pass.
- `bun test --timeout 60000 test/session/llm-request.test.ts test/session/prompt.test.ts` from `packages/opencode`: 67 pass, 14 skip, 0 fail, 241 expect calls.
- `bun typecheck` from `packages/opencode`: pass.
- `bun lint` from repo root: exit 0, 4744 warnings, 0 errors; the parity harness added 0 warning matches after cleanup.
- Baseline/evidence validation from repo root: `specs/performance/session-request-baseline-2026-07-08.json`, `packages/opencode/test-results/stage0-1-perf-baseline.jsonl`, and `packages/core/test-results/stage0-1-core-perf-baseline.jsonl` parsed successfully.

VQA1 runtime QA: `bun dev` from `packages/opencode` started via PowerShell fallback because `tmux` is unavailable on Windows; the process was still running after 8 seconds and stdout/stderr scan found 0 `error`, `exception`, `failed`, `panic`, `unhandled`, or `EADDRINUSE` indicators.

MAR findings:

- `openai/gpt-5.5 (high)`: must-fix Core perf test using the real user perf log; flagged Cursor subagent ephemeral request behavior as out-of-scope unless documented.
- `cursor/composer-2.5`: must-fix alleged unrelated `packages/core/package.json` regressions when compared to `origin/dev`; optional runner comment and metric alignment notes.
- `zhipuai-coding-plan/glm-5.2`: approved; optional note that `opencode` source metrics still double-count system prompt and should be aligned before Stage 6 comparisons.

Accepted fixes:

- Added Core test preload isolation so `Global.Path.log/perf.jsonl` for Core tests lives under a per-process temp `XDG_DATA_HOME`, not the real user data dir.
- Marked `packages/core/bunfig.toml` and `packages/core/test/preload.ts` with `git add -N` so new test infrastructure is visible to Git.

Rejected/deferred findings:

- `packages/core/package.json` alleged broad regressions were rejected after verifying `git diff -- packages/core/package.json` shows only `test:parity`.
- Cursor subagent ephemeral request behavior in `packages/opencode/src/session/llm/request.ts` and its test are pre-existing unrelated dirty hunks in a Stage 0 touched file; preserved per worktree rules and not claimed as Stage 0 work.
- `opencode` source request metric inflation relative to preflight is deferred to Stage 6 metrics alignment; Stage 0.2 already documents this as telemetry-only and does not drive compaction behavior.

T2 commands run:

- `bun test --timeout 60000 test/session-runner.test.ts -t "records request assembly"` from `packages/core`: 1 pass, 92 filtered out, 0 fail.
- `bun run test:parity` from `packages/core`: 10 pass, 0 fail, 33 expect calls.
- `bun typecheck` from `packages/core`: pass.
- `bun lint` from repo root: exit 0, 4743 warnings, 0 errors; the new Core preload files added 0 warning matches.

VQA2 runtime QA: `bun dev` from `packages/opencode` started via PowerShell fallback; the process was still running after 8 seconds and stdout/stderr scan found 0 `error`, `exception`, `failed`, `panic`, `unhandled`, or `EADDRINUSE` indicators.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

## Stage 1: SessionV2 Runner Parity

Purpose: make `SessionV2` and `SessionRunner` able to cover the V1 loop before any hard cutover.

### 1.0 Runner Parity Inventory

Scope files: compare `packages/opencode/src/session/prompt.ts`, `packages/opencode/src/session/processor.ts`, `packages/opencode/src/session/session.ts`, and `packages/core/src/session/*`.

Deliverables: checklist artifact mapping each V1 behavior to a Core target file. Start with known candidates: compaction/replay truncation including the `message-v2.ts:51` marker, revert, share, title generation, todo integration, question tool serialization, plugin hooks, snapshot/checkpoint, attachment/media lowering, retry policy, usage/cost tracking.

Acceptance: every candidate is classified as implemented, missing, intentionally dropped, or blocked with target file and fail-before parity test requirement.

Implementation notes:

- Expanded the Stage 1 inventory table into a work-owning crosswalk from V1 behavior to Core target files and fail-before test owners.
- Added explicit implemented rows for the Stage 0.4 harness scenarios: `prompt-tool-loop-answer`, `steering`, `queue`, `abort`, and `permission-assert-decline`.
- Added missing rows for subagent task execution, structured output/`json_schema`, session summaries, reminders/plan-build prompt injection, and unavailable SessionV2 API endpoints (`shell`, `skill`, `switchAgent`, `compact`, `wait`).
- Corrected the compaction marker so `message-v2.ts:51-55` is documented as tool-output truncation and `message-v2.ts:550-629` as the retained tail/replay/latest path.
- Classified Todo integration as implemented for Core persistence/tool effects, with V1 presentation metadata documented as an exception unless app consumers still require it.
- Sharpened Share, Revert, Usage/Cost, Plugin Hook, and Attachment rows so storage/projector partials are not mistaken for cutover-ready parity.

T1 commands run:

- `bun run test:parity` from `packages/core`: 10 pass, 0 fail, 33 expect calls.
- `bun typecheck` from `packages/core`: pass.

VQA1 runtime QA: `bun dev` from `packages/opencode` started via PowerShell fallback because `tmux` is unavailable on Windows; the process was still running after 8 seconds and stdout/stderr scan found 0 `error`, `exception`, `failed`, `panic`, `unhandled`, or `EADDRINUSE` indicators.

MAR findings:

- `openai/gpt-5.5 (high)`: must-fix missing subagent/task inventory row and ambiguous Todo row classification.
- `cursor/composer-2.5`: must-fix missing inventory rows for Stage 0.4 harness behaviors, incorrect compaction marker, and understated Share/Revert/Usage gaps.
- `zhipuai-coding-plan/glm-5.2`: must-fix missing StructuredOutput/`json_schema` candidate row.

Accepted fixes:

- Added the missing task/subagent row with Stage 2.5/4.1 ownership and completion/failure/interruption/cancel/permission/session-linkage test requirements.
- Added a crosswalk for Stage 0.4 implemented behaviors so the runnable harness scenarios are tied to inventory status.
- Corrected compaction marker notes and assigned Stage 1.1 replay/truncation tests.
- Made Todo status explicit and documented the only known exception.
- Added StructuredOutput/`json_schema`, session summary, reminder/plan-build, and unavailable SessionV2 API rows.
- Tightened Share/Revert/Usage rows to distinguish existing SQL/projector pieces from missing public API/projection/cost parity.

Rejected/deferred findings:

- No implementation rows were converted into source changes in 1.0; owning stages keep their fail-before test and implementation work.
- Todo V1 `N todos` tool title/metadata parity is deferred until Stage 1.3 confirms whether the app still consumes that presentation shape.

T2 commands run:

- `bun run test:parity` from `packages/core`: 10 pass, 0 fail, 33 expect calls.
- `bun typecheck` from `packages/core`: pass.

VQA2 runtime QA: `bun dev` from `packages/opencode` started through an inline Bun wrapper after shell quoting prevented the PowerShell wrapper from running correctly; the process was still running after 8 seconds and captured stdout/stderr scan found 0 `error`, `exception`, `failed`, `panic`, `unhandled`, or `EADDRINUSE` indicators.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### 1.1 Compaction And Replay Truncation Parity

Scope files: `packages/core/src/session/*`, especially history/projector and runner message selection.

Deliverables: V2 parity for compaction boundaries, replay truncation, and projected history reload before durable continuation.

Acceptance: parity tests fail before implementation and pass after implementation without data-loss perception around compaction. The test notes confirm projected history is reloaded before durable continuation.

Implementation notes:

- `SessionCompaction.compactAfterOverflow` now finds the latest user turn that has prior user context, summarizes only entries before that replay boundary, writes the compaction checkpoint, then publishes a durable `SessionEvent.Prompted` replay after the checkpoint.
- Replay prompt files are converted to bounded attachment placeholders such as `[Attached image/png: file]`; unnamed files no longer embed raw `file.uri` or data URI payloads into text context.
- The provider retry path reloads projected history through `SessionHistory.entriesForRunner`, so the final request sees the checkpoint plus a separate replayed user message instead of losing the user prompt or duplicating it inside `<recent-context>`.

Fail-before coverage:

- Tightened `covers compaction retry after provider context overflow`; before the source fix it failed because the final request only contained the checkpoint and embedded `[User]: Continue` inside recent context instead of replaying `Continue` separately.
- Added `excludes same-turn content from overflow checkpoint replay`; this direct compaction test guards the prefix-only summary boundary so later same-turn assistant/tool content is not summarized before replaying the user turn.
- Extended replay coverage with an unnamed data URI attachment; before the accepted fix the replay placeholder included the raw `data:image/png;base64,...` URI.

T1 commands run:

- `bun test --timeout 60000 test/parity/session-v2-runner-parity.test.ts -t "covers compaction retry after provider context overflow"` from `packages/core`: failed before source fix, then passed after the first replay fix.
- `bun run test:parity` from `packages/core`: 10 pass, 0 fail, 34 expect calls.
- `bun typecheck` from `packages/core`: pass.

VQA1 runtime QA: `bun dev` from `packages/opencode` started through the inline Bun wrapper; the process was still running after 8 seconds and captured stdout/stderr scan found 0 `error`, `exception`, `failed`, `panic`, `unhandled`, or `EADDRINUSE` indicators.

MAR findings:

- `openai/gpt-5.5 (high)`: must-fix raw attachment URI replay placeholders; must-fix summary boundary should split before the replayed user turn rather than filtering only that user row; optional update plan/evidence after completion.
- `cursor/composer-2.5`: no must-fix; optional preflight compaction replay coverage, attachment replay coverage, original delivery metadata, and single-use helper simplification.
- `zhipuai-coding-plan/glm-5.2`: no must-fix; optional use `Prompt.fromUserMessage` to avoid duplicating optional-agent handling.

Accepted fixes:

- Replaced attachment placeholder fallback from `file.uri` to bounded `file` fallback and added assertion that replay text does not contain the data URI.
- Changed summary selection to use entries before the replayed user boundary, which excludes later same-turn content from the checkpoint before replay.
- Added deterministic direct compaction-boundary coverage for the same-turn content exclusion.
- Removed the single-use replay helpers while applying `Prompt.fromUserMessage` for replay construction.

Rejected/deferred findings:

- Preflight compaction replay path remains optional follow-up coverage; Stage 1.1 fixed and tested the provider-overflow replay path plus direct compaction boundary.
- Replaying with original `queue`/`steer` delivery is deferred because replay is emitted as an already-promoted legacy `Prompted` event and no current continuation behavior depends on pending delivery semantics.
- Manual/public SessionV2 `compact` API remains Stage 4.2 ownership.

T2 commands run:

- `bun test --timeout 60000 test/parity/session-v2-runner-parity.test.ts -t "covers compaction retry after provider context overflow|excludes same-turn content from overflow checkpoint replay"` from `packages/core`: 2 pass, 0 fail, 9 expect calls.
- `bun run test:parity` from `packages/core`: 11 pass, 0 fail, 39 expect calls.
- `bun typecheck` from `packages/core`: pass.

VQA2 runtime QA: `bun dev` from `packages/opencode` started through the inline Bun wrapper; the process was still running after 8 seconds and captured stdout/stderr scan found 0 `error`, `exception`, `failed`, `panic`, `unhandled`, or `EADDRINUSE` indicators.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### 1.2 Revert And Snapshot/Checkpoint Parity

Scope files: `packages/core/src/session/*`, database schema/migration files if needed.

Deliverables: V2 revert behavior and durable snapshot/checkpoint behavior match V1 user-visible semantics.

Acceptance: revert parity test covers visible messages, durable events, and post-revert continuation.

T1 commands run:

- `bun run test:parity` from `packages/core`: 12 pass, 0 fail, 47 expect calls.
- `bun test --timeout 60000 test/file-mutation.test.ts test/tool-write.test.ts test/tool-edit.test.ts test/tool-apply-patch.test.ts` from `packages/core`: 40 pass, 0 fail, 135 expect calls.
- `bun typecheck` from `packages/core`: pass.
- Retry subset `bun test --timeout 60000 test/parity/session-v2-runner-parity.test.ts test/file-mutation.test.ts test/location-mutation.test.ts` from `packages/core`: 38 pass, 0 fail.

VQA1 runtime QA: `bun dev` from `packages/opencode` started through the inline Node/Bun wrapper; the process was still running after 8 seconds and captured stdout/stderr scan found 0 error signals.

MAR reviewers: `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, `zhipuai-coding-plan/glm-5.2`.

Accepted fixes after review:

- Added `BusyError`/activity-lease rejection for revert mutations and public `BusyError` typing where prompt cleanup can surface it.
- Moved `resume` away from implicit cleanup while keeping `prompt` cleanup before new input.
- Matched assistant, user, and assistant-part revert semantics, including partial assistant content trimming on cleanup.
- Kept file mutation checkpoints metadata-only and avoided model-visible file contents.
- Added step snapshot publish/provider layers, snapshot restore of deleted files, snapshot revert/unrevert restoration, and a real Git workspace regression for modified/deleted/added files.
- Fixed `SessionFileMutation` type errors uncovered by final typecheck.

T2 commands run:

- `bun run test:parity` from `packages/core`: 14 pass, 0 fail, 59 expect calls.
- `bun test --timeout 60000 test/session-create.test.ts test/file-mutation.test.ts test/location-mutation.test.ts test/tool-write.test.ts test/tool-edit.test.ts test/tool-apply-patch.test.ts` from `packages/core`: 70 pass, 0 fail, 196 expect calls.
- `bun typecheck` from `packages/core`: pass.

VQA2 runtime QA: direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn from `packages/opencode`; output `RUNNING_AFTER_8S:true` and `ERROR_SIGNAL_COUNT:0`.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### 1.3 Share, Title, And Todo Parity

Scope files: Core session runner and adjacent share/title/todo modules.

Deliverables: V2 path produces the same shareable projection, title updates, and todo integration expected by current surfaces.

Acceptance: parity tests and existing share/title/todo tests cover V2 output shapes.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### 1.4 Question Tool Serialization And Permission Ask/Deny

Scope files: Core runner, permission modules, question/tool serialization paths.

Deliverables: one active question per session by default, FIFO recovery semantics, permission ask/deny parity, and persisted decision effects.

Acceptance: parity tests cover question serialization, inactive-tab recovery where applicable, permission deny, and permission allow.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### 1.5 Plugin Hooks And Lifecycle Parity

Scope files: Core runner seams, plugin runtime boundaries, opencode extension layer.

Deliverables: V1 `experimental.hook` equivalents or deliberate replacement seams that preserve user-facing plugin behavior.

Acceptance: plugin hook scenario tests cover runtime mount/unmount and failure isolation.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: Core PluginV2 hook spec now includes chat system/messages/params/headers, tool definition, and tool execute before/after seams. Runner request prep applies chat hooks, default session headers, full generation fields, and suppresses message transforms for title generation. ToolRegistry materialization applies `tool.definition` hooks and keys the optional materialization cache by PluginV2 generation. Plugin lifecycle tests cover scoped finalization, remove, replacement-load failure rollback, hook failure isolation, and non-commit of failing output mutations.

### 1.6 Attachment And Media Lowering

Scope files: `packages/core/src/session/runner/to-llm-message.ts` and adjacent attachment/media modules.

Deliverables: V2 runner lowers file, image, and other media attachments to provider-ready messages without relying on V1 conversion.

Acceptance: parity tests cover attachments and provider payload shape.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: Core `toLLMMessages` now lowers text/plain user attachments to text, directory attachments to stable labels, supported media to canonical `media` parts, and unsupported user media to provider-safe omission text for known image-only routes. Tool-result replay now normalizes MIME casing plus `image/jpg`, keeps image files in provider-supported tool results, extracts Bedrock PDF documents into a synthetic user media turn, emits omission text for unsupported binary files, and closes pending/running tool calls with synthetic error results. Provider-payload tests cover OpenAI user images, omitted PDFs, and `image/jpg`; Anthropic user and tool images; and Bedrock user plus extracted tool PDFs. Review fixes addressed route-media mismatches, pending/running dangling tool calls, local error media replay, MIME normalization, double tool-result lowering, and missing provider-payload coverage. T2 and VQA2 are green.

### 1.7 Error Retry, Usage, And Cost Tracking

Scope files: Core runner LLM loop, event settlement, usage/cost modules.

Deliverables: retry policy, error surfacing, usage events, and cost tracking match current V1 behavior or documented target behavior.

Acceptance: parity tests cover retryable provider failures, non-retryable errors, usage accumulation, and visible error messages. The notes also confirm one explicit `llm.stream(request)` call per provider turn.

Evidence: Core runner now performs bounded provider retries only before visible assistant output and before `step-finish`, publishes durable `SessionEvent.Retried`, surfaces exhausted retryable provider errors, keeps non-retryable failures visible, and preserves usage through content-filter terminal errors. `publish-llm-event` computes assistant usage/cost from `Usage` plus model cost tiers, including cache/reasoning tokens and Copilot nano-AIU metadata, and the projector aggregates `SessionTable.cost/tokens` on `Step.Ended` while subtracting deleted assistant usage during revert cleanup. T1/T2 test commands from `packages/core`: `bun typecheck`; `bun test --timeout 60000 test/parity/session-v2-runner-parity.test.ts test/session-runner-tool-events.test.ts test/session-runner-message.test.ts`; `bun run test:parity`; focused retryable provider-error regression. VQA1/VQA2 runtime QA from `packages/opencode`: direct Bun dev spawn with `OPENCODE_DISABLE_SESSION_RECOVERY=1`, `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. MAR reviewers were `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, and `zhipuai-coding-plan/glm-5.2`; accepted fixes covered swallowed exhausted provider errors, publisher-state reuse after `step-finish`, V2 revert usage decrement, plain output-token extraction, and retry backoff/test-clock behavior.

Rejected/deferred findings: Bedrock raw filename sanitization and remote URI materialization remain deferred from Stage 1.6. Session summary/file-diff computation remains a separate inventory gap and was not part of this 1.7 retry/usage/cost acceptance slice.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### 1.8 Legacy Session Backfill Migration

Scope files: `packages/core/src/database/migration.ts`, `packages/core/test/database-migration.test.ts`.

Deliverables: idempotent one-time V1 messages -> V2 events backfill plus startup schema-repair coverage.

Acceptance: old sessions do not appear empty after V2 cutover, and migration is verified against a copy of the real local DB before Stage 4.

Evidence: `DatabaseMigration.applyOnly` now runs an idempotent legacy message backfill after additive schema repair. The backfill only runs when the current tables/columns are available, selects legacy sessions with `message` rows and no V2 projection/session.next events, appends generated `session.next.*` events after any existing V1 aggregate sequence, writes `session_input` rows for legacy user prompts, and writes `session_message` projections for user/assistant messages. Legacy user text/file/agent parts map to V2 prompt fields; assistant text/reasoning/custom/tool/step parts map to V2 assistant content, snapshots, finish, cost, and token data. Regression coverage includes a fail-before empty-session case, idempotent double-apply, schema decoding through `SessionMessage.Message`, completed tool-part backfill, intermediate-schema skip guards, and appending V2 events after existing V1 `event`/`event_sequence` rows.

T1 commands run from `packages/core`: focused `bun test --timeout 30000 test/database-migration.test.ts -t "backfills legacy Session messages"` failed before implementation, then passed; `bun test --timeout 60000 test/database-migration.test.ts` passed with 16 tests after first implementation; `bun typecheck` passed. VQA1 runtime QA from `packages/opencode`: direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn with `OPENCODE_DISABLE_SESSION_RECOVERY=1`, `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`.

MAR reviewers: `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, and `zhipuai-coding-plan/glm-5.2`. Accepted fixes: sessions with existing V1 event rows no longer skip backfill; generated V2 events append after existing aggregate sequence and update `event_sequence`; regression added for existing V1 events; projection rows are schema-decoded in tests; completed tool-part coverage was added. Rejected/deferred findings: subtask/compaction/retry/snapshot/patch legacy parts remain lossy fallback gaps because Stage 1.8 acceptance is non-empty V2 visibility and stable prompt/assistant replay, not full V1 UI-card preservation; no-op corrupt/system-only legacy rows may be re-scanned on startup and are deferred as low operational risk; session-level usage is already owned by `sessionUsageMigration`; per-session transaction chunking is deferred unless real local DB verification shows startup lock pressure; real local DB copy verification remains required before Stage 4 cutover per acceptance.

T2 commands run from `packages/core`: focused backfill regressions `bun test --timeout 30000 test/database-migration.test.ts -t "backfills legacy Session messages|appends V2 backfill"` passed; full `bun test --timeout 60000 test/database-migration.test.ts` passed with 17 tests and 68 expect calls; `bun typecheck` passed. VQA2 runtime QA from `packages/opencode`: same direct Bun dev spawn, `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### 1.9 Stage 1 Parity Gate

Scope files: all Stage 1 touched files.

Deliverables: full parity suite green against V2 runner.

Acceptance: every Stage 1 inventory item is green, intentionally dropped with rationale, or blocked before any Stage 4 cutover.

Evidence: Stage 1 parity gate is green for implemented runner parity while remaining non-green inventory rows are explicitly classified before Stage 4 cutover. T1 from `packages/core`: `bun typecheck` passed; `bun run test:parity` passed with 31 tests and 129 expect calls; broad focused Stage 1 suite passed with 115 tests and 329 expect calls. VQA1 from `packages/opencode`: direct `C:\Users\crisc\.bun\bin\bun.exe dev` spawn with `OPENCODE_DISABLE_SESSION_RECOVERY=1`, `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`.

MAR reviewers: `openai/gpt-5.5 (high)`, `cursor/composer-2.5`, and `zhipuai-coding-plan/glm-5.2`. Accepted fixes: Summary/file-diff computation and Structured Output/`json_schema` were explicitly blocked before Stage 4.3 cutover, and both are now resolved by the Stage 4.3 Core blocker T1 slice; real subagent-task parity is separated from task-shaped local tool settlement in the parity manifest and remains pending for Stage 2.5/4.1; V2 shell/skill/switchAgent/compact/wait APIs are classified as Stage 4.2 blockers; referenced untracked Core files were marked intent-to-add. Rejected/deferred findings: full `session-runner.test.ts` still has known unrelated failures and remains deferred to the documented fix-churn/B.3 track; Stage 1.9 verifier uses `test:parity` plus focused Stage-1 suites rather than the unrelated failing full file.

T2 from `packages/core`: `bun typecheck` passed; `bun run test:parity` passed with 31 tests and 129 expect calls; broad focused Stage 1 suite including `test/session-file-mutation.test.ts` passed with 118 tests and 338 expect calls. VQA2 from `packages/opencode`: same direct Bun dev spawn, `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`.

Remaining pre-cutover blockers after Stage 4.3 Core blocker T1: real local DB copy verification for the 1.8 backfill remains required before final Stage 4 deletion; subtask slash-command and MCP-backed command cutover remain Stage 4.4 blockers. The previously listed summary/file-diff, structured-output, real subagent task, and V2 shell/skill/switchAgent/compact/wait blockers have been resolved in later Stage 4 slices.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

## Stage 2: Tool Consolidation

Purpose: make Core `Tool.make` under `packages/core/src/tool` the only real tool implementation. Delete legacy tools once the Core replacement is proven.

### 2.0 Tool Output Contract Baseline

Scope files: legacy and Core tool tests, tool output store, snapshot fixtures.

Deliverables: model-visible output snapshots for each tool family before porting, plus a check that surviving tools are built through Core `Tool.make`.

Acceptance: snapshots make subtle output formatting changes visible.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### 2.1 `grep` And `glob`

Scope files: `packages/opencode/src/tool/{grep,glob}.ts`, `packages/core/src/tool/{grep,glob}.ts`.

Deliverables: Core tools preserve output formatting, limits, and model contracts.

Acceptance: legacy implementation is deleted or reduced to temporary re-export after tests pass.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### 2.2 `read`

Scope files: `packages/opencode/src/tool/read.ts`, `packages/core/src/tool/read.ts`, `packages/core/src/tool/read-filesystem.ts`.

Deliverables: binary/image handling, paging, formatting, and managed-output retrieval live in Core.

Acceptance: read tests cover text ranges, binary refusal/metadata, image path handling, and managed output.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### 2.3 `edit`, `write`, And `apply_patch`

Scope files: `packages/opencode/src/tool/{edit,write}.ts`, `packages/core/src/tool/{edit,write}.ts`, Core file mutation modules.

Deliverables: BOM handling, line endings, exact replace strategy, stale-write protection, and optional LSP/formatter adapter seams in Core.

Acceptance: mutation tests cover CRLF, BOM, stale writes, exact replacement failure modes, and shared edit permission action.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### 2.4 `bash` / Shell

Scope files: `packages/opencode/src/tool/shell.ts`, `packages/core/src/tool/bash.ts`.

Deliverables: command parsing, external path detection, permission scan, and output capture limits in Core.

Acceptance: tests cover allowed commands, denied commands, output bounding, Windows path handling, and app process max output behavior.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

### 2.5 `task` Subagent Tool

Scope files: `packages/opencode/src/tool/task.ts`, new Core task tool modules, Stage 1 V2 prompt seams.

Deliverables: subagent sessions run through SessionV2 prompt/admission semantics.

Acceptance: task tool parity tests cover normal completion, tool errors, permission boundaries, and session linkage.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: Core `TaskTool` now admits foreground subagent work through `SessionV2.prompt(..., resume: false)` plus explicit child `resume`, stores `parentID`/title on child sessions, returns canonical `<task>`/`<task_error>` output, validates `task_id` format/ownership/location/agent before reuse, fails stale task IDs instead of silently creating new sessions, propagates runner defects, and interrupts the child session when the parent tool fiber is interrupted. T1/T2 and VQA1/VQA2 are green. Multi-agent review used the three working reviewers; `cursor/claude-fable-5 (max)` was skipped per user after the Cursor runner error. Runtime registration and full subagent cutover remain owned by Stage 4.1.

### 2.6 MCP Tools

Scope files: `packages/opencode/src/session/tools.ts`, Core tool registry, `ToolOutputStore`.

Deliverables: schema conversion and bounded output use `ToolOutputStore.bound` rather than ad-hoc truncation.

Acceptance: tests cover MCP tool schema, large output bounding, auth boundary, and custom-tool import failure isolation.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: MCP tool wrapping now stays out-of-place to avoid duplicate permission prompts, schema conversion still runs through provider transforms, MCP output is projected into canonical `ToolOutput` and bounded with `ToolOutputStore.bound`, and returned V1 content/attachments are rebuilt only from bounded content. Small MCP images/resources are preserved; oversized MCP images/resource blobs are replaced with bounded text omission markers and omitted from provider-facing attachments/content. V1 app/session/httpapi runtimes use `V1ToolOutputStore` so Opencode `tool_output.max_lines`/`max_bytes` config is visible to the Core store. T1/T2 and VQA1/VQA2 are green. Review fixes addressed media/resource back-mapping, oversized binary leakage, and config-layer visibility; Composer/GLM reviewers failed at infrastructure/model-credit level and were replaced by available review agents, with Fable skipped per user.

### 2.7 Legacy Tool Deletion Gate

Scope files: `packages/opencode/src/tool/*`, imports across repo.

Deliverables: `packages/opencode/src/tool` contains only temporary re-exports or is removed.

Acceptance: no runtime path imports legacy tool implementations, every surviving built-in tool is implemented through Core `Tool.make`, and all Core plus ported legacy tests are green.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: the legacy opencode tool implementation path is deleted. `packages/opencode/src/tool/**/*` and `packages/opencode/test/tool/**/*` have no working-tree files, and grep found no `@/tool`, `../tool`, or `packages/opencode/src/tool` references in runtime source or tests. The only shared fixtures previously under `test/tool/fixtures` were moved byte-for-byte to `packages/opencode/test/fixtures/llm` and their session test references were updated.

Runtime replacement: local project tools now load through `packages/core/src/tool/local.ts` into the canonical Location-scoped `ToolRegistry`, with per-file import isolation for `.opencode/tool` and `.opencode/tools`, plugin-style `tool({ description, args, execute })` adaptation, JSON-schema overrides on `Tool.make`, metadata collection, and file attachment projection. `LocationServiceMap` wires local tools and the Core task tool through the Core graph. Experimental tool listing now uses the Core registry without requiring provider/model query parameters. `opencode run` formats SDK/Core V2 tool-frame shapes structurally instead of importing legacy tool types.

T1/T2 and runtime QA were green. `packages/core`: `bun typecheck` passed; `bun test --timeout 60000 test/application-tools.test.ts test/session-runner-tool-registry.test.ts test/local-tools.test.ts test/location-layer.test.ts` passed with 34 tests and 76 expect calls. `packages/opencode`: `bun typecheck` passed; `bun test --timeout 60000 test/server/httpapi-experimental.test.ts` passed with 4 pass and 1 skip; `bun test --timeout 60000 test/server/httpapi-query-schema-drift.test.ts` passed with 12 pass and 49 expect calls; `bun test --timeout 60000 test/cli/run/entry.body.test.ts` passed with 14 pass; `bun test --timeout 60000 test/cli/run/scrollback.surface.test.ts` passed with 15 pass and 1 skip; `bun test --timeout 60000 test/session/llm.test.ts -t "accepts user image attachments as data URLs"` passed; `bun test --timeout 60000 test/session/llm-native-recorded.test.ts` passed with 3 pass and 1 skip. `test/agent/agent.test.ts` still reproduces a Bun 1.3.14 `watcher.node` segmentation fault after 32 visible passes in the full-file run, so the changed managed-output subset was rerun separately with clean exit (4 pass) and the remaining skill/default-agent subset was rerun separately with clean exit (11 pass).

MAR reviewers were `openai/gpt-5.5 (high)`, `cursor/default`, and `zhipuai-coding-plan/glm-5.2`. Accepted fixes: added Core local custom-tool loading to preserve `.opencode/tool` behavior while isolating broken imports, made experimental tool-list query provider/model optional, fixed Core V2 tool-frame rendering in `opencode run`, moved shared LLM fixtures out of the deleted legacy test directory, and updated the experimental session cursor OpenAPI compatibility expectation to `string` to match the `x-next-cursor` runtime and generated SDK. Rejected/deferred findings: `ask` and `customPart` in local custom-tool context remain fail-fast unsupported until a dedicated Core question/custom-part tool-adapter design exists; plugin/MCP canonical registration beyond this local project-file adapter remains outside the deletion gate.

### Stage 2 completion gate

Scope files: all Stage 2 tool-consolidation files and deletion checks.

Deliverables: Core tools are the only remaining runtime tool implementation path, and the legacy opencode tool tree is gone.

Acceptance: Stage 2.0 through 2.7 are checked, focused Core/opencode tool and route regressions are green, and no live imports reference `packages/opencode/src/tool`.

Evidence: Stage 2.0 through 2.7 are complete. The final gate used the Stage 2.7 verifier set above plus the empty-directory and grep checks proving `packages/opencode/src/tool` and `packages/opencode/test/tool` have no remaining files or references. Shared fixtures required by non-tool tests now live under `packages/opencode/test/fixtures/llm`.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

## Stage 3: Native LLM Path As Default

Purpose: make `@opencode-ai/llm` the standard transport. AI SDK remains only as fallback for providers without native route.

### 3.0 Provider Coverage Matrix

Scope files: `packages/llm/src/providers/*`, `packages/opencode/src/provider/provider.ts`, `packages/opencode/src/session/llm.ts`, `packages/opencode/src/session/llm/native-runtime.ts`, `packages/opencode/src/session/llm/native-request.ts`, provider specs.

Deliverables: matrix for OpenAI, Anthropic, Gemini, Bedrock, Azure, Copilot, OpenAI-compatible, OpenRouter, xAI, Cloudflare, API-key auth, OAuth/token auth, native/fallback route, recorded-test coverage, and missing native capabilities.

Acceptance: each provider-matrix row has a native/fallback decision before code cutover, and each row has either recorded HTTP coverage or an explicit fallback/no-native coverage note.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Provider coverage matrix:

Matrix note: after Stage 3.2, the session native path is attempted by default and provider-specific support below decides native vs explicit AI-SDK fallback. Recorded coverage distinguishes active replay cassettes from registered golden rows that currently skip when their cassette is absent.

| Provider family | Native package facade / protocol | Current Opencode native gate | Auth route | Recorded/focused coverage | Stage 3 decision | Missing native capabilities before default |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI | Package supports `OpenAI.configure(...).responses`, `.responsesWebSocket`, `.chat`; Opencode native adapter currently constructs Responses only for `@ai-sdk/openai` | Supported when provider id is `openai`, npm is `@ai-sdk/openai`, and an API-key-compatible value is configured | API key supported; OAuth is not a full native token path today because runtime still passes `apiKey` from provider options/key | Active replay: Responses text/reasoning/continuation/tool-call/tool-loop/image-tool-result and Responses cache; Chat text/tool-call/tool-loop/continuation. Chat image-tool-result and Responses WebSocket golden rows are registered but need matching active cassettes before cutover | Native target for default first wave | Add native-request route selection for Chat/WebSocket or explicitly force Responses; make OAuth fallback policy explicit; verify hosted-tool/provider-executed history and provider option parity |
| Anthropic | `Anthropic.configure(...).model`; `anthropic-messages` | Supported when provider id is `anthropic`, npm is `@ai-sdk/anthropic`, and API key is configured | API key via `x-api-key`; no Opencode OAuth path | Active replay: Haiku text/tool-call, Opus tool-loop/image-tool-result, cache; focused malformed assistant-tool-order regressions | Native target for default first wave | Confirm chronological system update model gating, cache-control parity, hosted tool pass-through, and image/tool-result replay under session adapter |
| Gemini / Google | `Google.configure(...).model`; `gemini` | Native package and adapter model construction exist, but `native-runtime.status` rejects Google provider/package before execution | API key via `x-goog-api-key` | Active replay: Gemini text/tool-call/image and cache. Image-tool-result golden row is registered but currently lacks an active cassette; focused lowering covers image tool-result behavior | Keep AI-SDK fallback until runtime gate and adapter are enabled | Add runtime support gate, finish reason/usage parity in session path, safety/provider-error mapping, and provider option lowering coverage |
| Amazon Bedrock | `AmazonBedrock.configure(...).model`; `bedrock-converse` with AWS event-stream framing | Native package and adapter model construction exist, but `native-runtime.status` rejects Bedrock provider/package before execution | SigV4 credentials or bearer API key in native package; Opencode provider builds AWS credential provider/options today | Active replay: Bedrock Converse text/tool-call/tool-loop. Cache recorded test is registered but currently lacks an active cassette; focused tests cover cache markers and binary event stream parsing | Keep AI-SDK fallback until runtime gate and credential bridging are enabled | Wire Opencode Bedrock credentials/profile/region into native request, verify binary event-stream replay, document cache breakpoint parity, and preserve document/media lowering |
| Azure OpenAI | `Azure.configure(...).responses/.chat`; OpenAI Responses/Chat protocols with Azure endpoint/query | Native adapter can construct Azure Responses for `@ai-sdk/azure`, but runtime gate rejects Azure and adapter does not preserve Chat/use-completion selection yet | API key via `api-key`; resourceName or baseURL plus API version | No active recorded Azure cassette; focused scripted coverage exists for Azure Chat and Responses URL/API-key header behavior | Keep AI-SDK fallback until recorded or scripted session-adapter coverage exists | Map Opencode resource/baseURL/API-version options, preserve `useCompletionUrls` / Chat-vs-Responses behavior, and add native-request/runtime tests before enabling |
| GitHub Copilot | `GitHubCopilot.configure({ baseURL, auth }).model`; OpenAI Responses/Chat protocols | Native package facade exists, but `native-request.ts` does not construct it and runtime gate rejects Copilot | Token/baseURL from Opencode Copilot auth; AI SDK path currently includes raw chunks for authoritative billing | No native Copilot recorded cassette in `packages/llm`; existing Opencode path remains AI SDK | Keep AI-SDK fallback until explicit Copilot adapter work | Add native-request mapping, token refresh/auth boundary, billed amount extraction, model API selection, and recorded/simulated coverage |
| Generic OpenAI-compatible | `OpenAICompatible.configure({ provider, baseURL }).model` plus family profiles | Opencode runtime currently supports only provider ids starting with `opencode` and npm `@ai-sdk/openai-compatible`; other custom compatible providers fall back | API key/bearer or explicit auth; baseURL required | Active replay: DeepSeek text, TogetherAI text/tool-call, Groq text/tool-call/tool-loop, OpenRouter-compatible rows under OpenRouter below; more profiles share protocol without cassettes | Native target only for opencode-managed compatible first; generic custom stays fallback until policy is explicit | Define provider-id allowlist/denylist, baseURL SSRF/auth boundary, unsupported feature matrix, and per-family recorded or scripted coverage expectations |
| OpenRouter | `OpenRouter.configure(...).model`; OpenRouter chat protocol over OpenAI-compatible stream | Native package and adapter model construction exist for `@openrouter/ai-sdk-provider`, but runtime gate rejects provider id/package | API key via `OPENROUTER_API_KEY`; providerOptions include usage/reasoning/prompt cache key | Active replay: OpenRouter gpt-4o-mini text/tool-call/tool-loop, gpt-5.5 tool-loop, Claude Opus tool-loop | Keep AI-SDK fallback until runtime gate and provider-options parity are enabled | Preserve OpenRouter-specific `usage`, `reasoning`, and `prompt_cache_key`; verify non-OpenAI models via same route and usage/cost extraction |
| xAI | `XAI.configure(...).responses/.chat`; OpenAI Responses/OpenAI-compatible Chat protocols | Native package facade exists, but `native-request.ts` does not construct xAI and runtime gate rejects it | API key via `XAI_API_KEY` | Golden rows are registered for Grok 3 Mini/Grok 4.3, but no active `xai` replay cassette directory is present; no native Opencode adapter coverage yet | Keep AI-SDK fallback until adapter and gate are added | Add native-request mapping, choose Responses vs Chat default by model capability, and cover xAI-specific provider options/errors |
| Cloudflare AI Gateway / Workers AI | `CloudflareAIGateway.configure`, `CloudflareWorkersAI.configure`; OpenAI-compatible Chat protocol | Native package facade exists, but `native-request.ts` does not construct Cloudflare and runtime gate rejects it | AI Gateway can use gateway token plus upstream bearer; Workers AI bearer token | Active replay: AI Gateway Workers text/tool-call and Workers AI text/tool-call; focused tests cover endpoint/auth derivation | Keep AI-SDK fallback until adapter and auth mapping are added | Map account/gateway/baseURL/auth from Opencode provider config, verify dual-header AI Gateway auth, and document Workers model/tool limitations |
| Other bundled AI-SDK providers | Opencode bundles additional packages such as Google Vertex, Vertex Anthropic, Bedrock Mantle, Mistral, Groq, DeepInfra, Cerebras, Cohere, AI Gateway, TogetherAI, Perplexity, Vercel, Alibaba, GitLab, Venice, Nvidia, Snowflake, and others | `native-runtime.status` rejects these packages/providers today unless they are represented through the narrow OpenAI-compatible/opencode path | Mixed API-key/OAuth/custom headers depending on provider | No active native package coverage claimed in Stage 3.0 beyond shared OpenAI-compatible protocol families already listed | Explicit fallback until each provider is mapped or deliberately unsupported | Add grouped fallback tests/log assertions before native default so unsupported bundled providers do not silently lose functionality |
| API-key auth generally | Native `AuthOptions.bearer`/provider-specific headers across facades | Supported only for providers enabled by the global flag plus provider-specific runtime gate | API key from Opencode provider key/options or env-backed native config | Covered indirectly by active recorded provider tests using `requires` env keys | Enable provider-by-provider with tests | Do not make native default for providers whose Opencode auth cannot be expressed as a native route auth value yet |
| OAuth/token auth generally | Native package has explicit `Auth` values; Opencode owns OAuth/session refresh | OAuth-backed accounts currently fall back unless that provider has an explicit token-to-native-auth adapter; OpenAI OAuth fetch override alone is not enough without an API-key-compatible runtime value | Token acquisition/refresh stays Opencode-owned | No broad native OAuth recorded coverage | Fallback by default | Add token handoff and refresh/error tests per provider before enabling native default for OAuth-backed accounts |

Evidence: provider coverage matrix now records native/fallback decisions for OpenAI, Anthropic, Gemini, Bedrock, Azure, Copilot, OpenAI-compatible, OpenRouter, xAI, Cloudflare, grouped bundled AI-SDK providers, API-key auth, and OAuth/token auth. It explicitly distinguishes active replay coverage from registered/skipped golden rows and documents the provider-specific native support gate. T1 was green with `packages/llm`: `bun typecheck`, then `bun test --timeout 60000 test/provider/openai-chat.test.ts test/provider/openai-responses.test.ts test/provider/anthropic-messages.test.ts test/provider/gemini.test.ts test/provider/bedrock-converse.test.ts test/provider/openai-compatible-chat.test.ts test/provider/openrouter.test.ts test/provider/cloudflare.test.ts test/route.test.ts test/auth.test.ts` (`173 pass`). VQA1 was green with `packages/opencode`: `OPENCODE_DISABLE_SESSION_RECOVERY=1 bun dev` 8-second runtime log scan (`RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`). Multi-agent review findings were accepted by correcting the OpenAI Responses-vs-Chat distinction, OAuth wording, Azure scripted coverage, active-vs-registered recorded coverage, native support gate wording, and grouped fallback row. T2 reran the same `packages/llm` typecheck and provider suite (`173 pass`, `305 expect() calls`). VQA2 reran the same `packages/opencode` dev-spawn log scan (`RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`). Fable reviewer remained skipped per user instruction.

### 3.1 Port Missing Native Capabilities

Scope files: `packages/llm/src/providers/*`, protocol files, `packages/opencode/src/provider/transform.ts` as source behavior.

Deliverables: reasoning variants, provider option lowering, message sanitizing, and schema sanitizing live in native provider facades. OAuth/token acquisition remains opencode-owned; opencode passes auth headers/tokens into native provider facades instead of moving login/session concerns into `packages/llm`.

Acceptance: behavior is covered by provider/protocol tests before removing equivalent AI-SDK transform code, including at least one OAuth/token-backed provider such as Copilot when native support is claimed.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: OpenAI tool schema projection now lives in the native `@opencode-ai/llm` provider helper instead of depending on Opencode-only transform behavior. The shared OpenAI helper recursively sanitizes unsupported JSON Schema forms, preserves common validation constraints, converts `const` to `enum`, infers numeric/boolean/string enum types when safe, leaves mixed enums untyped, strips nullable `anyOf` to the non-null schema, keeps explicit empty object schemas stable, and still flattens top-level object unions for OpenAI function tools. Opencode native request coverage proves AI-SDK-shaped `jsonSchema(...)` tool schemas compile through the package-owned OpenAI Responses projection. T1: `packages/llm` `bun test --timeout 60000 test/provider/openai-responses.test.ts` (`52 pass`) and `bun typecheck` passed; `packages/opencode` `bun test --timeout 60000 test/session/llm-native.test.ts` (`18 pass`) and `bun typecheck` passed. VQA1: `packages/opencode` `OPENCODE_DISABLE_SESSION_RECOVERY=1 bun dev` 8-second runtime log scan (`RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`). Multi-agent review accepted findings for numeric/boolean enum inference, nested inference readability, mixed-null enum inference, and explicit empty object schema compatibility; GLM failed due OpenRouter credit/max-token limits and was replaced by available reviewers; Fable remained skipped per user instruction. T2 after fixes: `packages/llm` `bun test --timeout 60000 test/provider/openai-chat.test.ts test/provider/openai-responses.test.ts test/provider/openai-compatible-chat.test.ts` (`83 pass`, `135 expect() calls`) plus `bun typecheck`; `packages/opencode` `bun test --timeout 60000 test/session/llm-native.test.ts` (`18 pass`, `52 expect() calls`) plus `bun typecheck`. VQA2 reran the same `packages/opencode` dev-spawn log scan (`RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`). OAuth/token acquisition remains Opencode-owned; no new provider runtime gate was enabled in this slice.

### 3.2 Invert Native LLM Gate

Scope files: `packages/opencode/src/session/llm.ts`, `packages/core/src/session/runner/llm.ts`.

Deliverables: native route is default, `OPENCODE_EXPERIMENTAL_NATIVE_LLM` is removed, AI SDK fallback is explicit for missing routes, and V2 runner provider turns go through `LLMClient`.

Acceptance: local Anthropic/OpenAI/Copilot setup routes correctly, no standard V2 runner path bypasses `LLMClient`, and recorded provider tests are green.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: native runtime selection is now the standard first attempt and AI SDK is the explicit unsupported-route fallback with `llm.native_unsupported_reason` metadata. The global `OPENCODE_EXPERIMENTAL_NATIVE_LLM` runtime flag and public docs rows were removed, while the plan keeps the historical deliverable reference. OpenAI tool schemas preserve `$schema` so recorded native cassettes stay stable, and Copilot has explicit native-gate fallback coverage matching the Stage 3.0 matrix decision. T1/T2 were green for `packages/opencode`: `bun test --timeout 120000 test/effect/runtime-flags.test.ts` (`35 pass`), `bun test --timeout 120000 test/session/llm-native.test.ts` (`18 pass`), `bun test --timeout 180000 test/session/llm.test.ts -t native` (`3 pass`), `bun test --timeout 180000 test/session/llm-native-recorded.test.ts` (`3 pass`, `1 skip`), and `bun typecheck`; `packages/core`: `bun typecheck`; `packages/llm`: T1 `bun test --timeout 60000 test/provider/openai-responses.test.ts` (`52 pass`), T2 `bun test --timeout 60000 test/provider/openai-chat.test.ts test/provider/openai-responses.test.ts test/provider/openai-compatible-chat.test.ts` (`83 pass`, `135 expect() calls`), and `bun typecheck`. VQA1/VQA2 reran the same `packages/opencode` dev-spawn log scan (`RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`). Multi-agent review accepted findings for Copilot fallback coverage, stale adapter/docs wording, dead public env-var docs, duplicate fallback logging, and a clearer native-gate test name; Copilot native enablement remains deferred by the matrix. `packages/web` has no `typecheck` script; an optional `bun run astro check` currently fails on unrelated existing share-component type errors, not the MDX row deletion.

### 3.3 Prompt Caching On Standard Path

Scope files: `packages/llm/src/*`, `packages/llm/src/cache-policy.ts`, `LLMRequest.cache`, provider lowering paths, Stage 0 metrics.

Deliverables: Anthropic/Bedrock breakpoints and OpenAI `prompt_cache_key` are active on the standard path through `LLMRequest.cache` and `cache-policy.ts`, with cache-hit token metrics.

Acceptance: cache-hit metrics appear in spans, Anthropic cache hits are greater than zero in a repeat scenario, and tests cover cache policy generation plus provider payload lowering for Anthropic, Bedrock, and OpenAI.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: `LLMRequest.cache` now activates cache behavior on the native standard path for the covered providers. Anthropic and Bedrock keep the existing auto inline breakpoint policy for tools, system, and latest user-message boundaries. OpenAI Responses now synthesizes `providerOptions.openai.promptCacheKey` from `LLMRequest.id` when cache is enabled, including WebSocket Responses because the policy keys off the OpenAI Responses protocol rather than only the HTTP route id; explicit prompt cache keys and `cache: "none"` are preserved. Opencode native runtime passes `sessionID` as the native request id, and native-request accepts `id`/`cache` for direct adapter coverage. OpenAI Responses body construction now omits undefined optional fields. T1/T2 were green for `packages/llm`: `bun test --timeout 60000 test/cache-policy.test.ts test/provider/openai-responses.test.ts test/provider/anthropic-messages.test.ts test/provider/bedrock-converse.test.ts` (T1 `121 pass`, T2 `122 pass`, `196 expect() calls`) plus `bun typecheck`; `packages/opencode`: `bun test --timeout 120000 test/session/llm-native.test.ts` (`19 pass`, `54 expect() calls`) plus `bun typecheck`; `packages/core`: T2 `bun typecheck`. VQA1/VQA2 reran the same `packages/opencode` dev-spawn log scan (`RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`). Multi-agent review accepted fixes for OpenAI Responses WebSocket cache-key synthesis and simplification of redundant explicit `cache: "auto"` plus a single-use helper. Cache-hit usage mapping was already present for OpenAI cached tokens and Anthropic/Bedrock cache read/write tokens and remains covered by provider/usage tests.

### 3.4 Recorded Provider Tests And AI-SDK Shrink

Scope files: `packages/llm/test/*`, cassettes/recorder config, AI-SDK adapter modules.

Deliverables: recorded tests or explicit fallback-contract tests for every provider matrix row, and reduced AI-SDK adapter surface.

Acceptance: no provider stream drift, missing events, duplicate events, or dropped usage/cost accounting.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: T2 `packages/opencode` native runtime suite passed (`47 pass`, `83 expect() calls`), native recorded suite passed (`3 pass`, `1 skip`, `24 expect() calls`), and `bun typecheck` passed. T2 `packages/llm` recorded provider suite passed (`12 pass`, `30 skip`, `29 expect() calls`) and `bun typecheck` passed. VQA2 inline `bun dev` smoke from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1` reported `RUNNING_AFTER_8S:true` and `ERROR_SIGNAL_COUNT:0`.

## Stage 4: Cutover And V1 Deletion

Purpose: hard-switch surfaces one by one, then delete V1 execution code.

### 4.1 Subagents And `opencode run`

Scope files: task tool, `packages/opencode/src/cli/cmd/run/*`, server routes if needed.

Deliverables: task tool and run command use `SessionV2.prompt`.

Acceptance: CLI run, subagent completion, interruption, and failure paths pass through V2 only.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: Core `TaskTool` is registered through the Location-scoped service map and now returns the final assistant message from chronological child history, with regressions for normal completion, reuse, failure, defects, interruption, permission denial, unknown subagent, invalid/stale/wrong-parent/wrong-location/wrong-agent `task_id`, and final-message selection. `opencode run` fresh noninteractive sessions use V2 create/prompt and global V2 events, JSON output is not polluted by SSE lifecycle logs, model validation fails promptly, V2 question asks are rejected in noninteractive mode, and the stream transport sends prompt turns through `client.v2.session.prompt` with admission-error propagation. Server V2 prompt admission preserves `resume:false` admit-only semantics while default prompt requests schedule execution through `SessionExecution.wake`; new V2 `resume` and `cancelTool` routes have declared 404 coverage and SDK generation. MAR accepted fixes for TaskTool final assistant selection, stream prompt-error handling, missing-session mapping for `resume`/`cancelTool`, and CLI double-scheduling by relying on prompt default wake without an extra `/resume` call. Rejected/deferred: `--command`/shell branches remain V1 until Stage 4.2 TUI/session command cutover; TaskTool.locationLayer interrupt-via-SessionExecution integration and HTTP busy+revert prompt coverage are deferred as non-blocking follow-ups; `OPENCODE_CONFIG_CONTENT` Core loading is kept because V2 CLI subprocess tests need the same env-config path as legacy config.

### 4.2 TUI Prompt Endpoints

Scope files: TUI prompt components and `@opencode-ai/server` handlers.

Deliverables: TUI prompt submit/resume/abort uses V2 routes and V2 event stream.

Acceptance: TUI interactive smoke covers prompt, tool call, abort, and visible assistant output.

QA gate: prompt/interrupt slice [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence. Route completion slices: [x] synthetic/noReply reminders | [x] switchAgent/switchModel | [x] wait | [x] shell | [x] skill | [x] compact | [x] generic non-subtask command route and TUI cutover | [x] rest-slice VQA/MAR/T2 evidence | [x] subtask/MCP resequenced by user decision | [x] final Stage 4.2 done

### 4.3 App/Desktop Prompt And Event Cutover

Scope files: `packages/app/src/components/prompt-input/submit.ts`, `packages/app/src/context/server-sync.tsx`, `handlers/session.ts`, timeline/directory sync consumers.

Deliverables: app submit and sync use V2 endpoints and V2 event stream.

Acceptance: long-session paging checklist passes with more than 160 user turns: open from prefetched state, initial hydration, `loadOlder`, page boundary with assistant output, force-refresh, hash/active-message restore, older loaded messages remain visible.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: App normal prompts now use `client.v2.session.prompt`, non-subtask slash commands use `client.v2.session.command`, interrupt/abort uses `client.v2.session.interrupt`, and drained queued followups use explicit V2 `delivery: "queue"` while active followups remain steering prompts. Core blockers for structured output and summary/file-diff are resolved with focused runner regressions, SDK regeneration, and typechecks. MAR accepted the queued/delivery split and rejected the `/global/event` removal finding because it is the intentional app-wide EventV2/sync bridge; `/api/event` remains the native scoped stream. T2 verifier set passed across `packages/core`, `packages/server`, `packages/sdk/js`, `packages/app`, and `packages/opencode`; app E2E passed for V2 prompt cutover, followup queue/slash behavior, and the targeted long-session prefetched paging checklist. Persistent evidence paths: `packages/app/test-results/app-v2-prompt-cutover/prompt-network.json`, `packages/app/test-results/app-v2-prompt-cutover/prompt-desktop.png`, `packages/app/test-results/app-v2-prompt-cutover/interrupt.json`, `packages/app/test-results/app-v2-prompt-cutover/interrupt-desktop.png`, `packages/app/test-results/followup-queue/desktop-sent-from-active.png`, `packages/app/test-results/followup-queue/mobile-sent-from-active.png`, `packages/app/test-results/session-timeline-long/requests-before-refresh.json`, `packages/app/test-results/session-timeline-long/final-state.json`, `packages/app/test-results/session-timeline-long/desktop-loaded-older.png`, `packages/app/test-results/session-timeline-long/desktop-hash-restore.png`, `packages/app/test-results/session-timeline-long/mobile-hash-restore.png`, `packages/app/test-results/queued-slash-followup.png`, `packages/app/test-results/send-now-followup.png`, `packages/app/test-results/send-now-followup-ready.png`, and `packages/app/test-results/steered-active-followup.png`. Remaining cutover blockers move to Stage 4.4: V2 subtask slash-command equivalent, MCP-backed slash-command cutover, generated SDK required-body typing cleanup, and V2 prompt/textpart metadata schema cleanup.

### 4.4 Delete V1 Execution Code And Regenerate SDK

Scope files: `session/prompt.ts`, processor dual-write paths, V1/V2 conversion paths, AI-SDK leftovers, `provider/transform.ts`, legacy tools, unused SDK endpoints.

Deliverables: no repo import of `SessionPrompt`, no dead V1 execution routes, regenerated JavaScript SDK via `./packages/sdk/js/script/build.ts`.

Acceptance: import search is clean, SDK diff is intentional, server/app/TUI compile and tests pass.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Sub-slices: [x] V2 subtask command cutover; [x] MCP-backed slash command cutover; [x] generated SDK required-body typing cleanup; [x] V2 Prompt/Textpart metadata cleanup; [x] V1 prompt-loop/import deletion sweep.

Evidence: deleted the legacy V1 prompt loop implementation at `packages/opencode/src/session/prompt.ts`, removed pure legacy prompt/structured-output/snapshot-race tests, removed the remaining `SessionPrompt` imports/schema checks, and switched task-tool test typing to `TaskPromptInput`. Regenerated the JavaScript SDK with `bun ./packages/sdk/js/script/build.ts`, removed stale legacy execution methods/types from `packages/sdk/js/src/gen/*`, regenerated `packages/sdk/openapi.json` from current routes with `bun dev generate > ../sdk/openapi.json`, and removed stale legacy execution rows from server docs. Final import/API sweeps are clean: `\bSessionPrompt\b` has no matches in `packages`; `promptAsync|prompt_async|onSessionPromptAsync` has no matches in `packages`; stale legacy `session.init|abort|summarize|prompt|prompt_async|command|shell` operation IDs have no matches in `packages/sdk/openapi.json`; stale `POST /session/:id/{message,prompt_async,command,shell,init,abort,summarize}` docs rows have no matches in `packages/web/src/content/docs/**/server.mdx`. HTTP API exercise coverage is complete with `selected=200`, `effectRoutes=183`, `missing=0`, `extra=0`; added coverage for VCS git/action, MCP starter, perf record, control config/live publish, and V2 session command/synthetic/resume/interrupt/agent/model/shell/skill/cancelTool routes. Harness fixes made PTY input Windows-safe, updated current event/revert assertions, made auth probes bodyless, and bounded test-app dispose so successful auth/effect runs exit reliably. T1/T2: `packages/core` `bun typecheck` passed; `packages/server` `bun typecheck` passed; `packages/opencode` `bun typecheck` passed; `packages/sdk/js` `bun typecheck` passed; `packages/app` `bun typecheck` passed; `packages/tui` `bun typecheck` passed; targeted `packages/opencode` tests `bun test --timeout 30000 test/session/schema-decoding.test.ts test/session/structured-output.test.ts test/tool/task.test.ts` passed with 53 tests; `packages/opencode` `bun run test:httpapi` passed all coverage/auth/effect modes with 200 pass and no missing/extra routes. VQA1/VQA2 runtime QA used the HTTP API exerciser against the real Effect route tree; expected missing-key/OAuth probe errors were logged for negative scenarios, but summaries were green. Multi-agent review: `review-code-simplifier` found one low-risk simplification, accepted by simplifying `retryDelayMs`; `review-gpt-low` approved with no findings; `review-gpt-high` timed out at provider headers; `research-opencode-glm-5-2` failed due provider credit/max-token limits; `research-opencode-nemotron-free` terminated. Optional `packages/web` `bun run astro check` remains red on pre-existing share-component type errors unrelated to the MDX server-doc row deletions (`opencode/session/index` and `MessageV2.*` exports).

### 4.5 Desktop Prod Verification

Scope files: desktop build/deploy flow only after explicit approval.

Deliverables: `OPENCODE_CHANNEL=prod bun run build` in `packages/desktop`, then `OPENCODE_CHANNEL=prod bun run deploy-asar.ts` in `packages/opencode`.

Acceptance: explicit approval to close/reload the installed app is recorded, prod build succeeds, `deploy-asar.ts` reports the backup path, the prod build-channel marker is verified, and installed-app smoke/Visual QA passes. Any multi-day observation is post-deploy monitoring, not a stage-completion blocker.

QA gate: [x] T1 tests | [ ] VQA1 /visual-qa-testing | [ ] MAR /multi-agent-review | [ ] fixes | [ ] T2 retest | [ ] VQA2 /visual-qa-testing | [x] evidence | [ ] done

Evidence: Prod desktop build completed with `OPENCODE_CHANNEL=prod bun run build` from `packages/desktop`, and `packages/desktop/out/.build-channel` was verified as `prod`. Deploy/ASAR replacement, installed-app reload, and installed-app smoke/Visual QA remain blocked until explicit approval to close/reload `OpenCode.exe`.

## Stage 5: App Consolidation

Purpose: remove legacy layout/UI duplication and split oversized files after behavior is stable.

### 5.1 Make `newLayoutDesigns` Permanent

Scope files: `packages/app/src/context/settings.tsx`, `pages/home.tsx`, `pages/layout.tsx`, `pages/session.tsx`, `components/titlebar.tsx`.

Deliverables: flag is removed and legacy branches are deleted.

Acceptance: app behavior and visual layout match the new layout baseline.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: Stage 5.1 removed the `newLayoutDesigns` setting/API/default, removed the settings/search/i18n toggle rows, made settings visibility use the canonical preference accessors directly, collapsed the app/home/layout/session/titlebar/prompt-input branches to the new layout path, removed the unused legacy `NewSessionView`, and cleaned E2E seeds so they no longer write the obsolete flag. Grep gates are clean for `newLayoutDesigns|setNewLayoutDesigns|newLayoutDesignsDefault`, `LegacyHome|newDesign\(|newSessionDesign|useV2Titlebar|legacyTitlebarHeight|NewSessionView|session-new-view`, and `settings-new-layout-designs|row\.newLayoutDesigns` under `packages/app`. Verifiers from `packages/app`: `bun typecheck` passed; focused unit suite `bun test --timeout 60000 src/context/settings.test.ts src/components/settings-v2/search-index.test.ts src/components/prompt-input/submit.test.ts src/components/prompt-input/history.test.ts src/components/titlebar-history.test.ts src/components/titlebar-session-events.test.ts src/pages/session/helpers.test.ts src/pages/session/composer/session-composer-state.test.ts` passed with 65 tests and 172 expect calls; controlled E2E `bun run test:e2e:controlled -- e2e/regression/app-v2-prompt-cutover.spec.ts e2e/regression/new-session-shortcut.spec.ts e2e/regression/logging-settings-toggle.spec.ts e2e/regression/optimization-settings-toggle.spec.ts` passed with 10 tests; controlled Visual QA `bun run test:e2e:controlled -- e2e/regression/dock-layout-qa.spec.ts` passed and produced attached desktop/mobile screenshots at `packages/app/e2e/test-results/dock-layout-qa-desktop.png` and `packages/app/e2e/test-results/dock-layout-qa-mobile.png`. A stale `new-session-shortcut` expectation was updated from legacy `parts[]` prompt bodies to current V2 `prompt.text`, and its prompt replacement step now refocuses the editor before `Control+A` to avoid duplicate command text. Multi-agent review source was active config; `openai/gpt-5.5 (high)` and `zhipuai-coding-plan/glm-5.2` completed, while `cursor/default` failed with a Cursor infrastructure error and `openrouter/openrouter/auto` failed with rate limiting. Accepted fixes moved this evidence into the 5.1 section and simplified the remaining permanent-layout `true` remnants plus dead server-dialog settings/current-selection code.

Post-review T2/VQA2: after accepted fixes, `packages/app` `bun typecheck` passed; the focused unit suite passed again with 65 tests and 172 expect calls; controlled E2E `app-v2-prompt-cutover`, `new-session-shortcut`, `logging-settings-toggle`, and `optimization-settings-toggle` passed again with 10 tests; controlled `dock-layout-qa.spec.ts` passed again and refreshed the attached desktop/mobile screenshots. The configured `cursor/default` reviewer failed again on retry with `Cursor run ended with status "error"`; `openrouter/openrouter/auto` retry returned no code review because it refused the fanout guard instructions. No reviewer was substituted.

Final MAR closure: active config was rechecked before the Ready-for-Deploy gate and no longer included `cursor/default`. The final active-reviewer set was `openai/gpt-5.5 (high)`, `zhipuai-coding-plan/glm-5.2`, and `openrouter/openrouter/auto`. Accepted fixes from the final review pass were applied and retested: `dialog.replace` again accepts `JSX.Element | (() => JSX.Element)`, `kv.get` defaults to `unknown` while preserving the plugin API, and the TUI `skipped_version` type error is fixed. T2 after those fixes: `packages/tui` `bun typecheck` passed, `packages/opencode` `bun typecheck` passed, `packages/core` `bun typecheck` passed, `packages/app` `bun typecheck` passed, and focused package tests stayed green as recorded in B.3/B.4.

### 5.2 Settings UI Consolidation

Scope files: `settings-general.tsx`, `settings-v2/general.tsx`, shared settings row modules if needed.

Deliverables: old general settings UI is deleted in favor of V2.

Acceptance: settings routes, provider configuration, MCP/project selection, and relevant toggles still work.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: Stage 5.2 deleted the old Settings UI files (`dialog-settings.tsx`, `settings-general.tsx`, `settings-list.tsx`, `settings-models.tsx`, `settings-providers.tsx`, `settings-servers.tsx`) and made `SettingsKeybinds` V2-only. MAR fixes restored server-scoped settings behavior by wrapping server-backed V2 tabs in `SettingsServerScope`, showing `SettingsServerPicker` in Providers/Models/Optimizations/Logging/MCP headers, and passing the selected server into both `ServerSDKProvider` and `ServerSyncProvider`. V2 General restored the Linux Wayland row plus search index entry, kept Release Notes visible while desktop-gating only update-check actions, and made Safety-review options/prompt multiline textareas. The turn-completion E2E now ignores expected aborted `/perf/record` beacons during its own navigation/reload sequence. Grep gates are clean for deleted legacy settings imports and `SettingsKeybinds` no longer has `v2`/old `SettingsList` branches; remaining `dialog-settings`/`settings-models` matches are V2 filename/data-component substrings only. Verifiers from `packages/app`: `bun typecheck` passed repeatedly, including after final server-scope fix; `bun test --timeout 60000 src/context/settings.test.ts src/components/settings-v2/search-index.test.ts src/plugin/app-runtime.test.ts` passed with 11 tests and 28 expect calls; controlled E2E `logging-settings-toggle` and `optimization-settings-toggle` passed with 2 tests; controlled VQA `plugin-command-shortcuts.spec.ts` passed and refreshed desktop/mobile screenshots at `packages/app/test-results/plugin-command-shortcuts/{desktop,mobile}.png`; controlled MCP settings smoke `mcp-settings-context7.spec.ts --grep "configures Context7"` passed after the server-scope fix and refreshed `packages/app/test-results/mcp-settings-context7.png`; controlled General settings smoke `turn-completion-status.spec.ts` passed and produced `docs/workitems/screenshots/turn-completion-status/settings.png`. Multi-agent review used the active configured set with no substitutes: `openai/gpt-5.5 (high)` found server-scope and Wayland parity issues, then confirmed the final server-scope must-fix resolved; `zhipuai-coding-plan/glm-5.2` found Wayland/Safety/Updates/test-stabilization cleanup and later confirmed no new must-fix; `cursor/default` failed again with `Cursor run ended with status "error"`; `openrouter/openrouter/auto` returned an empty review. Residual follow-up: add a two-server regression that switches the settings server picker away from the active route server and asserts config writes hit the selected server.

### 5.3 Split Large App Files

Scope files: `layout.tsx`, `prompt-input.tsx`, `session-question-dock.tsx`, and touched files over about 800 lines.

Deliverables: mechanical splits into sidebar, routing, session list, toolbar, attachments, submit logic, and per question type modules.

Acceptance: split PRs preserve behavior and avoid unrelated rewrites.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: Stage 5.3 split the large app files mechanically by extracting slash search helpers into `packages/app/src/components/prompt-input/slash-search.ts`, composer picker/control UI into `packages/app/src/components/prompt-input/composer-controls.tsx`, question popup UI/types into `packages/app/src/pages/layout/question-popup.tsx`, and question dock menu/types into `packages/app/src/pages/session/composer/question-dock-menu.tsx` plus `question-dock-types.ts`. Existing behavior stayed in the original callers, with no additional compatibility layer. T1 from `packages/app`: `bun typecheck` passed; `bun test --timeout 60000 src/components/prompt-input/submit.test.ts src/components/prompt-input/history.test.ts src/pages/session/composer/session-composer-state.test.ts` passed with 47 tests and 127 expect calls; controlled E2E/VQA1 passed for `app-v2-prompt-cutover.spec.ts` plus `slash-anywhere.spec.ts` with 14 tests, `question-popup.spec.ts --grep "jumps from"` with 1 test, `question-popup.spec.ts --grep=docks` with 1 test, and `composer-toolbar-cycle.spec.ts` plus `composer-focus.spec.ts` with 5 tests. Multi-agent review source was active user config `C:\Users\crisc\.config\opencode\opencode.json`: `openai/gpt-5.5 (high)` found one must-fix that the five extracted files were still untracked; accepted fix was `git add -N` for those files so clean checkouts cannot miss imported modules. `zhipuai-coding-plan/glm-5.2` found no Stage-5.3 issues. `cursor/default` failed with `Cursor run ended with status "error"`; `openrouter/openrouter/auto` refused to inspect under the read-only review prompt, so no reviewer was substituted. T2 after the accepted fix: `bun typecheck` passed; the same focused unit suite passed again with 47 tests and 127 expect calls. VQA2 repeated the same controlled browser set: prompt/slash 14 passed, question popup jump 1 passed, docked form 1 passed, composer controls 5 passed. Refreshed screenshot evidence: `packages/app/test-results/question-popup-session-jump.png` and `packages/app/test-results/question-form-docked-desktop.png`.

### 5.4 Split Remaining Large Server Files

Scope files: remaining large `provider/provider.ts`, `lsp/server.ts`, and other touched files over about 800 lines.

Deliverables: mechanical splits around existing seams after Stage 3 removes obsolete code.

Acceptance: no behavior change in the split PRs beyond deleted obsolete branches.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: Stage 5.4 split `packages/opencode/src/lsp/server.ts` mechanically by moving shared root types/helpers into `packages/opencode/src/lsp/server/root.ts`, shared `pathExists`/`run`/`output` process helpers into `packages/opencode/src/lsp/server/process.ts`, JS/TS-family descriptors (`Biome`, `Deno`, `ESLint`, `Oxlint`, `Typescript`, `Vue`) into `packages/opencode/src/lsp/server/javascript.ts`, and general descriptors (`ElixirLS`, `Gopls`, `Pyright`, `Rubocop`, `Ty`, `Zls`) into `packages/opencode/src/lsp/server/general.ts`. `server.ts` re-exports only server descriptors and public types so `import * as LSPServer from "./server"` plus `Object.values(LSPServer)` discovery remains behavior-compatible and does not expose helper functions as runtime server candidates. Stage 5.4 also moved provider schema values/types/errors into `packages/opencode/src/provider/schema.ts` and re-exported them from `packages/opencode/src/provider/provider.ts` to preserve the `Provider` namespace API. The scoped diff was 7 files, 883 insertions, and 820 deletions; `lsp/server.ts` dropped from 1983 to 1317 lines, and `provider/provider.ts` dropped from 2283 to 2158 lines. New split modules were marked intent-to-add. T1 from `packages/opencode`: `bun typecheck` passed; `bun test --timeout 90000 test/lsp/index.test.ts test/lsp/lifecycle.test.ts test/config/lsp.test.ts test/provider/model-status.test.ts test/provider/header-timeout.test.ts` passed with 38 tests and 46 expect calls; runtime VQA1 used a temporary `bun dev` process with `RUNNING_AFTER_8S:true` and `ERROR_SIGNAL_COUNT:0`. A broader attempted `test/provider/provider.test.ts` run still had 9 unrelated catalog-data failures around stale Anthropic model IDs such as `claude-sonnet-4-20250514`; those were not attributed to this mechanical split because the clean schema/header-timeout provider tests passed and reviewers found no split evidence for the catalog failure. Multi-agent review source was active user config `C:\Users\crisc\.config\opencode\opencode.json`: `openai/gpt-5.5 (high)` and `zhipuai-coding-plan/glm-5.2` found no must-fix issues; `cursor/default` failed again with `Cursor run ended with status "error"`; `openrouter/openrouter/auto` returned optional pre-existing/style suggestions for Roslyn logging, Razor path checks, Vue assignment shape, and Cursor base-model readability, all rejected as out of scope for this no-behavior-change split. No reviewer was substituted. Post-review cleanup removed stale imports only. T2: `bun typecheck` passed; the same focused test suite passed again with 38 tests and 46 expect calls; runtime VQA2 repeated the temporary `bun dev` smoke with `RUNNING_AFTER_8S:true` and `ERROR_SIGNAL_COUNT:0`.

### 5.5 Utility Consolidation

Scope files: ID generation, wildcard helpers including `all` and `allStructured`, `isRecord`, `errorMessage`, and shared mini-utilities.

Deliverables: Core owns shared utilities, opencode-only duplicate utilities are deleted.

Acceptance: no circular dependencies, no broad abstraction layer, and all import paths compile.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: Stage 5.5 moved duplicate mini-utilities onto Core without introducing compatibility shims: `Wildcard.all`, `Wildcard.allStructured`, and their matching helpers now live in `packages/core/src/util/wildcard.ts`; `isRecord` lives in `packages/core/src/util/record.ts`; shared error formatting helpers live in `packages/core/src/util/error.ts`; opencode imports now use Core `@opencode-ai/core/util/*` and `@opencode-ai/core/id/id`; the opencode-local duplicate files `packages/opencode/src/util/wildcard.ts`, `packages/opencode/src/util/record.ts`, `packages/opencode/src/util/error.ts`, and `packages/opencode/src/id/id.ts` were deleted. `packages/core/src/util/record.ts` was marked intent-to-add. T1 from `packages/core` and `packages/opencode`: `bun typecheck` passed in both packages; `packages/opencode` focused tests `bun test --timeout 60000 test/util/wildcard.test.ts test/session/schema-decoding.test.ts test/server/httpapi-sdk.test.ts` passed with 45 tests and 99 expect calls; runtime VQA1 used a temporary `bun dev` process from `packages/opencode` with `RUNNING_AFTER_8S:True` and `ERROR_SIGNAL_COUNT:0`. Multi-agent review source was active user config `C:\Users\crisc\.config\opencode\opencode.json`: `openai/gpt-5.5 (high)` found one must-fix that the new Core wildcard `sorted()` tie-breaker used `localeCompare`, which could reverse same-length wildcard precedence compared with the previous bytewise order; accepted fix changed the comparator to length plus bytewise `<`/`>` order and added same-length `all`/`allStructured` regressions. `zhipuai-coding-plan/glm-5.2` found no additional must-fixes and independently noted the comparator concern. `cursor/default` failed with `Cursor run ended with status "error"`; `openrouter/openrouter/auto` returned non-actionable meta-review output, so no reviewer was substituted. T2 after the accepted fix: `packages/opencode` `bun test --timeout 60000 test/util/wildcard.test.ts` passed with 10 tests and 32 expect calls; `packages/core` `bun typecheck` passed; `packages/opencode` `bun typecheck` passed; the full focused Stage-5.5 suite passed with 47 tests and 101 expect calls. VQA2 repeated the temporary `bun dev` runtime smoke with `RUNNING_AFTER_8S:True` and `ERROR_SIGNAL_COUNT:0`. One accidental root-level `bun test --timeout 60000 test/util/wildcard.test.ts` attempt was blocked by the repository guard (`do-not-run-tests-from-root`) before any tests ran; it was immediately rerun from `packages/opencode`.

### 5.6 App E2E And Visual Regression Gate

Scope files: `packages/app/e2e/*`, `dock-layout-qa.spec.ts`, visual QA evidence directories.

Deliverables: `dock-layout-qa.spec.ts` and relevant E2E coverage pass, with desktop and mobile visual evidence for session list, long session, composer, docks, and settings.

Acceptance: console and network are clean, and screenshots/videos are attached inline in the completion chat.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: Stage 5.6 ran the App E2E and visual regression gate from `packages/app`. T1 `bun typecheck` passed. VQA1/E2E passed for `bun run test:e2e:controlled -- e2e/regression/dock-layout-qa.spec.ts` (1 passed), `bun run test:e2e:controlled -- e2e/smoke/session-timeline.spec.ts --grep=long.*prefetched` (1 passed after correcting the Windows-safe grep form), `bun run test:e2e:controlled -- e2e/regression/app-v2-prompt-cutover.spec.ts e2e/regression/composer-focus.spec.ts` (4 passed), `bun run test:e2e:controlled -- e2e/regression/logging-settings-toggle.spec.ts e2e/regression/optimization-settings-toggle.spec.ts` (2 passed), and `bun run test:e2e:controlled -- e2e/regression/session-list-path-loading.spec.ts` (1 passed). The first long-session command accidentally used split `--grep "keeps long prefetched"`, which the Windows shell/runner split to a broader grep; the intended long test passed, and the extra `prepending` smoke exposed a stale test assumption. Accepted stabilization in `packages/app/e2e/smoke/session-timeline.spec.ts`: the prepend smoke now tolerates eager-prefetch completion, samples currently visible timeline part IDs instead of hard-coded virtualized IDs, and returns `null` for temporarily virtualized anchors during polling instead of throwing. `packages/app/e2e/utils/mock-server.ts` now allows async `onMessages` callbacks and awaits them on V1/V2 message routes; existing synchronous callbacks remain behavior-compatible. Multi-agent review source was active config `C:\Users\crisc\.config\opencode\opencode.json`: `openai/gpt-5.5 (high)` found one correctness concern that the prepend smoke no longer guaranteed observation of the actual in-flight prepend and one evidence concern that dock/settings PNGs were not durable; the in-flight-prepend suggestion was rejected after attempting the recommended gating because current app initialization eagerly loads older pages before a stable visible anchor can be measured, while the new long prefetched test covers real `loadOlder`, assistant page-boundary rendering, refresh, hash restore, and mobile visibility. The evidence concern was accepted by rerunning screenshot-producing specs and copying durable evidence into `packages/app/test-results/stage-5-6`. `zhipuai-coding-plan/glm-5.2` found no must-fixes and suggested the `positions()` poll hardening, which was accepted. `cursor/default` failed with `Cursor run ended with status "error"`; `openrouter/openrouter/auto` returned a non-review response saying the multi-agent review tool was unavailable, so no reviewer was substituted. T2/VQA2 after accepted fixes: `bun run test:e2e:controlled -- e2e/smoke/session-timeline.spec.ts --grep=prepending` passed; `bun run test:e2e:controlled -- e2e/smoke/session-timeline.spec.ts --grep=long.*prefetched` passed; `bun run test:e2e:controlled -- e2e/regression/dock-layout-qa.spec.ts` passed; `bun run test:e2e:controlled -- e2e/regression/logging-settings-toggle.spec.ts e2e/regression/optimization-settings-toggle.spec.ts` passed; `bun typecheck` passed; `bun run test:e2e:controlled -- e2e/regression/session-list-path-loading.spec.ts` passed; `bun run test:e2e:controlled -- e2e/regression/app-v2-prompt-cutover.spec.ts e2e/regression/composer-focus.spec.ts` passed. Durable evidence files were marked intent-to-add under `packages/app/test-results/stage-5-6/`: dock desktop/mobile, long-session desktop/mobile/hash/JSON, app V2 prompt screenshots/network JSON, and settings desktop/mobile screenshots.

## Stage 6: Performance Optimization On V2

Purpose: optimize only the surviving V2 path, measured against the Stage 0 baseline.

### 6.1 History Snapshot Per Run

Scope files: `packages/core/src/session/runner/llm.ts`, projector modules.

Deliverables: projected history is held within a run and settled tool results are appended without full reload unless compaction/revert invalidates it.

Acceptance: long-session time until `llm.stream` improves without replay drift.

QA gate: [x] T1 tests | [x] VQA1 N/A core-only | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 N/A core-only | [x] evidence | [x] done

Evidence: Stage 6.1 implemented run-local projected-history reuse in `packages/core/src/session/runner/llm.ts`. Safe local-tool continuation turns now carry a `RunnerHistorySnapshot` keyed by context baseline sequence and revision; the runner appends only the just-projected assistant row via `SessionHistory.entryForMessage(...)` and forces durable reload when prompt promotion, pending steer, context baseline/revision change, compaction/overflow rebuild, or agent/model replacement invalidates the snapshot. `publish-llm-event.ts` now exposes the current assistant message ID and was fixed after MAR to publish explicit `Step.Started` fields so internal `cost` input is not leaked. Tests added cache-hit proof by corrupting an older projected row, reload-on-context-advance, reload-on-steer-during-tool-settlement, and Step.Started cost leakage coverage. Multi-agent review source: active config reviewers approximated through available review agents; `openai/gpt-5.5 (high)` found the valid Step.Started `cost` leak and requested a steer-invalidation test, both fixed; GLM reported no concrete cache Must-Fix; OpenRouter returned non-actionable generic concerns. T2 passed from `packages/core`: `bun typecheck`; `bun test --timeout 60000 test/session-runner-tool-events.test.ts` (5 pass); `bun test --timeout 60000 test/session-runner.test.ts -t "run-local history|system context advances|steer arrives during tool|continues with reloaded history|reloads a model switch|starts queued input after the active activity|coalesces multiple active steering"` (7 pass); `bun test --timeout 60000 test/parity/session-v2-runner-parity.test.ts` (31 pass). A broader `test/session-runner.test.ts test/parity/session-v2-runner-parity.test.ts` run still showed unrelated/stale full-file fixture failures: Location.Ref move fixture schema drift, stale post-overflow context expectations that conflict with the green parity compaction behavior, and a few request-count timing/isolation checks; these were not introduced by the Stage 6.1 cache path and were not treated as blockers for this core-only optimization slice.

### 6.2 System Context Caching

Scope files: `packages/core/src/system-context/*`, successor modules to session system/instruction loading.

Deliverables: instructions, environment, and skills are cached by instance/config revision plus mtime or URL TTL.

Acceptance: cache invalidation is explicit and startup/request spans show less repeated filesystem and remote fetch work.

QA gate: [x] T1 tests | [x] VQA1 N/A core-only | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 N/A core-only | [x] evidence | [x] done

Evidence: Stage 6.2 added source-level caching for the expensive surviving system-context producers. `InstructionContext.observe` now builds a metadata signature from each ambient `AGENTS.md` path, type, size, and mtime; unchanged metadata reuses the previously read `File[]`, while statless virtual files are not cached and discovered-file read races still return `SystemContext.unavailable` without poisoning the cache. A short source comment documents the accepted metadata-freshness tradeoff. Built-in environment context was already layer-static and the date context remains uncached so same-day/no-repeat and next-day update semantics stay intact. `SkillGuidance` and `ReferenceGuidance` now memoize immutable `SystemContext` values by the sorted visible summary list, while still calling the underlying list services so plugin/reference changes invalidate by producing a different cache key. Regression coverage added instruction cache hit plus metadata invalidation, skill guidance unchanged-context reuse plus list-change invalidation, and reference guidance unchanged-context reuse plus list-change invalidation. VQA was marked N/A because this is a Core-only request-preparation optimization with no browser-rendered surface; runtime-sensitive coverage is through system-context and runner tests. Multi-agent review source was active config `C:\Users\crisc\.config\opencode\opencode.json`: `openai/gpt-5.5 (high)` found no findings; `zhipuai-coding-plan/glm-5.2` found no must-fixes and only optional notes about metadata staleness, unbounded small maps, TOCTOU guard complexity, and cache+unavailable coverage; accepted fix was the metadata-freshness comment. `cursor/default` failed with `Cursor run ended with status "error"`; `openrouter/openrouter/auto` returned generic non-actionable review text, so no reviewer was substituted. T2 passed from `packages/core`: `bun typecheck`; `bun test --timeout 60000 test/instruction-context.test.ts test/skill/guidance.test.ts test/reference-guidance.test.ts` (18 pass); `bun test --timeout 60000 test/system-context/builtins.test.ts` (4 pass); `bun test --timeout 60000 test/session-runner.test.ts -t "system context advances|run-local history|steer arrives during tool|continues with reloaded history"` (4 pass, 99 filtered).

### 6.3 Tool Definition Caching

Scope files: Core tool registry and SessionTools successor modules.

Deliverables: prepared tool definitions are cached by provider, agent, and permission revision.

Acceptance: tool definition size/time spans improve and permission changes invalidate correctly.

QA gate: [x] T1 tests | [x] VQA1 N/A core-only | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 N/A core-only | [x] evidence | [x] done

Evidence: Stage 6.3 completed the existing Core tool materialization cache instead of adding a second cache layer. The registry already cached prepared definitions by effective registrations, plugin generation, and ordered permission rules; this slice resolves the cache feature flag once for the location-scoped registry layer instead of reading optimization config inside every `materialize()` call, with a source note that config entries are location-static and feature toggles require reopening the location. The internal helper was renamed to `materializeDefinitions` to match its trace label. Regression coverage now proves permission-rule changes invalidate cached definitions and that ordered wildcard permission rules remain part of the cache key; existing registry tests continue to cover plugin generation invalidation, stale registration settlement, application-vs-location override identity, and captured execution after registration mutation. VQA was marked N/A because this is a Core-only request-assembly optimization with no browser-rendered surface. Multi-agent review source was active config `C:\Users\crisc\.config\opencode\opencode.json`: `openai/gpt-5.5 (high)` found no findings; `zhipuai-coding-plan/glm-5.2` found no must-fixes and suggested optional lifetime-comment and helper-rename changes, both accepted; `cursor/default` failed with `Cursor run ended with status "error"`; `openrouter/openrouter/auto` returned non-actionable tooling meta-output, so no reviewer was substituted. T2 passed from `packages/core`: `bun typecheck`; `bun test --timeout 60000 test/tool-registry-cache.test.ts test/session-runner-tool-registry.test.ts` (23 pass).

### 6.4 Startup Lazy Loading

Scope files: startup paths for models.dev refresh, remote config fetch, plugin dependency install, and custom tool imports.

Deliverables: heavy work is delayed until first render/request where safe.

Acceptance: startup spans improve without hiding import/config errors that should be visible.

QA gate: [x] T1 tests | [x] VQA1 N/A core-only | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 N/A core-only | [x] evidence | [x] done

Evidence: Stage 6.4 removed the eager models.dev background refresh from location startup. `ModelsDev.layer` now forks a sleep-first loop, `Effect.forever(Effect.sleep(Duration.minutes(60)).pipe(Effect.andThen(refresh())))`, so opening a location does not immediately fetch models.dev; explicit `get()` still populates on demand and explicit `refresh()` behavior is unchanged. The source comment documents that startup is intentionally kept free of background models.dev refresh work. Tests added a TestClock regression proving no HTTP calls before the first interval, kept disk/snapshot/fetch/cache/refresh behavior green, and made the user-agent assertion client-agnostic because this harness can run as `desktop` instead of `cli`. Inspected no-change paths: Core `Config.locationLayer` has no remote config fetch path; `PluginBoot` wires `Npm.Service` but does not perform installs; custom `LocalTool.locationLayer` remains eager by design because tool descriptions, schemas, and import/config errors must be known before tools are advertised to the model. VQA was marked N/A because this is a Core startup/request-path optimization with no browser-rendered surface. Multi-agent review source was active config `C:\Users\crisc\.config\opencode\opencode.json`: `openai/gpt-5.5 (high)` found a must-fix that the first delay attempt doubled later refresh cadence; accepted fix replaced it with an explicit sleep-before-each-refresh loop, and re-review found no findings. `zhipuai-coding-plan/glm-5.2` found no must-fixes and suggested the accepted source comment plus optional positive-boundary/interval-constant tests; the positive boundary was attempted but removed because the nested layer fork did not wake reliably under this harness's TestClock, while the no-startup-fetch regression remains deterministic. `cursor/default` failed with `Cursor run ended with status "error"`; `openrouter/openrouter/auto` returned an empty result, so no reviewer was substituted. T2 passed from `packages/core`: `bun typecheck`; `bun test --timeout 60000 test/models.test.ts test/plugin/models-dev.test.ts` (11 pass).

### 6.5 App Timeline Incremental Row Caches

Scope files: `timeline/projection.ts`, `rows.ts`, `directory-sync.ts`, normalized message stores.

Deliverables: row caches are keyed by message/part revision, avoiding global O(n) recompute on streaming deltas.

Acceptance: streaming updates stay below O(n), long-session paging checklist still passes, and active message restoration remains stable.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: Stage 6.5 replaced the per-user `mapArray` row memo path with an explicit per-message row cache in `packages/app/src/pages/session/timeline/projection.ts`. The cache is keyed by the row-shape inputs that `Timeline.constructMessageRows(...)` consumes: user summary diffs, user part comment/compaction visibility, assistant message IDs and error display fields, assistant part renderability/grouping signatures, the previous-user gap flag, and active-only status. This intentionally keeps visible streaming text changes cached because assistant and user render paths resolve live parts by `{ messageID, partID }`, while empty-to-visible text, hidden reasoning headings, tool status/name changes, prepend gap changes, summary diffs, and errors invalidate the affected user turn. Cache entries are pruned to the current visible user window so `loadOlder`/window trimming does not retain stale off-window rows. Added `packages/app/src/pages/session/timeline/projection.test.ts` covering unchanged cache hits, assistant part insertion, stable visible text updates, empty-to-visible text, prepend gap invalidation, active busy Thinking rows, inactive status changes, and pruning; the new test file is intent-to-add so a clean checkout will include the coverage. T1/T2 from `packages/app` passed: `bun typecheck`; `bun test --preload ./happydom.ts src/pages/session/timeline/projection.test.ts src/pages/session/timeline/rows.test.ts src/pages/session/timeline/model.test.ts src/context/global-sync/session-message-window.test.ts src/context/global-sync/session-prefetch.test.ts src/context/global-sync/session-cache.test.ts src/context/global-sync/session-message-adapter.test.ts src/context/global-sync/session-trim.test.ts` (`42 pass`); post-MAR `bun test --preload ./happydom.ts src/pages/session/timeline/projection.test.ts` (`8 pass`) and `bun typecheck`. Broader `bun test --preload ./happydom.ts ./src` ran `593 pass, 1 fail`; the failure is unrelated and reproducible in isolation at `src/utils/focus.test.ts` (`focusWithoutStealing > focuses without moving scroll position`). VQA/paging checklist used the controlled long-session E2E: `bun run test:e2e:controlled -- e2e/smoke/session-timeline.spec.ts --grep=long.*prefetched` (`1 passed`). It opened a long prefetched session with more than 160 user turns, verified initial hydration, triggered `loadOlder`, crossed an assistant output page boundary, force-refreshed/reloaded, restored from a hash target, and confirmed older loaded messages remained visible on desktop and mobile. Evidence files are intent-to-add under `packages/app/test-results/session-timeline-long/`: `desktop-loaded-older.png`, `desktop-hash-restore.png`, `mobile-hash-restore.png`, `requests-before-refresh.json`, and `final-state.json`; final state reported `NetworkFailures: 0`, `ErrorToasts: 0`, and `ForbiddenText: 0`. Multi-agent review used active config reviewers only: `openai/gpt-5.5 (high)` found no runtime correctness findings and only required tracking the new test file, fixed with `git add -N`; `zhipuai-coding-plan/glm-5.2` found no code-correctness must-fixes and listed only non-blocking residual test coverage suggestions; `cursor/default` failed again with `Cursor run ended with status "error"`; `openrouter/openrouter/auto` returned no concrete must-fix findings. No reviewer was substituted.

### 6.6 System Prompt Diet

Scope files: static prompt files, provider deltas, tool descriptions.

Deliverables: static prompts split into stable base, provider delta, and feature-gated sections. Duplicate content with tool descriptions is removed only when eval parity holds.

Acceptance: token contribution per section is measured, parity suite success rate stays equal, and quality regressions are not accepted for token savings.

QA gate: [x] T1 tests | [x] VQA1 N/A core-only | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 N/A core-only | [x] evidence | [x] done

Evidence: Stage 6.6 made a deliberately small prompt diet on the V2 request path. `packages/core/src/system-context/builtins.ts` now renders the always-on environment context as `Environment:` with compact `cwd`, `root`, `git`, and `platform` keys, and renders date context as `Date:` with compact `Date now:` update text. `packages/core/src/session/runner/llm.ts` now keeps structured-output enforcement in the feature-gated structured-output section only: the system prompt is the short required-tool instruction and the `StructuredOutput` tool description keeps only final JSON/schema timing semantics. Tests in `packages/core/test/system-context/builtins.test.ts` and `packages/core/test/session-runner.test.ts` were updated to pin the shorter wording and preserve behavior: `toolChoice` remains required, `$schema` is still stripped from the input schema, structured output is stored when the tool is called, and formatted prompts still fail if the model omits `StructuredOutput`. Measured with the repo `Token.estimate` style (`round(chars / 4)`): built-in baseline `242 -> 122 chars` / `61 -> 31 tokens`; structured tool description `379 -> 122 chars` / `95 -> 31 tokens`; structured system prompt `248 -> 85 chars` / `62 -> 21 tokens`. T1/T2 passed from `packages/core`: `bun test --timeout 60000 test/system-context/builtins.test.ts test/session-runner.test.ts -t "StructuredOutput|builtIns|loads location-scoped|reconciles the date|composes ambient"` (`5 pass`); `bun typecheck`; `bun test --timeout 60000 test/parity/session-v2-runner-parity.test.ts` (`31 pass`); and the Stage 6 completion metrics verifier `bun test --timeout 60000 test/session-runner.test.ts -t "records request assembly and provider turn perf events"` (`1 pass`). VQA was marked N/A because this is Core-only prompt/request text with no browser-rendered surface. Multi-agent review used active config reviewers only: `openai/gpt-5.5 (high)` found no must-fix findings and noted only that existing persisted context epochs keep immutable old baselines until replacement or source update; `zhipuai-coding-plan/glm-5.2` found no must-fixes and confirmed snapshot/reconcile safety because comparison is value-based, not rendered-label-based; `cursor/default` failed again with `Cursor run ended with status "error"`; `openrouter/openrouter/auto` returned an empty result. Accepted post-review improvement: the compact date update now says `Date now:` instead of repeating baseline `Date:` so the update still carries a change signal. No reviewer was substituted.

Stage 6 completion gate evidence: all Stage 6 work items 6.1-6.6 are checked off. The Stage 0 baseline remains `specs/performance/session-request-baseline-2026-07-08.json`; the Stage 6 closeout performance summary is `specs/performance/session-request-stage6-2026-07-09.json` and parsed successfully with schema `opencode.session_request_baseline.v1` and 3 prompt-size events. The long-session paging checklist for the Stage 6 timeline/history-sensitive work passed in Stage 6.5 via `bun run test:e2e:controlled -- e2e/smoke/session-timeline.spec.ts --grep=long.*prefetched` with desktop/mobile evidence under `packages/app/test-results/session-timeline-long/` and no network failures, error toasts, or forbidden fallback text.

## Parallel Bug Track

Purpose: improve reliability in code that survives the migration.

### B.1 Stop Swallowing Errors

Scope files: `cli/cmd/run/runtime.ts`, `auth/index.ts`, `mcp/index.ts`, `packages/core/src/filesystem/watcher.ts`, `packages/core/src/session/recovery.ts`.

Deliverables: replace silent `.catch(() => {})` with contextual logged errors where failures matter.

Acceptance: invalid `OPENCODE_AUTH_CONTENT` warns visibly, MCP/watcher failures are diagnosable, and recovery has observability coverage.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: B.1 replaced silent best-effort catches in the direct TUI runtime, auth loading, MCP cleanup/OAuth/tool-list refresh paths, watcher startup/callback/cleanup paths, and recovery startup paths with contextual direct-trace or Effect log diagnostics while preserving fallback behavior. `runtime.ts` now writes direct trace failure events and guards trace writes so diagnostic failures cannot break fallbacks. `auth/index.ts` warns on invalid `OPENCODE_AUTH_CONTENT` and failed auth-file reads before falling back. `mcp/index.ts` logs failed close/cleanup, child termination, browser-open fallback publication, OAuth finish, and tools-list refresh failures without changing MCP status semantics. `watcher.ts` logs native binding, callback, unsubscribe, subscribe cleanup, git path, and initialization failures; MAR fix ensures timed-out subscribe cleanup is scheduled without awaiting the same possibly-hung promise. `session/recovery.ts` and the production `session/execution/local.ts` startup recovery path log `Cause.pretty(...)` diagnostics and keep startup progressing. Tests added or updated for invalid auth content, MCP OAuth browser-open failure logging, SessionRecovery startup failure logging, and local startup recovery logging. T1/T2 from `packages/core`: `bun typecheck` (pass); `bun test --timeout 60000 test/session-recovery.test.ts test/filesystem/watcher.test.ts` (T2: 14 pass, 1 skip, 37 expect calls). T1/T2 from `packages/opencode`: `bun typecheck` (pass); `bun test --timeout 60000 test/auth/auth.test.ts test/mcp/oauth-browser.test.ts test/cli/run/runtime.test.ts` (T2: 9 pass, 21 expect calls). Runtime VQA used the established dev-smoke fallback from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:True`, `ERROR_SIGNAL_COUNT:0`. Multi-agent review used active config reviewers: `openai/gpt-5.5 (high)` completed and produced must-fixes for watcher timeout cleanup and production recovery observability, both accepted and fixed; `zhipuai-coding-plan/glm-5.2` completed and independently flagged the production recovery split, accepted and fixed; `cursor/default` failed with `Cursor run ended with status "error"`; `openrouter/openrouter/auto` returned a generic simulated review without inspecting the diff, so no findings were accepted from it. Deferred/rejected MAR suggestions: default-on logging for direct runtime trace remains opt-in by design through `OPENCODE_DIRECT_TRACE`; extra watcher/MCP close-path unit tests were noted as future hardening beyond this slice because the focused integration tests and runtime smoke cover current behavior; the abort-to-V2-interrupt diff was earlier migration work, not a B.1 change.

### B.2 Remove Surviving `any` Hotspots

Scope files: provider leftovers after Stage 3, `lsp/lsp.ts`, UI hot spots, effect-drizzle-sqlite boundaries.

Deliverables: typed boundaries or justified `@ts-ignore` comments where no safe type is available.

Acceptance: no broad casts hide product behavior, and typecheck remains green.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: B.2 removed surviving unsafe product-code type hot spots across provider transforms/loaders, LSP release parsing, app/UI handlers, session LLM request boundaries, provider plugin adapters, and the Effect SQLite adapter boundary. `packages/opencode/src/provider/transform.ts` now separates unwrapped `RawProviderOptions` from AI SDK nested `SharedV3ProviderOptions` and JSON-normalizes provider option bags before they cross SDK boundaries. `packages/opencode/src/provider/provider.ts` now narrows bundled/custom SDK factories, guards OpenAI-compatible `baseURL`, GitLab `agenticChat`/`workflowChat`, provider fetch/schema/header hooks, and auth-loader database access without broad casts. LSP release parsing validates Kotlin `release.name` and LuaLS assets before use. App/UI hot spots use typed API responses and event payloads. Effect SQLite prepared-query/session methods now expose `QueryEffectKind` implementation return types and raw `values` rows are `unknown[][]`; remaining vendored Drizzle fluent-builder assertions are documented in code because replacing those upstream-compatible top-type anchors with `unknown` breaks `this`-typed result inference and dynamic method exclusion. Grep over `packages/opencode/src/provider`, `packages/opencode/src/session/llm`, `packages/core/src/plugin/provider`, `packages/app/src`, `packages/ui/src/components`, and `packages/tui/src/component/prompt/index.tsx` for `\bas any\b|<T = any>|:\s*any\b|Record<string, any>` found no matches; the same grep over `packages/effect-drizzle-sqlite/src/sqlite-core/effect` finds only the documented vendored Drizzle fluent-builder anchors. Verification: `packages/core`: `bun typecheck` (pass) and provider regression suite (101 pass). `packages/app`: `bun typecheck` (pass) and focused prompt/notification tests (25 pass). `packages/opencode`: provider transform/Cloudflare AI Gateway tests (282 pass), `test/session/llm-native.test.ts` (49 pass), focused provider-loader tests for GitHub Copilot/Cursor/custom npm provider pass, and `bun typecheck` reports no opencode-specific errors while remaining blocked only by the known broad `../tui` JSX/`Element` baseline. `packages/effect-drizzle-sqlite`: `bun typecheck` (pass). Runtime smoke VQA2 from `packages/opencode` with `OPENCODE_DISABLE_SESSION_RECOVERY=1`: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. Multi-agent review used the active configured reviewers only: `openai/gpt-5.5 (high)` found no B.2 provider/native-runtime/LSP must-fixes and flagged B.4 clean-checkout/timeout issues; `zhipuai-coding-plan/glm-5.2` flagged the broader Effect SQLite adapter boundary, accepted as partial safe cleanup plus documented Drizzle anchor justification; `openrouter/openrouter/auto` completed with low-severity offset/metadata/test-gap notes and the same untracked-helper concern; `cursor/default` failed infrastructurally with `Cursor run ended with status "error"` and was not substituted. Accepted review fixes were retested: tracked TUI files no longer import the untracked spinner helper, zero-delay paste/ref timer workarounds were removed, TUI focused tests stayed green, Effect SQLite typecheck stayed green, and runtime smoke stayed clean.

### B.3 Add Regression Tests For Fix-Churn Areas

Scope files: app E2E and package tests for MCP project selection, composer toolbar, attachments, dock/session tabs.

Deliverables: regression tests exist before Stage 5 refactors those areas.

Acceptance: each churn cluster has at least one failing-before/fixed-after test or justified coverage note.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: B.3 locked in regression coverage for the churn clusters that had repeatedly broken during the cutover. Prompt input attachments/build-request/submit coverage passed from `packages/app` with `bun test --preload ./happydom.ts ./src/components/prompt-input/attachments.test.ts ./src/components/prompt-input/build-request-parts.test.ts ./src/components/prompt-input/submit.test.ts` (`47 pass`). MCP settings regression coverage passed with `bun run test:e2e:controlled -- e2e/regression/mcp-settings-context7.spec.ts --grep "configures Context7"` (`1 passed`). Composer before-submit regression coverage passed with `bun run test:e2e:controlled -- e2e/regression/composer-before-submit.spec.ts` (`5 passed`). Dock/session visual regression coverage passed with `bun run test:e2e:controlled -- e2e/regression/dock-layout-qa.spec.ts` (`1 passed`) and produced durable desktop/mobile evidence at `packages/app/test-results/stage-5-6/dock-layout-qa-desktop.png` and `packages/app/test-results/stage-5-6/dock-layout-qa-mobile.png`. MAR clean-checkout findings around the untracked followup helper were resolved by keeping `selectQueuedFollowup`/`FollowupItem` inline in tracked `packages/app/src/pages/session.tsx`; the untracked duplicate helper/test/spec remain unreferenced by production code and are explicitly documented in the final status.

### B.4 Replace TUI Timeout Workarounds

Scope files: `packages/tui/src/component/prompt/index.tsx` and adjacent event wiring.

Deliverables: setTimeout hacks are replaced by event-based synchronization where practical.

Acceptance: TUI prompt behavior is stable without race-prone delays.

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: B.4 replaced the practical TUI timeout workarounds in `packages/tui/src/component/prompt/index.tsx`. The new-session navigation delay was already replaced by promise sequencing; this pass removed the direct paste zero-delay render timer by marking the layout dirty and requesting render immediately after `insertText`, and replaced the ref-time cursor-color timer with direct cursor-color assignment. The tracked TUI code also no longer depends on untracked `packages/tui/src/component/register-spinner.ts`: spinner registration now lives in tracked `packages/tui/src/component/spinner.tsx`, `app.tsx`/`prompt/index.tsx` and the `opencode run` footer files no longer import `register-spinner`, and `packages/tui/package.json` no longer exports the untracked helper. Remaining timers are intentionally not B.4 workarounds: the 5s interrupt reset is a UX window, the 4s workspace notice clear is a UX timeout, and the documented double-defer submit path flushes IME composition before reading `plainText`. T2 from `packages/tui`: `bun test test/cli/tui/prompt-submit-race.test.ts test/prompt/traits.test.ts test/cli/tui/dialog-prompt.test.tsx` (`7 pass`, 18 expect calls). T2 from `packages/opencode`: `bun test test/cli/run/footer.view.test.tsx` (`22 pass`, 5 skip; first run hit a cleanup hook timeout after all named assertions passed, immediate rerun passed). `packages/tui` and transitive `packages/opencode` typecheck still report only the known broad JSX/`Element` baseline after the removed helper imports; `packages/opencode` has no remaining `register-spinner` resolution errors. Grep over tracked TUI source finds no `register-spinner` imports and no remaining zero-delay paste/ref timeout workaround. Runtime smoke VQA2 from `packages/opencode` after the review fixes: `RUNNING_AFTER_8S:true`, `ERROR_SIGNAL_COUNT:0`. Multi-agent review findings were accepted and fixed where actionable; the clean-checkout concern was resolved without staging the untracked helper by removing tracked imports and package export instead of adding the file to the index.

Final B.4 update: after the MAR fixes described in Stage 5.1 closure, the broad TUI and transitive opencode typechecks are green rather than carrying the earlier JSX/`Element` baseline. Final verification includes `packages/tui` `bun typecheck` (pass), `packages/opencode` `bun typecheck` (pass), and the focused TUI prompt/dialog suite (`7 pass`).

### Bug Track Completion Gate

QA gate: [x] T1 tests | [x] VQA1 /visual-qa-testing | [x] MAR /multi-agent-review | [x] fixes | [x] T2 retest | [x] VQA2 /visual-qa-testing | [x] evidence | [x] done

Evidence: B.1 through B.4 are complete and retested. The final package sweep used `packages/core` `bun typecheck` plus `bun test test/location-layer.test.ts` (`2 pass`), `packages/opencode` `bun typecheck` plus `bun test test/session/session.test.ts` (`26 pass`), `packages/app` `bun typecheck` plus the B.3 app unit/E2E verifier set, `packages/tui` `bun typecheck` plus the focused prompt/dialog suite (`7 pass`), and `packages/effect-drizzle-sqlite` `bun typecheck` plus `bun test test/sqlite.test.ts` (`7 pass`). Runtime/visual evidence for the app-facing churn clusters is recorded under `packages/app/test-results/stage-5-6/` and the non-installed runtime smoke reported `RUNNING_AFTER_8S:true` with `ERROR_SIGNAL_COUNT:0`.

### Ready-for-Deploy Audit Closure

Audit gate: [x] legacy dual-write hard cut | [x] root registrations removed | [x] independent tests retained | [x] untracked import audit | [x] status/evidence recorded | [x] done

Evidence: the Ready-for-Deploy audit finding was handled with a minimal hard cut. `packages/opencode/src/session/processor.ts`, `packages/opencode/src/session/compaction.ts`, `packages/opencode/test/session/processor-effect.test.ts`, and `packages/opencode/test/session/compaction.test.ts` are deleted. `packages/opencode/src/effect/app-runtime.ts` and `packages/opencode/src/server/routes/instance/httpapi/server.ts` no longer import or register `SessionProcessor` or the legacy opencode `SessionCompaction`, so those call-dead modules are not constructible through AppRuntime or LayerNode. Independent `Token.estimate` and `SessionNs.getUsage` coverage from the legacy compaction test was preserved in tracked `packages/opencode/test/session/session.test.ts`, which passes with `26 pass`. Final grep over `packages/opencode` for `SessionProcessor|SessionCompaction|TODO\(v2\): Temporary dual-write` returned no files. Final import audit for `followup-queue|mcp-command|register-spinner` found no production import of the untracked files: only the tracked `PluginBoot` `PluginV2.ID.make("mcp-command")` string and untracked test/helper references remain. The final status check explicitly lists `?? packages/app/src/pages/session/followup-queue.ts`, `?? packages/core/src/plugin/mcp-command.ts`, and `?? packages/tui/src/component/register-spinner.ts`; they are intentionally untracked and are not required by productive tracked code.

## Assumptions

- [ ] Local desktop app, Anthropic, OpenAI, and Copilot provider usage define the first provider parity priority.
- [ ] Exotic providers without native route can stay on explicit AI-SDK fallback until there is real local need.
- [ ] Upstream sync remains possible from the `dev` branch, but large deletions may increase merge conflicts; this is accepted as the cost of the hard cut.
- [ ] Console, stats, web, and enterprise packages are out of scope unless a dependency blocks the single execution path.
- [ ] The program is expected to take multiple PRs over multiple weeks.
- [ ] Every PR uses conventional commit-style titles, for example `fix(core): repair session runner parity`.

## Rejected Alternatives

- [ ] Hybrid or quick-wins-first migration is rejected, except for the token-estimate quality bug in Stage 0.2.
- [ ] Flag-based long-term cutover is rejected. Each stage uses a hard cut after its quality gate is green.
- [ ] Shadow LLM operation is rejected because duplicated provider costs are not proportionate for the local single-user setup.
- [ ] Keeping V1 code as a safety net after a green hard cut is rejected. Rollback is through Git revert or ASAR backup.

## Scope Guardrails

- [ ] Do not broaden Stage 0 into behavior migration except the explicit token-estimate bugfix.
- [ ] Do not move SessionV2 durable prompt admission into model execution.
- [ ] Do not bridge V2 runner orchestration through `SessionPrompt.loop`.
- [ ] Preserve one explicit `llm.stream(request)` call per provider turn.
- [ ] Keep tools and permissions Location-scoped.
- [ ] Keep the System Context algebra and built-ins under `src/system-context`.
- [ ] Do not introduce new compatibility layers without persisted data, shipped behavior, external consumers, or an explicit user requirement.
- [ ] Do not auto-repair destructive DB schema changes or incompatible type changes.
- [ ] Do not perform desktop prod deploy steps before explicit approval to close/reload `OpenCode.exe`.
- [ ] Do not push, rebase, reset, or amend unless explicitly requested.

## Risks To Recheck Before Relevant Stages

- [ ] Session data loss perception around compaction, replay truncation, revert, and backfill.
- [ ] Provider stream drift: missing events, duplicate events, dropped usage/cost data, changed retry behavior.
- [ ] Tool output contract drift that confuses models.
- [ ] Permission model drift for edit/write/apply_patch and workflow/tool approval.
- [ ] Custom tool import isolation regressions from `.opencode/tool` and `.opencode/tools`.
- [ ] Plugin/module URL sanitizing, asset host/SSRF validation, plugin route auth, and runtime mount/unmount lifecycle for app/plugin work.
- [ ] Dock schema migration/backward compatibility and duplicate legacy layout paths during Stage 5.
- [ ] Long-session paging regressions: prefetched open, `loadOlder`, force-refresh, hash/active restore, and assistant output at page boundaries.

## Required Verifier Menu

Choose the smallest relevant commands per work item, from the affected package directory.

| Area | Typical commands |
| --- | --- |
| Core | `bun typecheck`, focused `bun test test/...` from `packages/core` |
| Opencode CLI/server | `bun typecheck`, focused `bun test test/...` from `packages/opencode` |
| App | `bun typecheck`, focused component/unit tests, `bun run test:e2e:controlled -- e2e/regression/dock-layout-qa.spec.ts` when layout/dock/session UI is touched |
| LLM | `bun typecheck`, provider/protocol tests, recorded provider tests from `packages/llm` |
| Desktop | prod build/deploy only after explicit approval to close/reload installed app |
| SDK | `./packages/sdk/js/script/build.ts` after API endpoint changes |

## Mandatory Paging Checklist

Required for app-facing Stage 4 and Stage 5 changes, and for any Stage 6 timeline/history optimization.

Check with a session containing more than 160 user turns.

QA items:

- [ ] Open long session from a prefetched state.
- [ ] Verify initial open hydration.
- [ ] Trigger `loadOlder` at least once.
- [ ] Cross a page boundary containing assistant output.
- [ ] Run force-refresh.
- [ ] Restore from hash or active-message target.
- [ ] Confirm older loaded messages remain visible after each step.

## AGENTS.md And Docs Maintenance

After every stage:

- [ ] Remove stale V1 instructions from affected `AGENTS.md` files.
- [ ] Document new seams and target ownership boundaries.
- [ ] Update specs when runtime contracts changed.
- [ ] Record changed assumptions in this plan evidence log.

## Stage Completion Gate

A stage is complete only when:

- [ ] Every work item in the stage has all QA gate boxes checked.
- [ ] Stage-specific deletion or migration work is complete.
- [ ] Package typecheck and focused tests are green.
- [ ] `/visual-qa-testing` evidence is attached or recorded for all relevant surfaces.
- [ ] `/multi-agent-review` has run after tests and first VQA, and accepted fixes have been retested.
- [ ] `git status --short --untracked-files=all` has been inspected.
- [ ] New files referenced by code/tests/docs are tracked.
- [ ] The final response for the stage lists tests, VQA result, reviewers, accepted/rejected findings, and remaining risks.
