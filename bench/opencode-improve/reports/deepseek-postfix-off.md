# Benchmark Report: 20260625T184102Z_deepseek-postfix-off

## Summary

| Case | Profile | Agent | Runs | Valid | Raw Pass | Valid Pass | Median Time | Median Tokens | Request Assembly | Tool Schema | Compactions | Median Tools | Median Changed |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| single | off | bench-opencode-deepseek-free | 2 | 2 | 1 | 1 | 39.98 | 6.229e+04 |  |  | 0 | 7 | 1 |

## Task Results

| Case | Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| single | T001-duration-parser | bench-opencode-deepseek-free | yes | 44.58 | 1 | 56421 |  | pass |
| single | T006-large-log-noise | bench-opencode-deepseek-free | yes | 35.38 | 1 | 68166 |  | pass |
