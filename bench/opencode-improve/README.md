# OpenCode Improvement Benchmark

This directory contains a benchmark-driven improvement loop for OpenCode. It is intentionally isolated from core source changes: seed tasks live in `tasks/`, temporary workspaces are created under `tmp/`, raw run artifacts are saved under `runs/`, and reports are written under `reports/`.

## Workflow

1. Validate repo, CLI, and configured benchmark agents.
2. Create a fresh task workspace from each task's `repo_template/` via `setup.sh`.
3. Run `opencode run --agent <agent> --format json <prompt>` in that workspace.
4. Verify the outcome with the task's deterministic `verify.sh`.
5. Store raw events, logs, diffs, and `metrics.json`.
6. Analyze baseline and candidate runs before accepting any OpenCode-core change.

## First Smoke Run

```sh
python bench/opencode-improve/run_bench.py --suite smoke --agents bench-gpt-low-base,bench-gpt-low-compact --repetitions 1 --label baseline
python bench/opencode-improve/analyze_runs.py --run latest --report bench/opencode-improve/reports/BASELINE.md
```

Candidate smoke uses the same suite and agents:

```sh
python bench/opencode-improve/run_bench.py --suite smoke --agents bench-gpt-low-base,bench-gpt-low-compact --repetitions 1 --label candidate --disable-external-skills --pure
python bench/opencode-improve/analyze_runs.py --run latest --baseline previous --report bench/opencode-improve/reports/CANDIDATE.md
```

`--disable-external-skills` is a benchmark isolation candidate. It keeps the project `.opencode/opencode.jsonc` agents but prevents unrelated global/external skill inventories from inflating benchmark prompt context. `--pure` also skips external plugins during benchmark runs.

`--include-verify-context` is a second candidate mode. The runner executes the deterministic verifier once before the agent, compresses the failing output with `log_compress.py`, and appends the diagnostic excerpt to the prompt. This tests whether targeted failure context reduces tool exploration without hardcoding task solutions.

`--defer-verification-to-harness` pairs with verify context. It tells the agent not to spend model turns running tests unless needed because the benchmark harness performs the authoritative post-run verification.

## Full Suite

```sh
python bench/opencode-improve/run_bench.py --suite all --repetitions 3
```

## Safety Boundaries

The runner only creates and removes directories under `bench/opencode-improve/tmp/`. It uses non-interactive OpenCode permission approval because benchmark agents must edit the throwaway task repositories; do not point the runner at non-benchmark workspaces.

On POSIX, or on Windows with Git-Bash available, task `setup.sh` and `verify.sh` are executed directly. If only WSL `bash.exe` is present and it cannot see this Windows workspace, the runner uses an equivalent Python fallback for setup and verify while keeping the `.sh` files as the portable task contract.

OpenCode project config is loaded at process startup. Restart OpenCode after changing `.opencode/opencode.jsonc` before selecting the new agents interactively.
