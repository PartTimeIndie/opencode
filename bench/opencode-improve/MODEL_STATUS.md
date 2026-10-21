# Model Status

Generated during the first validation and smoke run.

| Agent | Mode | Model | Variant | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| orchestrator-gpt-xhigh | primary | openai/gpt-5.5 | xhigh | configured | Runtime availability is validated by OpenCode CLI runs. |
| research-gpt-low | subagent | openai/gpt-5.5 | low | configured | Runtime availability is validated by OpenCode CLI runs. |
| review-gpt-low | subagent | openai/gpt-5.5 | low | configured | Runtime availability is validated by OpenCode CLI runs. |
| research-openrouter-free | subagent | openrouter/free |  | configured | Free router availability can vary. |
| research-opencode-deepseek-free | subagent | opencode/deepseek-v4-flash-free |  | configured | Free model slug may vary by account/build. |
| research-opencode-mimo-free | subagent | opencode/mimo-v2.5-free |  | configured | Free model slug may vary by account/build. |
| research-opencode-nemotron-free | subagent | opencode/nemotron-3-ultra-free |  | configured | Free model slug may vary by account/build. |
| research-opencode-north-free | subagent | opencode/north-mini-code-free |  | configured | Free model slug may vary by account/build. |
| bench-gpt-low-base | primary | openai/gpt-5.5 | low | configured | First smoke validates runtime. |
| bench-gpt-low-compact | primary | openai/gpt-5.5 | low | configured | First smoke validates runtime. |
| bench-gpt-none-fast | primary | openai/gpt-5.5 | none | working | Added during iteration; passed smoke 4/4 with 65.1% faster median wall time and 86.4% fewer median tokens vs smoke baseline. |
| bench-gpt-none-surgical | primary | openai/gpt-5.5 | none | working | Added during iteration; passed full suite 10/10 with source/test context candidate. |
| bench-openrouter-free | primary | openrouter/free |  | configured | Skipped in conservative first smoke unless explicitly selected. |
| bench-opencode-deepseek-free | primary | opencode/deepseek-v4-flash-free |  | configured | Skipped in conservative first smoke unless explicitly selected. |
| bench-opencode-mimo-free | primary | opencode/mimo-v2.5-free |  | configured | Skipped in conservative first smoke unless explicitly selected. |
| bench-opencode-nemotron-free | primary | opencode/nemotron-3-ultra-free |  | configured | Skipped in conservative first smoke unless explicitly selected. |
| bench-opencode-north-free | primary | opencode/north-mini-code-free |  | configured | Skipped in conservative first smoke unless explicitly selected. |

## CLI Validation

- `opencode` was not available on the PowerShell `PATH` in this environment.
- The local repo CLI works through `bun --conditions=browser packages/opencode/src/index.ts` and is used as the runner fallback.

## Runtime Validation

| Agent | Status | Evidence |
| --- | --- | --- |
| bench-gpt-low-base | working | `runs/20260623T234110Z_baseline2`: 4/4 smoke passed; `runs/20260624T002007Z_full-baseline`: 10/10 full suite passed. |
| bench-gpt-low-compact | working | `runs/20260623T234110Z_baseline2`: 4/4 smoke passed. |
| bench-gpt-none-fast | working | `runs/20260624T001746Z_candidate-none-fast`: 4/4 smoke passed. |
| bench-gpt-none-surgical | working | `runs/20260624T005831Z_full-surgical-source-tests`: 10/10 full suite passed. |
| bench-openrouter-free | failed_model | `runs/20260624T004618Z_smoke-openrouter-free`: 0 valid runs; OpenCode reported `ProviderModelNotFoundError` for `openrouter/free` and suggested `qwen/qwen3-coder:free` / `openai/gpt-oss-20b:free`. |
| opencode/* free agents | not run | Configured but skipped after `openrouter/free` failed and GPT-5.5 candidates reached the token/speed targets. |
