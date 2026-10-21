# Benchmark Report: 20260624T045044Z_stabilize-batch3

## Summary

| Agent | Runs | Valid | Pass Rate | Median Time | Median Tokens | Median Cost | Median Tools | Median Changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bench-gpt-none-surgical | 4 | 4 | 1 | 30.46 | 1.706e+04 |  | 1.5 | 1 |

## Task Results

| Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| T007-multi-file-api-rename | bench-gpt-none-surgical | yes | 52.92 | 5 | 21964 |  | pass |
| T008-generated-guard | bench-gpt-none-surgical | yes | 32.68 | 1 | 20667 |  | pass |
| T009-ambiguous-files | bench-gpt-none-surgical | yes | 26.53 | 1 | 13460 |  | pass |
| T010-minimal-patch | bench-gpt-none-surgical | yes | 28.24 | 1 | 13378 |  | pass |

## Baseline Comparison

| Agent | Baseline Pass | Candidate Pass | Baseline Time | Candidate Time | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| bench-gpt-low-base | 1 |  | 53.63 |  | no candidate data |
| bench-gpt-none-surgical |  | 1 |  | 30.46 | candidate only |
