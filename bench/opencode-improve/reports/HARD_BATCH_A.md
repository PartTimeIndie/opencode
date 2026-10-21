# Benchmark Report: 20260624T052033Z_hard-a-surgical

## Summary

| Agent | Runs | Valid | Pass Rate | Median Time | Median Tokens | Median Cost | Median Tools | Median Changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bench-gpt-none-surgical | 2 | 2 | 0.5 | 31.68 | 2.174e+04 |  | 2 | 1 |

## Task Results

| Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| T011-url-canonicalizer | bench-gpt-none-surgical | no | 21.63 | 1 | 14005 |  | verify_failed |
| T012-csv-roundtrip | bench-gpt-none-surgical | yes | 41.73 | 1 | 29469 |  | pass |

## Baseline Comparison

| Agent | Baseline Pass | Candidate Pass | Baseline Time | Candidate Time | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| bench-gpt-low-base | 1 |  | 151.1 |  | no candidate data |
| bench-gpt-none-surgical |  | 0.5 |  | 31.68 | candidate only |
