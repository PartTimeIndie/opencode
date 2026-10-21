# Benchmark Report: 20260624T044557Z_stabilize-batch1

## Summary

| Agent | Runs | Valid | Pass Rate | Median Time | Median Tokens | Median Cost | Median Tools | Median Changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bench-gpt-none-surgical | 3 | 3 | 1 | 32.33 | 21390 |  | 2 | 1 |

## Task Results

| Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| T001-duration-parser | bench-gpt-none-surgical | yes | 37.68 | 1 | 21046 |  | pass |
| T002-range-merge | bench-gpt-none-surgical | yes | 23.75 | 1 | 27905 |  | pass |
| T003-config-loader | bench-gpt-none-surgical | yes | 32.33 | 1 | 21390 |  | pass |

## Baseline Comparison

| Agent | Baseline Pass | Candidate Pass | Baseline Time | Candidate Time | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| bench-gpt-low-base | 1 |  | 53.63 |  | no candidate data |
| bench-gpt-none-surgical |  | 1 |  | 32.33 | candidate only |
