# Benchmark Report: 20260625T184230Z_deepseek-postfix-safe

## Summary

| Case | Profile | Agent | Runs | Valid | Raw Pass | Valid Pass | Median Time | Median Tokens | Request Assembly | Tool Schema | Compactions | Median Tools | Median Changed |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| single | safe | bench-opencode-deepseek-free | 2 | 2 | 1 | 1 | 45.55 | 5.528e+04 | 25 | 2.539e+04 | 0 | 6.5 | 1 |

## Task Results

| Case | Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| single | T001-duration-parser | bench-opencode-deepseek-free | yes | 32.33 | 1 | 53234 |  | pass |
| single | T006-large-log-noise | bench-opencode-deepseek-free | yes | 58.78 | 1 | 57326 |  | pass |
