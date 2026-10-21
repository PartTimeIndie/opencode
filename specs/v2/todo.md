# TODO

ok we need to work towards a launch of v2 so we can get out of this rebuild phase

## Post-Hono cleanup - Kit

The opencode server has moved to the Effect HttpApi backend. Remaining work is
mostly cleanup: delete compatibility shims, shrink Zod surfaces, and simplify
test harnesses that used to compare Hono and HttpApi behavior.

## New Data Mode - Dax

This is mostly done. I'm working through modeling subagents, skill invocations
and shell commands.

## Agent loop: installed local single path

The Effect-native SessionV2 loop is the installed local execution path. No
legacy loop or opencode-side processing bridge remains. Current behavior
includes:

- durable `session_input` admission before model-visible projection; `steer`
  inputs coalesce at safe provider-turn boundaries and `queue` inputs open FIFO
  future activities one at a time
- process-global `SessionExecution.wake(sessionID, admittedSeq)` and explicit
  `resume(sessionID)`, with Location discovery deferred until a drain starts
- one explicit `llm.stream(request)` call per provider turn, durable text,
  reasoning, failure, assistant, and tool events, and eager structured local-tool
  execution whose settlements are all awaited before continuation
- projected-history reload before each continuation and a 25-turn guard only
  while work remains in one local drain activity
- automatic request-budget compaction, one overflow-triggered fallback attempt,
  durable compaction checkpoints, and Context Epoch replacement after completion
- startup recovery for unpromoted inputs and stale activity leases; incomplete
  provider steps and pending/running local tools are settled as interrupted and
  local tools are never silently replayed
- process-local same-Session joining, cross-Session concurrency, and interruption
  of the active local ownership chain while durable pending work remains available

### Open runner and recovery work

- Add clustered Session execution ownership, placement orchestration,
  stale-runtime fencing, and multi-node interruption. Event replay-owner claims
  do not provide execution ownership.
- Add an explicit retry/abandon policy for provider work whose dispatch outcome is
  ambiguous after process loss. Any bounded automatic retry needs provider/tool
  idempotency rules, budgets, backoff, and visible recovery status.
- Integrate background jobs and background subagents with durable status,
  completion delivery, cancellation, continuation, and post-crash recovery.
- Add measured backpressure: per-turn tool limits, output controls, streamed-delta
  batching, and any covering indexes justified by production query shapes.
- Expose replayable Session event cursors over HTTP/the generated SDK where remote
  consumers need them, and design any UI stream that mixes ephemeral deltas
  without advancing the durable cursor.
- Design provider-aware timeout, retry, and watchdog policy instead of imposing a
  universal timeout on every provider.

An advisory wake still must not retry ambiguous already-dispatched provider work.
Automatic startup recovery continues from the last safe durable history boundary;
full provider-attempt retry and background-job recovery remain separate work.

## Plugin API design - James?

We need to figure out how we want server plugins to work and what hooks are useful.

Some ideas:

- plugins get immer drafts so bad mutations can be thrown away
- plugins get global "opencode" instance like in that post i showed
- opencode instance has stuff like `opencode.session.prompt()` or
  `opencode.tool.register({...})`

## Rework Config - ???

We should do another pass on config to clean up any mistakes we made with it and
simplify as much as possible. Old configs should get auto-converted to new

## Auth - ???

I have a basic auth system that can track any kind of auth, not just providers

## Model Database - ???

I have a basic model service that allows for models to be registered dynamically

## Provider - ???

Providers should register as plugins and autoload based on whatever logic they
want / config. They should register models into model database

## Event - Kit

The self-contained durable `EventV2` core service is implemented. It owns
sync-versioned persistence, transactional sequencing, pub/sub, replay, and
replay-owner claims without relying on the old bus system.

Remaining slices:

- expose the embedded consumer-facing Session cursor API over HTTP and the
  generated SDK where remote consumers need it
- keep replay-owner claims distinct from future clustered Session execution
  ownership and stale-runtime fencing

## Deferred hardening cleanup

Keep these visible, but do not block functionality slices on them unless a concrete
failure appears during canary work:

- serialize database migration claiming across processes; current migration
  application is protected only by an in-process semaphore, so two processes
  starting against one SQLite database can still race
- simplify process-local durable-tail wake lifecycle with Effect `RcMap` and one
  shared `PubSub.sliding<void>(1)` per active aggregate; keep SQLite cursor replay
  and subscribe-before-history semantics unchanged
- page large durable aggregate replay reads instead of loading every row after a
  stale cursor into one array
- decide whether connected tails need a periodic polling fallback for
  cross-process SQLite writers; current advisory wakes are intentionally
  process-local
- stream-cap websearch body collection before parsing
- add ripgrep execution timeout and bounded line framing
- materialize or consistently reject unresolved URL and file attachment sources
- decide stateless OpenAI Responses hosted-tool continuation behavior; reconstructed hosted output can replay as a stored `item_reference` when `store !== false`, while `store: false` intentionally omits the unavailable reference path
- decide whether to preserve deprecated `@opencode-ai/llm` orchestration exports
- preserve or alias renamed filesystem SDK generated type names if compatibility
  consumers require them
- revisit syscall-level mutation confinement for hostile external processes
  (`openat`, `O_NOFOLLOW`, and descriptor-relative mutation where supported)

## Everything is hotreloadable - ???

Instead of needing to tear down things when something changes every service should emit granular events so services can react to them and reconfigure themselves. Allows frontend to receive these too, eg model.added. also prevents startup from blocking
