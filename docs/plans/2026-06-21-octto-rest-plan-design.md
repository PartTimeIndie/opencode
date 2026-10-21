## Problem

After deploying the first Octto inline-chat fix, finish the remaining Octto work instead of stopping at the smoke-fix stage. The remaining work includes installed desktop verification, renderer coverage, answer submission hardening, automated regression coverage, stale artifact cleanup, and deciding whether the hot-reload follow-up is complete or still needs implementation.

## Findings

### remaining_octto_plan

The user wants the assistant to do all remaining work and only stop when the workflow is actually finished.

The first rest-plan Octto run intentionally used one branch to avoid multiple simultaneous questions, but its initial `rank` question exposed an existing renderer/probe shape gap (`ranked.ranking is not iterable`). This confirms that `rank` belongs in the renderer-coverage/fix scope and should not be used for smoke planning until fixed.

## Recommendation

Complete the remaining Octto work in this order:

1. Fix renderer coverage gaps, including `rank`, `rate`, `show_diff`, `ask_code`, `ask_file`, `ask_image`, and `emoji_react` where practical.
2. Harden `POST /answer` with per-question answer tokens, stricter CORS/origin behavior, and clearer submit error responses.
3. Add repeatable renderer/server regression checks for answer state, scroll preservation, payload shape, duplicate submit prevention, and unsupported-type fallback behavior.
4. Clean stale Octto package artifacts only when safe and without breaking the active local plugin path.
5. Re-run typechecks/tests and Visual QA.
6. If repo source changed, perform the full prod desktop deploy flow before saying the installed app is ready to test.

## Implementation status

Completed after the first deployed inline-chat fix:

- Fixed the `rank` inline bug by rendering rank controls directly and submitting Octto's expected shape: `{ ranking: Array<{ id, rank }> }`.
- Completed inline renderer coverage for `rank`, `rate`, `show_diff`, `ask_code`, `ask_file`, `ask_image`, `emoji_react`, and `show_options`, while preserving existing `pick_one`, `pick_many`, `confirm`, `thumbs`, `ask_text`, `slider`, `show_plan`, and `review_section` support.
- Hardened `POST /answer` in Octto source and rebuilt `dist/index.js`:
  - per-question `answerToken`
  - custom parts include `answerToken`
  - `/answer` requires `{ question_id, answer_token, answer }`
  - invalid tokens return 401
  - duplicate submissions return `not_pending`
  - CORS/origin limited to no-origin local calls, `oc://renderer`, `null`, localhost, 127.0.0.1, and ::1
- Updated the Octto chat-part schema so `answerToken` survives custom-part sanitization.
- Added persistent QA scripts:
  - `C:\Users\crisc\.config\opencode\plugins\octto-app\qa\renderer-visual-qa.mjs`
  - `C:\Users\crisc\.config\opencode\plugins\octto\qa\endpoint-qa.ts`
- Removed stale `C:\Users\crisc\.config\opencode\node_modules\octto` after confirming package/lock files no longer reference it.

Validation completed before final deploy:

- `node --check index.js` in `plugins/octto-app`: passed.
- dynamic app-plugin import for `plugins/octto-app`: passed.
- `bun run typecheck` in `plugins/octto`: passed.
- `bun run build` in `plugins/octto`: passed and regenerated `dist/index.js`.
- `bun qa/endpoint-qa.ts` in `plugins/octto`: passed.
- `node plugins/octto-app/qa/renderer-visual-qa.mjs`: passed for desktop and mobile; screenshots at `C:\Users\crisc\AppData\Local\Temp\opencode\octto-visual-qa\desktop.png` and `mobile.png`.
