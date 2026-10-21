## Subagent and Reviewer Loop Guard

When an OpenCode reviewer, multi-agent review child, or subagent appears to loop, stop only the child task/session unless the user explicitly approves a broader shutdown. Before aborting, record the child task/session ID, model-round progress, context growth, last meaningful tool/action, inactivity duration, and any findings already produced. These are safety observations, not workflow budgets: multi-step review, multi-action review, and multi-agent proposal work may continue for as many steps, reads, greps, rounds, and tokens as needed. Stop a child only for a verified loop, explicit cancellation, provider/context failure, or exhausted OS/runtime resources, while preserving the parent session, dev servers, and available findings.

### Loop-abort checklist

Apply this qualitative checklist to every child (reviewer, problem-solver agent, explore/map subagent) before deciding it is healthy. There are no numeric read, grep, step, round, token, or artifact-size ceilings for these workflows. Stop only the looping child and preserve partial findings; never kill the parent session or dev servers. A loop is indicated by repeated identical actions with no new evidence, an explicit cancellation, a provider/context failure, or an OS/runtime resource failure. Record the evidence and reason before aborting.

Distinguish child kinds before counting slots or retrying:

- **Foreground subagent:** the parent waits inline. It runs until completion, explicit `timeout_ms`, manual cancellation, provider/context failure, or exhausted runtime resources. A verified looping foreground child directly blocks the parent — abort that child early.
- **Background subagent:** occupies a `maxThreads` slot (`task-job.ts`). A looping background child wastes a slot and provider quota — abort and free the slot.

Reviewer Sessions and registered fanout workflow workers have no total-runtime deadline, foreground or background. Never supply `timeout_ms` for them; the Task runner ignores legacy/model-supplied values on these paths. Do not reintroduce a deadline through a CLI wrapper, shell timeout, collector, or plugin. The multi-agent fanout instead re-checks each pending reviewer on a fixed cadence (currently 15 seconds) and keeps waiting while it still runs; roughly ten minutes is a normal review and longer is allowed. Provider-stream inactivity protection is a separate transport guard, not a review duration limit: preserve it and report genuine stream failures separately from manual cancellation, quota errors, and local task deadlines. Historical reviews stopped by a local deadline are censored observations, not evidence that the configured model cannot complete a review.

Classify a zero-output child before discarding it:

- **Never-settled:** started but never reached a provider turn (0 tokens, ≤4 messages). Do not retry; remove from slot counting; report as `spawn_no_output`.
- **Fast-error:** terminated immediately with an error (0 useful tokens but an error result). Surface as an `error` result, do not silently drop it.

### Headless helpers versus reviewer Sessions

- Distinguish a full reviewer/subagent Session from headless helper calls (prompt/transcript improvement, titles, turn-completion checks). A helper failure is not proof that the reviewer itself is looping.
- Output-token caps include hidden reasoning. Rewrite helpers must reserve reasoning capacity even for short drafts; reproduce empty output with the real prompt and inspect the finish reason and reasoning usage, not only HTTP success. Never apply a token-truncated rewrite as a complete result.
- Ordered headless chains default to no SDK retries inside a step; the chain owns fallback. Honor explicit retry settings and preserve configured model/variant order. Do not silently lower a reviewer's reasoning variant to work around helper latency.
- Diagnose provider overload/quota failures separately from local budget or protocol errors. Keep failures attributable to the plugin/helper and report the installed build separately from source-only fixes.

Also watch for **self-loops in the main session** (not only children): repeated `bash`/`scheduled_job_result` calls with unchanged observations over many turns indicate the running session itself is polling without progress. Break the loop (defer, split, or surface to the user) rather than continuing to consume quota.

Do not create cross-session acknowledgement loops. After a substantive update has been delivered, do not answer a pure acknowledgement or closure message with another acknowledgement. Send another message only for new evidence, a concrete blocker, or an action that is actually required; respect an explicit request to stop contact. A delivery receipt alone is not a reason to poll, re-prompt, or confirm again.
