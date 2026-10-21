# Benchmark Report: 20260624T004832Z_full-none-surgical

## Summary

| Agent | Runs | Valid | Pass Rate | Median Time | Median Tokens | Median Cost | Median Tools | Median Changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bench-gpt-none-surgical | 10 | 10 | 1 | 24.33 | 2.719e+04 |  | 3 | 1 |

## Task Results

| Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| T001-duration-parser | bench-gpt-none-surgical | yes | 21.81 | 1 | 27068 |  | pass |
| T002-range-merge | bench-gpt-none-surgical | yes | 18.93 | 1 | 27316 |  | pass |
| T003-config-loader | bench-gpt-none-surgical | yes | 27.22 | 1 | 27442 |  | pass |
| T004-retry-policy | bench-gpt-none-surgical | yes | 19.44 | 1 | 21245 |  | pass |
| T005-slugify | bench-gpt-none-surgical | yes | 33.4 | 1 | 27571 |  | pass |
| T006-large-log-noise | bench-gpt-none-surgical | yes | 32.93 | 1 | 33212 |  | pass |
| T007-multi-file-api-rename | bench-gpt-none-surgical | yes | 31.77 | 5 | 27876 |  | pass |
| T008-generated-guard | bench-gpt-none-surgical | yes | 20.57 | 1 | 20097 |  | pass |
| T009-ambiguous-files | bench-gpt-none-surgical | yes | 19.11 | 1 | 19539 |  | pass |
| T010-minimal-patch | bench-gpt-none-surgical | yes | 26.84 | 1 | 26944 |  | pass |

## Baseline Comparison

| Agent | Baseline Pass | Candidate Pass | Baseline Time | Candidate Time | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| bench-gpt-low-base | 1 |  | 53.63 |  | no candidate data |
| bench-gpt-none-surgical |  | 1 |  | 24.33 | candidate only |
