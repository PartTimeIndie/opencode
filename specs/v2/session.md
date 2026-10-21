# Session API

## Current V2 Core Slice

The Effect-native core facade treats prompt recording and execution as separate responsibilities:

```text
sessions.create({ id?, location, ... })
  -> omitted ID generates one internal Session ID
  -> supplied ID creates the Session when absent
  -> reused ID returns the existing Session identity

sessions.prompt({ id?, sessionID, prompt, delivery?, resume? })
  -> omitted ID generates one internal message ID
  -> supplied ID admits one durable Session input when absent
  -> exact reuse returns the same admitted lifecycle receipt
  -> reusing one message ID for another Session, prompt, or delivery mode fails
  -> exact retry schedules another wake unless resume is false
  -> resume omitted or true schedules execution after admission
  -> resume false admits only

sessions.interrupt(sessionID)
  -> interrupts the active ownership chain on this process
  -> waits for active drain cleanup and settlement
  -> suppresses reruns already queued before interruption
  -> preserves durable inbox rows for a later fresh wake or resume
  -> idle or missing Session is a no-op
```

`session_input` is the durable admission inbox. Admitted inputs remain outside model-visible Session history until the serialized runner publishes `PromptLifecycle.Promoted`. The projector atomically writes the visible user message and marks its inbox row promoted in the same event transaction. Prompt ingress no longer has a V1 shadow-projection path; normal prompts and resolved commands both use this admission-and-promotion contract.

Execution routing starts from only the Session ID:

```text
SessionExecution.resume(sessionID)
-> SessionStore.get(sessionID)
-> LocationServiceMap.get(session.location)
-> SessionRunner.run({ sessionID, force? })
```

`SessionExecution` and the read-side `SessionStore` are process-global. `SessionRunner`, catalog, model resolver, tool registry, permission state, and filesystem are cached per Location. No layer takes a Session ID. An omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.

The local runner issues one explicit `llm.stream(request)` per provider turn, projects each complete local tool call durably before eagerly starting its structured child execution, awaits every started tool fiber after provider-stream closure, reloads projected history once before continuation, and fails after 25 provider turns within one local drain activity only when work remains. Tool settlement events carry the owning assistant message ID because provider-local call IDs may repeat across turns. Before assembling a provider request, the runner durably fails any local tool still projected as `running` from a previous process with `Tool execution interrupted`; abandoned side effects are never silently replayed.

Projected hosted tools preserve call-side and settlement-side provider metadata separately so settlement and interruption recovery cannot erase continuation identifiers. Provider-native reasoning and provider metadata replay only while the historical assistant model matches the selected continuation model; after a model switch, visible reasoning text remains ordinary assistant text and provider-native metadata is omitted.

## Context Epochs

V2 Sessions persist the exact privileged System Context shown to the model. A Context Epoch owns one effective agent, one immutable baseline, and a model-hidden structured snapshot used to compare independently observed Context Sources. Environment facts, the host-local date, ambient global/upward-project `AGENTS.md` files, and selected-agent available-skill guidance are the initial sources. Location-wide sources come from the System Context Registry; selected-agent guidance composes with them immediately before Context Epoch admission.

The first complete observation initializes the epoch before any pending prompt becomes model-visible. If initial context is temporarily unavailable, execution stops while the prompt remains pending and retryable. On later provider turns, the runner promotes eligible input first, then reconciles current sources at the safe boundary. Changed context becomes one durable chronological System message, and its event commit advances the epoch snapshot atomically.

```text
Client            Runner                         System Context Registry       Context Epoch Store       Session History         LLM
   │                 │                                      │                           │                       │                 │
   ├─ Admit prompt ─────────────────────────────────────────────────────────────────────────────────────────────▶                 │
   │                 │                                      │                           │                       │                 │
   │                 ├─ Observe initial context ────────────▶                           │                       │                 │
   │                 │                                      │                           │                       │                 │
   │                 ◀─ Complete baseline or unavailable ───┤                           │                       │                 │
   │                 │                                      │                           │                       │                 │
   │                 ├─ Initialize missing epoch ───────────────────────────────────────▶                       │                 │
   │                 │                                      │                           │                       │                 │
   │                 ├─ Promote eligible input ─────────────────────────────────────────────────────────────────▶                 │
   │                 │                                      │                           │                       │                 │
   │                 ├─ Reconcile at safe boundary ─────────▶                           │                       │                 │
   │                 │                                      │                           │                       │                 │
   │                 ◀─ Unchanged or chronological update ──┤                           │                       │                 │
   │                 │                                      │                           │                       │                 │
   │                 ├─ Advance snapshot atomically with update ────────────────────────▶                       │                 │
   │                 │                                      │                           │                       │                 │
   │                 ├─ Baseline + chronological history ─────────────────────────────────────────────────────────────────────────▶
```

Agent switches, model switches, and completed compactions request lazy baseline replacement. A switch admitted after the current safe provider-turn boundary applies to the next provider turn while leaving the already-prepared baseline durable. Before another cross-agent provider turn, the replacement must complete; unavailable admitted context blocks instead of exposing the prior agent's privileged baseline. A Session move clears the epoch so the destination Location must initialize a complete baseline before another provider turn. Epoch creation and replacement are fenced against the authoritative Session Location/effective agent and the epoch revision, preventing stale or ABA-observed context from becoming durable.

```text
Session                            Epoch
   │                                 │
   ├─ initialize complete baseline ──▶
   │                                 │
   │                                 ├─────────────────────────────────╮
   │                                 │ reconcile chronological update  │
   │                                 ◀─────────────────────────────────╯
   │                                 │
   ├─ request replacement ───────────▶
   │                                 │
   │                                 ├─────────────────────────────────────╮
   │                                 │ replace after complete observation  │
   │                                 ◀─────────────────────────────────────╯
   │                                 │
   ├─ clear after Location move ─────▶
```

Ambient project discovery canonicalizes and contains traversal within the project root and honors `OPENCODE_DISABLE_PROJECT_CONFIG`. An unavailable observation preserves the previously admitted value. A confirmed partial instruction removal emits the complete remaining aggregate with explicit supersession text; removing the final instruction emits a revocation message.

Current Context Epoch follow-ups:

- Add configured, remote, and nested instruction sources with explicit precedence and removal semantics.
- Add durable post-crash activity recovery for promoted or provider-dispatched work. The pending-input and stale-activity paths are now implemented (see **Automatic Startup Recovery**); full provider-retry and background-job recovery remain future work.
- Add explicit manual compaction on top of automatic request-budget compaction.
- Add operational metrics for observation latency, unavailable sources, contention, baseline size, and chronological-update growth.
- Consider watcher-backed per-file caching only if measurements show direct safe-boundary observation is too expensive.
- Expose plugin-defined Context Sources only after plugin reload and scoped cleanup semantics are designed.
- Add clustered Session execution ownership and stale-runtime fencing.

## Automatic Compaction

Before each provider turn, the runner estimates the complete model-visible request and compares it with the selected model's context window minus absolute reserved headroom. The reserve is the greater of the requested/model output allowance and configured `compaction.buffer`. When the request exceeds that budget and older complete turns are available, the runner compacts before executing the pending turn.

Compaction keeps the full transcript durable while replacing its active model representation with one hidden checkpoint containing a structured rolling summary and token-bounded serialized recent context. Provider-native assistant, reasoning, and tool messages never survive across the boundary, avoiding signature and encrypted-reasoning failures when the earlier prefix changes.

`session.next.compaction.started.1` durably identifies the attempt. Compaction deltas are live-only progress. `session.next.compaction.ended.2` durably stores the final summary and serialized recent context; only this completed event projects a model-visible compaction message and requests Context Epoch replacement. A failed or interrupted attempt therefore leaves the previous history boundary active.

Repeated compactions update the previous structured summary with newly compacted messages. The runner then reloads projected history and executes the original pending turn.

When a provider rejects a request as context overflow before durable assistant output or tool activity, the runner attempts one overflow-triggered compaction even when the local estimate did not predict pressure. A completed checkpoint rebuilds the same logical provider turn with one remaining physical attempt. A second overflow, unavailable compaction, or overflow after durable output becomes the ordinary terminal failure; recovery never loops or replays partial side effects. Deterministic old tool-result pruning remains a separate follow-up.

## Automatic Startup Recovery

On process restart, the local execution layer scans for interrupted work before accepting new requests. Recovery is scoped to the durable inbox and activity lease state that survives a crash; it never infers that ambiguous provider work is safe to retry.

- Recovery scans `session_input` for rows with `promoted_seq IS NULL` and wakes the owning sessions.
- Recovery claims stale `session_activity` rows whose leases have expired and resumes those sessions.
- The recovery policy is "safe auto": incomplete provider steps and pending/running local tools are durably settled as interrupted before the session continues from the last safe history boundary. Local tools are never silently re-executed after a crash.
- Each drain activity opens a durable `session_activity` row with a lease. A process that crashes mid-drain leaves a stale lease that the next startup claims.
- New events: `session.next.activity.started`, `.recovered`, `.interrupted`, `.completed`, `.failed`.
- Recovery is active by default. Set `OPENCODE_DISABLE_SESSION_RECOVERY=1` to disable.
- Durable multi-node ownership and full background-subagent recovery remain future work.

## Installed Single-Path Request Contract

The V2 runner is the installed Session execution path, so the former pre-cutover V1 parity table is no longer a release gate. Model-visible request assembly now has these owning boundaries:

- `SessionExecution` resolves the Session's current Location and enters one Location-scoped `SessionRunner` drain.
- The runner combines the durable Context Epoch, chronological projected history, the active compaction checkpoint, and the admitted prompt before selecting the effective agent and model.
- Prompt-level system text and typed attachments survive durable admission. Registered command templates resolve before admission and then use the same inbox lifecycle as ordinary prompts.
- The Location-scoped tool registry materializes the effective tool catalog and applies the selected agent's permission policy. Provider turns and tool settlements publish through the Core V2 Session event/projector boundary.
- Each continuation reloads projected history; only the Core V2 runner/event path owns execution and projection.

Remaining product work is tracked as explicit extensions in **Current Context Epoch Follow-ups** and **Current Runner Follow-Ups**, not as prerequisites for a second execution path.

Provider timeout, retry, and watchdog policy is intentionally deferred. The runner does not impose a universal provider-stream inactivity or absolute timeout. A future slice should design configurable policy around provider behavior, durable failure reporting, and local drain-chain release rather than hardcoding one default for every provider.

Inbox delivery is explicit:

- `steer` inputs promote at the next safe provider-turn boundary, including continuation inside the current drain.
- `queue` inputs form a FIFO of future activities. When the current activity settles, the runner promotes exactly one queued input to open the next activity. Multiple queued inputs remain separate activities.

Execution has two entry points:

- `run` is an explicit resume. It joins an active drain chain or starts one, and performs at least one provider attempt even when no input is eligible.
- `wake` reports newly recorded durable inbox work. Repeated wakes coalesce. A wake calls the provider only when it can promote eligible input.

Automatic startup recovery for pending inputs and stale activities is implemented (see **Automatic Startup Recovery**). A wake still does not infer that ambiguous provider work is safe to retry after an input has already been promoted. Explicit `run` may deliberately continue from durable projected history. Full provider-retry and background-subagent recovery remain future work.

A process-global `SessionRunCoordinator` serializes each local Session drain chain while allowing different Sessions to drain concurrently. It enters the Session's current Location only when a drain starts, so interruption targets process execution ownership rather than Location cache identity. Interruption establishes a local ownership-chain boundary by stopping the current chain while preserving pending/unpromoted durable inbox rows for a later fresh wake and projected history for explicit resume. A Location runner also fences every new provider turn against its captured Location so a moved Session cannot begin another turn through source-Location tools or context. An already-dispatched provider turn may still settle source-Location calls until a future move-control slice interrupts active ownership. Automatic startup discovery, durable multi-node ownership, stale-owner fencing, and retry policy remain future work.

Inbox promotion coalesces pending steers in durable admission order and opens one queued activity at a time in FIFO order. Add explicit inbox backlog and steering-batch limits before exposing broad multi-caller admission or untrusted queue growth.

Eager local-tool execution is intentionally unbounded in the current local slice. This minimizes tool latency but does not increase SQLite settlement throughput: Session-event publication remains serialized per provider turn. Before broadening exposure, revisit per-turn call limits, output truncation, and operational backpressure using observed workloads. The `session.next.*` event schemas remain experimental and unshipped; databases created by earlier experimental builds are disposable rather than compatibility targets.

The synchronized `session.next.*` event family and projected Session-message model predate this branch. This slice refines their replay contract: projected Session messages retain their source aggregate sequence so canonical context ordering and `sessions.messages(...)` pagination follow durable event order even when caller-supplied IDs or timestamps do not. Consumers can use `sessions.events({ sessionID, after? })` to replay durable `session.next.*` events after an aggregate sequence cursor, then tail durable events without a race. Live-only text, reasoning, and tool-input fragments remain available through EventV2 subscriptions for connected renderers; they are intentionally absent from the replayable Session stream.

The first `sessions.events(...)` contract is durable-only during both replay and live tailing. This keeps one cursor equal to one persisted aggregate sequence and is sufficient for reconnect-safe consumers such as Discord publication. A later UI-facing API may optionally interleave live-only deltas while connected, but those fragments must remain explicitly ephemeral: they cannot advance the durable cursor, replay after reconnect, or be mistaken for publication boundaries. Until that contract is designed, connected renderers can combine `sessions.events(...)` with direct EventV2 delta subscriptions.

Durable event tail wakeups are advisory and edge-triggered. Each active tail owns one sliding-capacity-1 dirty signal for its aggregate and re-queries SQLite after a wake. Repeated commits coalesce while the tail is busy because durable rows, not in-memory notifications, preserve every event and sequence. Subscribe and register the dirty signal before historical replay, then remove it when the tail closes, so replay handoff cannot miss a commit and inactive aggregates retain no wake state.

Event replay owner claims are separate from clustered Session execution ownership. The former already fences synchronized projection reconstruction; the latter still needs distributed active-run acquisition, stale-runtime rejection, interruption, and placement orchestration.

## Current Tool Registry Slice

`ToolRegistry` is Location-scoped. Contributions are scoped replayable transforms: closing a contribution scope removes its definition and rebuilds the advertised catalog. Execution decodes input, optionally authorizes the call, invokes the retained handler, validates output, and settles failures as typed tool-result errors.

When a Session omits `agent`, both execution and permission evaluation use the default `build` agent. A caller must not observe `build` model behavior while permission checks silently evaluate an empty no-agent policy.

The first built-in contribution is bounded `read`:

```text
resolve one path relative to the Location or a named project reference
-> reject absolute paths, path escapes, and symlink escapes
-> authorize read against the canonical resource identity
-> for a file: return UTF-8 text or base64 binary content; page oversized UTF-8 text by bounded line ranges
-> for a directory: return direct children in directory-first alphabetical order
-> page directory results with one-based offset and next cursor
```

V2 `bash` uses the normal permission semantics: configured agent rules plus saved project approvals, with `ask` as the default when no rule matches. Bash is not sandboxed: the spawned shell runs with the host user's filesystem, process, and network authority. Structured external `workdir` resolution remains an enforced `external_directory` authority check. Best-effort scans of absolute command arguments produce advisory warnings only; they are not sandbox boundaries and do not request or enforce `external_directory` approval.

The first V2 `apply_patch` leaf supports add, update, and delete hunks. It parses every hunk, resolves every mutation target, approves external directories, approves one edit batch, and preflights approved update/delete targets before committing operations sequentially. A later commit-time failure leaves earlier operations applied and returns an explicit partial-application report. Moves and atomic rollback remain separate follow-ups rather than implied behavior.

### Current Runner Follow-Ups

- Keep eager structured local-tool settlement: durably record each complete call, start its child execution immediately, await all started settlements after provider-turn consumption, persist every result, and reload history once before continuation.
- Buffer or coalesce streamed deltas before rewriting growing assistant projections.
- Revisit additional covering indexes as larger-history query shapes become concrete.
- Expose replayable Session events over HTTP and the generated SDK where remote consumers need them, deciding whether that public cursor should be opaque rather than the embedded API's branded aggregate sequence.
- Decide whether UI-facing Session subscriptions should optionally interleave ephemeral deltas while connected without advancing the durable cursor.
- Add provider-aware context control for provider-executed tool results. Generic text truncation cannot replace provider-native structured payloads that must round-trip exactly.

## Command And Initialization Contract

Commands use `POST /api/session/:sessionID/command`. The endpoint waits for the Location's V2 plugins, resolves the named `CommandV2` template (including MCP-provided commands), applies its configured agent/model and file inputs, and admits the resolved prompt through the same durable `session_input` lifecycle as `v2.session.prompt`.

The response is the admission receipt. Unless `resume` is `false`, a normal command schedules a wake after admission. A command registered as a subtask instead promotes its admitted input and dispatches the V2 task tool through the command endpoint; queued subtask execution is not yet supported. `delivery` remains explicit as `steer` or `queue`. An exact retry may reuse the supplied message ID only when the Session, resolved prompt, and delivery contract match.

`/init` is the built-in `init` command registered by the Core command plugin and is invoked through this normal command endpoint. There is no dedicated `session.init` route, compatibility command bridge, or Session-service initialization special case.
