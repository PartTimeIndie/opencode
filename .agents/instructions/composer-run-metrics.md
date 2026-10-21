# Composer run metrics

A Composer run is one durable session Activity, including its provider and tool turns. It is not a single model request and it is not the whole session lifetime.

- Read run start/end and snapshot timestamps from the Usage API. Advance a live duration locally from the server snapshot with a monotonic clock; do not request the server every second.
- Treat `completed`, `failed`, and `interrupted` as terminal. A local terminal event may freeze the display while the final durable read is pending, but the persisted activity end time remains authoritative. Ignore any later-arriving running snapshot for that same terminal Activity—even when no earlier Usage snapshot exists—and drain a fresh read.
- Preserve the frozen duration of a terminal Activity if a following Activity starts before its final Usage read completes; do not let the old local timer resume while the new read is pending.
- Bind Usage reads to the current session/activity where available. Ignore responses made stale by a session or activity-generation change, and retain the last valid response after a transient read failure.
- Build each Usage response from one SQLite read transaction so session totals, the event-sequence boundary, Activity state, messages, and child attribution describe one database snapshot.
- For recovered Activities, rebuild the original sequence boundary only from the matching durable `Activity.Started` event and bound a running window by the current event-sequence snapshot; never widen it to future messages.
- Keep Run, Session, and descendant totals separate. For run tokens, render only measured values; preserve measured zero, show partial known values as estimates, and show unknown as unknown rather than zero. Do not infer measurement completeness from attribution completeness.
- Generation streaming time counts only provider token arrival: per attempt, from the first to the last text/reasoning/tool-input delta. Bare `tool-call` events are excluded because hosted tools emit them after provider-side execution. Request assembly, first-token latency, tool execution, and inter-attempt recovery waits stay excluded. Persist it as `tokenMeasurement.generationMilliseconds` on `Step.Ended`, aggregate it in `session.generation_ms` (own sessions only — subagent streams overlap the parent wall clock), and render tok/s only from samples of at least 500 ms; unknown or too-short samples stay hidden, while measured zero renders as `0 tok/s`. Retry attempts count toward streaming time but their discarded tokens are not re-credited, so rates after retries read slightly low; in-stream stalls between deltas of one stream count as generation time by the first-to-last-token definition.
- Keep first-token latency (`ttfb_ms`) independent of the resettable generation window. Draining a step's generation duration must not erase the attempt's first-token sample; structural-only streams still leave it unknown. Cover both paths through the real runner perf events.
- Intersect task/fanout provenance—including legacy `sessionId` results and session-scoped externalized structured JSON—with the parent-session descendant tree. Never create child links from ordinary message text or an unscoped content reference.
- Render historical models and distinct chain versions only from durable run-window selections/observations. Do not deduplicate chain history by ID alone or substitute the session's current model/current configuration for missing history.
- Keep instrumentation additive in existing event/message JSON and Usage response contracts. Do not add a metrics table. Do not alter retry, failure, recovery, interrupt, or tool-settlement behavior to support metrics.
- The LLM publisher is a shared write boundary: do not edit `packages/core/src/session/runner/publish-llm-event.ts` until the C0 owner explicitly releases it, then re-read the file and compare a fresh diff/hash before editing only the approved measurement hunks. Regenerate the SDK only after the shared schema/publisher gate is cleared.
- Run tests and typechecks from their package directories. Verify the Usage API and Composer in a real browser. Installed-app acceptance requires Supervisor-coordinated full production deployment and visual verification; source-only builds are not deployed evidence.

Focused checks:

- `packages/core`: `bun test test/session-token-measurement.test.ts test/session-usage.test.ts` and `bun typecheck`
- `packages/opencode`: `bun test test/server/httpapi-experimental.test.ts` and `bun typecheck`
- `packages/app`: focused Composer unit test, `bun typecheck`, `bun run typecheck:e2e`, and `bun run test:e2e:controlled -- e2e/regression/session-run-metrics.spec.ts`
