# Hard Suite Summary

## Why This Exists

The first 10-task suite was too easy for quality measurement: baseline reached 100% pass rate. To catch overfitting, the hard suite adds hidden verifier checks outside the agent workspace context.

Research inputs used:

- SWE-bench patterns: hidden fail-to-pass checks, pass-to-pass regressions, human-filtered fairness, and resolved/pass-rate reporting.
- Aider leaderboard patterns: pass rate, tokens, cost, seconds per case, malformed/error output, and multiple-pass reporting.
- Subagent recommendations: split visible tests from hidden invariants, include misleading-but-fair visible failures, add regression checks, and measure visible-pass/hidden-fail as first-class signal.

## Hard Tasks Added

| Task | Focus | Hidden Checks |
| --- | --- | --- |
| T011-url-canonicalizer | stdlib URL joining and query encoding | absolute target rejection, repeated query keys, leading slash preserving base path, percent escape preservation |
| T012-csv-roundtrip | CSV import/export | quotes, CRLF, Unicode, empty fields, leading zeros, stdlib `DictReader` compatibility |
| T013-safe-path-join | sandbox path resolving | traversal, absolute paths, Windows drive paths, UNC-style paths, mixed separators, prefix tricks |
| T014-email-mime-summary | RFC822/MIME parsing | encoded headers, multipart preference, bytes input, attachment ignoring |
| T015-json-money-loader | JSON money config | `Decimal` precision, duplicate key rejection, non-finite number rejection, env override |

## Overfitting Caught

The too-aggressive candidate mode (`--defer-verification-to-harness`) failed hard batch A:

| Run | Pass Rate | Median Time | Median Tokens | Median Tool Calls |
| --- | ---: | ---: | ---: | ---: |
| Hard A baseline `20260624T051517Z_hard-a-baseline` | 100% | 151.09s | 286,874 | 13.0 |
| Hard A surgical defer `20260624T052033Z_hard-a-surgical` | 50% | 31.68s | 21,737 | 2.0 |

Failure: T011 produced a runtime regression (`urlencode(dict_items)`), proving that skipping self-verification can lose quality on harder tasks.

## Better Candidate

Best hard-suite mode so far:

```sh
python bench/opencode-improve/run_bench.py --suite hard --agents bench-gpt-none-surgical --repetitions 1 --label hard-surgical-selftest --timeout 240 --disable-external-skills --pure --include-source-context --include-verify-context
```

This keeps source/test/verify context but does not pass `--defer-verification-to-harness`, so the agent is instructed to run the verifier once after editing.

## Aggregate Hard Results

Baseline runs:

- `20260624T051517Z_hard-a-baseline`
- `20260624T052439Z_hard-b-baseline`

Candidate runs:

- `20260624T052240Z_hard-a-surgical-selftest`
- `20260624T053005Z_hard-b-surgical-selftest`

| Metric | Baseline | Candidate | Change |
| --- | ---: | ---: | ---: |
| Pass rate | 100% | 100% | preserved |
| Median wall time | 116.55s | 42.55s | 63.5% faster |
| Median tokens | 230,475 | 35,212 | 84.7% lower |
| Median tool calls | 11.0 | 4.0 | 63.6% lower |
| Median changed files | 1.0 | 1.0 | unchanged |

## Current Decision

Accept the hybrid candidate for benchmark mode, not as a core default. It meets the 60% token, speed, and process-quality targets on the hard suite while preserving pass rate.

Do not promote the previous no-self-test mode. It is faster, but hidden tests showed it can regress quality.
