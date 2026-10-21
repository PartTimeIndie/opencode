# Benchmark Report: 20260624T002007Z_full-baseline

## Summary

| Agent | Runs | Valid | Pass Rate | Median Time | Median Tokens | Median Cost | Median Tools | Median Changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bench-gpt-low-base | 10 | 10 | 1 | 53.63 | 1.662e+05 |  | 9.5 | 2 |

## Task Results

| Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| T001-duration-parser | bench-gpt-low-base | yes | 62.76 | 2 | 202602 |  | pass |
| T002-range-merge | bench-gpt-low-base | yes | 40.88 | 2 | 133627 |  | pass |
| T003-config-loader | bench-gpt-low-base | yes | 61.47 | 2 | 180682 |  | pass |
| T004-retry-policy | bench-gpt-low-base | yes | 45.23 | 2 | 134319 |  | pass |
| T005-slugify | bench-gpt-low-base | yes | 52.98 | 2 | 156609 |  | pass |
| T006-large-log-noise | bench-gpt-low-base | yes | 44.91 | 2 | 166687 |  | pass |
| T007-multi-file-api-rename | bench-gpt-low-base | yes | 70.31 | 6 | 165807 |  | pass |
| T008-generated-guard | bench-gpt-low-base | yes | 53.08 | 2 | 135260 |  | pass |
| T009-ambiguous-files | bench-gpt-low-base | yes | 70.27 | 2 | 224986 |  | pass |
| T010-minimal-patch | bench-gpt-low-base | yes | 54.17 | 2 | 178281 |  | pass |
