# Benchmark Report: 20260624T004039Z_full-none-fast2

## Summary

| Agent | Runs | Valid | Pass Rate | Median Time | Median Tokens | Median Cost | Median Tools | Median Changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bench-gpt-none-fast | 10 | 10 | 1 | 27.23 | 2.833e+04 |  | 4 | 1 |

## Task Results

| Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| T001-duration-parser | bench-gpt-none-fast | yes | 30.54 | 1 | 28205 |  | pass |
| T002-range-merge | bench-gpt-none-fast | yes | 22.96 | 1 | 27691 |  | pass |
| T003-config-loader | bench-gpt-none-fast | yes | 44.65 | 1 | 45061 |  | pass |
| T004-retry-policy | bench-gpt-none-fast | yes | 30.78 | 1 | 38452 |  | pass |
| T005-slugify | bench-gpt-none-fast | yes | 20.79 | 1 | 28100 |  | pass |
| T006-large-log-noise | bench-gpt-none-fast | yes | 23.92 | 1 | 32762 |  | pass |
| T007-multi-file-api-rename | bench-gpt-none-fast | yes | 42.89 | 5 | 31301 |  | pass |
| T008-generated-guard | bench-gpt-none-fast | yes | 33.34 | 1 | 28448 |  | pass |
| T009-ambiguous-files | bench-gpt-none-fast | yes | 23.38 | 1 | 20340 |  | pass |
| T010-minimal-patch | bench-gpt-none-fast | yes | 22.8 | 1 | 26860 |  | pass |

## Baseline Comparison

| Agent | Baseline Pass | Candidate Pass | Baseline Time | Candidate Time | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| bench-gpt-low-base | 1 |  | 53.63 |  | no candidate data |
| bench-gpt-none-fast |  | 1 |  | 27.23 | candidate only |
