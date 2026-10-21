# Stabilization Summary

This report aggregates the visible batch rerun after the initial best candidate result.

## Runs

| Batch | Tasks | Run |
| --- | --- | --- |
| Batch 1 | T001, T002, T003 | `20260624T044557Z_stabilize-batch1` |
| Batch 2 | T004, T005, T006 | `20260624T044834Z_stabilize-batch2` |
| Batch 3 | T007, T008, T009, T010 | `20260624T045044Z_stabilize-batch3` |

## Aggregate Metrics

Baseline: `20260624T002007Z_full-baseline` with `bench-gpt-low-base`.

Candidate: batched `bench-gpt-none-surgical` with isolated context, source/test context, compressed verify context, and harness verification.

| Metric | Baseline | Batched Candidate | Change |
| --- | ---: | ---: | ---: |
| Pass rate | 100% | 100% | preserved |
| Median wall time | 53.63s | 28.84s | 46.2% faster |
| Median tokens | 166,247 | 21,339 | 87.2% lower |
| Median tool calls | 9.5 | 2.0 | 78.9% lower |
| Median changed files | 2.0 | 1.0 | 50.0% lower |

## Interpretation

- Token and tool-call improvements are stable above the 60% target.
- Quality by pass rate stayed at 100%, but this suite is too easy to prove a 60% quality gain because baseline also passes every task.
- Speed improved materially, but the batched rerun did not confirm the earlier 76.9% speed improvement; it showed 46.2% faster median wall time.
- The current candidate should remain a benchmark mode, not a default OpenCode-core policy.

## Overfitting Risk

Yes, there is a real overfitting risk. The current tasks are small Python fixes, and adding source/test context makes the benchmark much easier than real repo work. The accepted candidate is valid for this suite, but not enough evidence for a broad default behavior.

Before promoting anything into core, add a harder quality suite where baseline pass rate is not saturated. Examples:

- Multi-step bugs requiring two source areas.
- Ambiguous failures where the first failing assertion is not the root cause.
- Larger repos with irrelevant but tempting files.
- Hidden invariant checks beyond unit tests.
- Tasks where running tests is necessary to disambiguate the fix.
