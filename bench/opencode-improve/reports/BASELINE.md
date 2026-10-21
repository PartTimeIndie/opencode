# Benchmark Report: 20260623T234110Z_baseline2

## Summary

| Agent | Runs | Valid | Pass Rate | Median Time | Median Tokens | Median Cost | Median Tools | Median Changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bench-gpt-low-base | 4 | 4 | 1 | 72.96 | 2.046e+05 |  | 12 | 2 |
| bench-gpt-low-compact | 4 | 4 | 1 | 67.47 | 1.929e+05 |  | 10.5 | 2 |

## Task Results

| Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| T001-duration-parser | bench-gpt-low-base | yes | 79.52 | 2 | 227565 |  | pass |
| T001-duration-parser | bench-gpt-low-compact | yes | 71.11 | 2 | 226940 |  | pass |
| T002-range-merge | bench-gpt-low-base | yes | 40.74 | 2 | 133658 |  | pass |
| T002-range-merge | bench-gpt-low-compact | yes | 36.99 | 2 | 133739 |  | pass |
| T006-large-log-noise | bench-gpt-low-base | yes | 75.68 | 2 | 310695 |  | pass |
| T006-large-log-noise | bench-gpt-low-compact | yes | 69.8 | 2 | 274002 |  | pass |
| T008-generated-guard | bench-gpt-low-base | yes | 70.25 | 2 | 181682 |  | pass |
| T008-generated-guard | bench-gpt-low-compact | yes | 65.14 | 2 | 158763 |  | pass |
