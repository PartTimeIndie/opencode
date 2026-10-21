# Benchmark Report: 20260624T052240Z_hard-a-surgical-selftest

## Summary

| Agent | Runs | Valid | Pass Rate | Median Time | Median Tokens | Median Cost | Median Tools | Median Changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bench-gpt-none-surgical | 2 | 2 | 1 | 42.03 | 3.67e+04 |  | 4 | 1 |

## Task Results

| Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| T011-url-canonicalizer | bench-gpt-none-surgical | yes | 50.59 | 1 | 44689 |  | pass |
| T012-csv-roundtrip | bench-gpt-none-surgical | yes | 33.48 | 1 | 28721 |  | pass |

## Baseline Comparison

| Agent | Baseline Pass | Candidate Pass | Baseline Time | Candidate Time | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| bench-gpt-low-base | 1 |  | 151.1 |  | no candidate data |
| bench-gpt-none-surgical |  | 1 |  | 42.03 | candidate only |
