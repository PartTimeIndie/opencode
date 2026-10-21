# Benchmark Report: 20260624T044834Z_stabilize-batch2

## Summary

| Agent | Runs | Valid | Pass Rate | Median Time | Median Tokens | Median Cost | Median Tools | Median Changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bench-gpt-none-surgical | 3 | 3 | 1 | 25.09 | 24081 |  | 2 | 1 |

## Task Results

| Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| T004-retry-policy | bench-gpt-none-surgical | yes | 29.44 | 1 | 30297 |  | pass |
| T005-slugify | bench-gpt-none-surgical | yes | 25.09 | 1 | 21288 |  | pass |
| T006-large-log-noise | bench-gpt-none-surgical | yes | 21.54 | 1 | 24081 |  | pass |

## Baseline Comparison

| Agent | Baseline Pass | Candidate Pass | Baseline Time | Candidate Time | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| bench-gpt-low-base | 1 |  | 53.63 |  | no candidate data |
| bench-gpt-none-surgical |  | 1 |  | 25.09 | candidate only |
