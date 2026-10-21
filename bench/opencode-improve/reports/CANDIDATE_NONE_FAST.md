# Benchmark Report: 20260624T001746Z_candidate-none-fast

## Summary

| Agent | Runs | Valid | Pass Rate | Median Time | Median Tokens | Median Cost | Median Tools | Median Changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bench-gpt-none-fast | 4 | 4 | 1 | 24.41 | 2.776e+04 |  | 3.5 | 1 |

## Task Results

| Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| T001-duration-parser | bench-gpt-none-fast | yes | 23.12 | 1 | 27288 |  | pass |
| T002-range-merge | bench-gpt-none-fast | yes | 17.95 | 1 | 27199 |  | pass |
| T006-large-log-noise | bench-gpt-none-fast | yes | 25.7 | 1 | 32234 |  | pass |
| T008-generated-guard | bench-gpt-none-fast | yes | 28.27 | 1 | 28229 |  | pass |

## Baseline Comparison

| Agent | Baseline Pass | Candidate Pass | Baseline Time | Candidate Time | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| bench-gpt-low-base | 1 |  | 72.96 |  | no candidate data |
| bench-gpt-low-compact | 1 |  | 67.47 |  | no candidate data |
| bench-gpt-none-fast |  | 1 |  | 24.41 | candidate only |
