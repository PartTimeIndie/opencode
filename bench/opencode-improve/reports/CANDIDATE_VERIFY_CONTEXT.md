# Benchmark Report: 20260624T000257Z_candidate-verify-context

## Summary

| Agent | Runs | Valid | Pass Rate | Median Time | Median Tokens | Median Cost | Median Tools | Median Changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bench-gpt-low-base | 4 | 4 | 1 | 39.63 | 5.186e+04 |  | 7 | 1 |
| bench-gpt-low-compact | 4 | 4 | 1 | 44.66 | 6.179e+04 |  | 7.5 | 1 |

## Task Results

| Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| T001-duration-parser | bench-gpt-low-base | yes | 40.93 | 1 | 44378 |  | pass |
| T001-duration-parser | bench-gpt-low-compact | yes | 38.17 | 1 | 44364 |  | pass |
| T002-range-merge | bench-gpt-low-base | yes | 35.32 | 1 | 42402 |  | pass |
| T002-range-merge | bench-gpt-low-compact | yes | 56.81 | 1 | 66513 |  | pass |
| T006-large-log-noise | bench-gpt-low-base | yes | 38.33 | 1 | 62834 |  | pass |
| T006-large-log-noise | bench-gpt-low-compact | yes | 35.51 | 1 | 62914 |  | pass |
| T008-generated-guard | bench-gpt-low-base | yes | 74.09 | 1 | 59346 |  | pass |
| T008-generated-guard | bench-gpt-low-compact | yes | 51.16 | 1 | 60673 |  | pass |

## Baseline Comparison

| Agent | Baseline Pass | Candidate Pass | Baseline Time | Candidate Time | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| bench-gpt-low-base | 1 | 1 | 72.96 | 39.63 | pareto: same pass, faster |
| bench-gpt-low-compact | 1 | 1 | 67.47 | 44.66 | pareto: same pass, faster |
