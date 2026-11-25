# Composer reference toggle verification

## Scope

Approved reduced T1–T5: declarative command/skill toggles, admission-based
consumption, Codex Image source/runtime migration, and read-only diagnostics.
No change to leading-slash recognition, manual-only authorization, command
parsing, prompt/admission/message authority fields, skill installation or the
existing Progressive Plan Builder, Multi-Agent Review and Visual QA plugins.
No commit, publish, desktop deployment, ASAR patch or installed-app restart.

## Final checks

Commands were run from the listed package directories, not the repository root.

| Directory | Command | Result |
| --- | --- | --- |
| `packages/app` | `bun test --preload ./happydom.ts src/plugin/append-on-submit.test.ts src/plugin/composer-registry.test.ts src/plugin/composer-plugins.test.ts src/plugin/skill-references.test.ts src/plugin/toolbar.test.ts src/components/prompt-input/submit.test.ts` | 144 passed, 0 failed |
| `packages/app` | `bun run test:e2e:controlled -- e2e/regression/toolbar-append-on-submit.spec.ts` | 4 Chromium tests passed |
| `packages/server` | `bun test ./test/skill-diagnostics.test.ts` | 2 passed |
| `packages/core` | `bun test ./test/skill.test.ts ./test/tool-skill.test.ts` | 9 passed; protected source unchanged |
| `packages/opencode` | `bun test --timeout 30000 ./test/server/httpapi-v2-location.test.ts` | 2 passed through real HTTP handlers |
| `packages/opencode` | `bun test ./test/plugin-app-assets-capabilities.test.ts` | 4 passed |
| Global Codex Image source | `bun test ./index.test.js` | 5 passed |
| `packages/app`, `packages/plugin`, `packages/server`, `packages/sdk/js`, `packages/opencode` | `bun typecheck` in each package | Passed |
| Repository | `git diff --check` | Passed |

Browser checks cover the actual host runtime, accessible toggle state, shared
palette/toolbar state, image attachment preservation, manual prompt submission,
no command request/dialog on click, custom override, missing composer capability,
hiding/re-enabling, and reload. Submission tests separately cover rejected/late
admission, deliberate local Queue, Resume/programmatic exclusion, and duplicate
submit prevention while a one-shot receipt awaits admission. Policy diagnostics
call the unchanged `SkillV2.missingTools` evaluator and expose no skill content.

The HTTP test initially exceeded Bun's default 5-second test timeout during cold
instance bootstrap (measured about 7.9 seconds). With the command's explicit
30-second timeout, both unchanged assertion sets passed. No assertion was removed.

## Verification limits

- `bun run typecheck:e2e` reports eight errors in the unchanged
  `e2e/regression/known-file-tools-real-server.spec.ts` (lines 54–119).
  No errors were reported in the new browser test. This unrelated file was not
  modified to make the global E2E typecheck green.
- The official `packages/sdk/js/script/build.ts` generated the diagnostic SDK
  contract but failed at its formatting phase on three attempts with a
  systematic Windows `UNKNOWN: unknown error, open ...` from `prettier.exe`
  for files under `src/v2/gen` (single files on the first two runs, the whole
  `src/v2/gen` tree on the third). This is an environment-level generator
  failure, not flaky output. Restoring the verified state by formatting the
  generated directory with the installed Prettier succeeded each time; SDK
  typecheck passed afterwards, and the final diff contains only the diagnostic
  operation/types (`sdk.gen.ts` +35, `types.gen.ts` +42). The script's
  package-build tail (dist artifacts) was **not** completed; workspace
  consumers use `src` exports, which are typechecked. The generator's
  temporary `openapi.json` was removed after each failed run.
- These are source/browser-fixture results, not installed-desktop acceptance.
  Full deployment and stop/restart remain separately authorized operations.

## Durable source and runtime

Only Codex Image's relevant global runtime copies were synchronized after
checking their expected hashes. SHA-256 equality was verified for `index.js`,
`package.json`, `index.test.js` and `AGENTS.md`. Icon assets and unrelated plugins
were not changed. The new host API is not installed by that synchronization.
