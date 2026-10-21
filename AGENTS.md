# OpenCode project instructions

Complete the authorized change, relevant verification and final report. Read linked domain guidance when that domain is affected; a small documentation edit does not require deployment or a tour of the repository. Preserve explicit release and process-restart permissions.

- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- The active working branch is `fork-sync`, tracking the user's `origin/main` on the cleaned history. Use `origin/main` for review diffs on this branch.
- Local `main` may not exist. `dev` preserves the pre-migration history with unrelated roots; do not merge or push that old history into the cleaned fork.

## Fork and sync target

This repository is the user's independent fork. Do not fetch, pull, merge, rebase, push or sync with the official `anomalyco/opencode` repository unless the user explicitly changes this policy. A remote named `origin` is not proof that it belongs to the user.

The user's repository is `https://github.com/PartTimeIndie/opencode.git`; `origin` must use it for both fetch and push. Its verified remote default branch is `main`. `C:/GitRepros/opencode` now works directly on `fork-sync`, tracking `origin/main`; `dev` retains the old, unrelated history. Never merge that old history into the cleaned fork.

Before configuring or running sync, verify the remote's fetch/push URLs and branch tracking against this repository; do not substitute the official repository or publish anything without authorization.

The in-place switch preserved uncommitted, untracked and ignored local files. Local captures and private scratch files remain on disk but are excluded from publication by `.gitignore` and `script/fork-transfer-policy.ts`. The extra `C:/GitRepros/opencode-fork-sync` worktree is retained detached as a fallback, not as the active working folder. Re-run future tree transfers only into a clean separate worktree with `bun script/fork-transfer.ts` and the contracts in `packages/opencode/test/git/`. Before changing a live worktree, make a verified external backup and check that concurrent edits have not changed it.

Before preparing a public snapshot, read [fork publication boundaries](.agents/instructions/fork-publication.md). Personal applications, Daily Review adapters/state, installed user skills/tools and one-off repair scripts stay local, not in Git. Keep portable product plugins and their tests; an unrelated project's plugin is not portable. Run `bun script/fork-publication-audit.ts` on the index and `bun script/fork-publication-audit.ts --ref <commit> --history` on the exact proposed publication history. A clean tip does not clean earlier commits. Do not push local development ancestry containing excluded paths, rewrite existing history, or delete the old GitHub repository as an implicit cleanup step.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Before treating a change as ready for commit or review, run `git status --short --untracked-files=all` and ensure every newly referenced source file, helper script, test, or asset is tracked. A clean checkout must not depend on untracked files.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Code style

Before source, schema or plugin edits, read [code and plugin style](.agents/instructions/code-and-plugin-style.md), including import rules, lazy loading, icon ownership and migration repair/tests. Read current targets and diffs before patching.

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

## Long-Session Message Paging

Message paging and long-session UI changes: read [Long-Session Message Paging](.agents/instructions/long-session-message-paging.md).

## V2 Session Core

Session admission, execution, history or context changes: read [V2 Session Core](.agents/instructions/v2-session-core.md).

## Interaction and runtime contracts

Before questions, model delegation, Visual QA, config/tool/provider/session/storage changes, commits, desktop preparation or deployment, read [interaction and runtime contracts](.agents/instructions/interaction-and-runtime.md). Use native popup questions with free text; runtime conflicts are not UI absence. Never stop/restart OpenCode.exe without current explicit approval. Installed readiness requires the full verified prod deploy; source edits alone are not deployed. No automatic push/rebase/reset.

## Native file operations

Before changing native file tools, knowledge receipts, file synchronization or crash recovery, read [native file operations and recovery](.agents/instructions/native-file-operations.md). Native conflicts must never be bypassed through shell, generators or plugins. Source verification is not installed enforcement.

## Subagent and Reviewer Loop Guard

Supervising agent/reviewer runs: read [Subagent and Reviewer Loop Guard](.agents/instructions/subagent-and-reviewer-loop-guard.md).

## Performance Diagnosis (OpenCode Slowness)

Diagnosing measured slowness or resource pressure: read [Performance Diagnosis (OpenCode Slowness)](.agents/instructions/performance-diagnosis-opencode-slowness.md).

## Windows PowerShell Diagnostic Safety

Writing Windows diagnostics: read [Windows PowerShell Diagnostic Safety](.agents/instructions/windows-powershell-diagnostic-safety.md).
