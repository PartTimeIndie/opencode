# Benchmark Report: 20260624T005831Z_full-surgical-source-tests

## Summary

| Agent | Runs | Valid | Pass Rate | Median Time | Median Tokens | Median Cost | Median Tools | Median Changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bench-gpt-none-surgical | 10 | 10 | 1 | 12.4 | 1.379e+04 |  | 1 | 1 |

## Task Results

| Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| T001-duration-parser | bench-gpt-none-surgical | yes | 13.98 | 1 | 13722 |  | pass |
| T002-range-merge | bench-gpt-none-surgical | yes | 10.26 | 1 | 13558 |  | pass |
| T003-config-loader | bench-gpt-none-surgical | yes | 38.34 | 1 | 13956 |  | pass |
| T004-retry-policy | bench-gpt-none-surgical | yes | 12.26 | 1 | 14687 |  | pass |
| T005-slugify | bench-gpt-none-surgical | yes | 12.54 | 1 | 13864 |  | pass |
| T006-large-log-noise | bench-gpt-none-surgical | yes | 22.52 | 1 | 24060 |  | pass |
| T007-multi-file-api-rename | bench-gpt-none-surgical | yes | 23.53 | 5 | 21872 |  | pass |
| T008-generated-guard | bench-gpt-none-surgical | yes | 11.61 | 1 | 13507 |  | pass |
| T009-ambiguous-files | bench-gpt-none-surgical | yes | 10.72 | 1 | 13442 |  | pass |
| T010-minimal-patch | bench-gpt-none-surgical | yes | 11.42 | 1 | 13363 |  | pass |

## Baseline Comparison

| Agent | Baseline Pass | Candidate Pass | Baseline Time | Candidate Time | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| bench-gpt-low-base | 1 |  | 53.63 |  | no candidate data |
| bench-gpt-none-surgical |  | 1 |  | 12.4 | candidate only |
