# Benchmark Report: 20260624T053005Z_hard-b-surgical-selftest

## Summary

| Agent | Runs | Valid | Pass Rate | Median Time | Median Tokens | Median Cost | Median Tools | Median Changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bench-gpt-none-surgical | 3 | 3 | 1 | 42.55 | 35212 |  | 4 | 1 |

## Task Results

| Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| T013-safe-path-join | bench-gpt-none-surgical | yes | 38.62 | 1 | 35171 |  | pass |
| T014-email-mime-summary | bench-gpt-none-surgical | yes | 87.13 | 1 | 37164 |  | pass |
| T015-json-money-loader | bench-gpt-none-surgical | yes | 42.55 | 1 | 35212 |  | pass |

## Baseline Comparison

| Agent | Baseline Pass | Candidate Pass | Baseline Time | Candidate Time | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| bench-gpt-low-base | 1 |  | 92.29 |  | no candidate data |
| bench-gpt-none-surgical |  | 1 |  | 42.55 | candidate only |
