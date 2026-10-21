# Benchmark Report: 20260624T004618Z_smoke-openrouter-free

## Summary

| Agent | Runs | Valid | Pass Rate | Median Time | Median Tokens | Median Cost | Median Tools | Median Changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bench-openrouter-free | 4 | 0 |  |  |  |  |  |  |

## Task Results

| Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| T001-duration-parser | bench-openrouter-free | no | 4.592 | 0 |  |  | failed_model |
| T002-range-merge | bench-openrouter-free | no | 4.09 | 0 |  |  | failed_model |
| T006-large-log-noise | bench-openrouter-free | no | 4.215 | 0 |  |  | failed_model |
| T008-generated-guard | bench-openrouter-free | no | 4.332 | 0 |  |  | failed_model |

## Baseline Comparison

| Agent | Baseline Pass | Candidate Pass | Baseline Time | Candidate Time | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| bench-gpt-low-base | 1 |  | 72.96 |  | no candidate data |
| bench-gpt-low-compact | 1 |  | 67.47 |  | no candidate data |
| bench-openrouter-free |  |  |  |  | no candidate data |
