# Orchestrator continuation repair — 2026-11-06

## Authorization and boundaries

Human requested autonomous completion of the helper-continuation repair, full production build/deploy/restart and force-close if required, then continuation of the original PU work **with helpers**. No new approval questions for already authorized operations. No Git mutations, branch/worktree changes, cache warmup/retry, threshold reduction, credential fallback or direct database repair. Preserve unrelated staged/unstaged/untracked work.

Main: `ses_1aba5a8310018Z5fO7CFLdnsSt`; host PU `E:/GitRepros/PU`, master. Repair source `E:/GitRepros/opencode`, fork-sync, ahead 14 / behind 1. No PU product edits in this repair.

## Reproduced defects and correction

1. A later genuine human input had no exact saved commission, so status/continuation failed with a typed origin conflict. Selection now prefers an explicit `originInputID`, otherwise the current input's exact package, otherwise exactly one saved package. Revoked rows count toward ambiguity. Selection grants no authority and never updates saved consent/scope.
2. Integrated dependent dispatch initially still failed `SessionFork.CaptureConflict (boundary)`: task authority was correctly old, but history capture incorrectly used the old user ID with the current call. Provisioning now separately verifies the current user/call through `continuationBoundary`, captures that exact current history endpoint, and retains/rechecks it through preparation/import/materialization. Task authority still comes only from the saved commission.
3. The latest promoted message is decoded and compared to its admitted prompt before reserving a slot. Tampered follow-ups fail early; manipulation during an awaited registry hook rolls back child creation while retaining the snapshotting claim.
4. Main Shell correctly refused execution while helper slots were claimed, but the outer Bash error wrapper erased the typed guard message. It now retains existing `ToolFailure` messages unchanged. Reservation rules were not weakened.

## Acceptance → current evidence

- Human follow-up selects the same package, without new approval or receipt edits: `orchestrator-commission.test.ts` continuation matrix and the real `commission-fork-followup` runtime probe.
- Explicit selection, multi-package ambiguity, unknown/plugin input, foreign/revoked/corrupt scope, policy/model/settings/owner drift and pending input: focused commission tests; failures remain closed.
- Later dependent dispatch and actual import/materialization: `tool-orchestrator.test.ts` nine later-dispatch cases, including successful human follow-up, unknown/plugin/tampered inputs, changed call, revocation/model drift and hook-time tampering. No extra child on rejection. Hook-time tampering retains the claim.
- Original Shared/Mirror lifecycle, dependent dispatch, reasoning and automatic slash activation: five real production Location/LocalExecution/Loopback probes. These use isolated databases and no developer credentials; they do not prove live provider cache hits.
- Current human input keeps its existing input-derived transport family; the saved package's original family is unchanged. Tests explicitly verify both. No cache-routing repair or cache-threshold change is claimed.
- Readable Shell guard with zero processes and zero permission calls: real registered Bash tool test with stored Main guard evidence; separate ToolFailure identity test and process-spawn error regression.
- Durable ownership: owning `.agents/instructions/v2-session-core.md` and orchestrator tool description updated.

## Verification commands and results

From `E:/GitRepros/opencode/packages/core`:

- `bun test test/orchestrator-commission.test.ts test/tool-orchestrator.test.ts test/tool-bash.test.ts test/orchestrator-provision.test.ts test/session-fork.test.ts test/session-fork-import.test.ts --only-failures`: final run 187 pass / 0 fail / 718 assertions, including the additional hook-time case.
- `bun test test/tool-orchestrator.test.ts --test-name-pattern 'later dispatch' --only-failures`: 9 pass / 0 fail / 40 assertions after adding that case.
- `bun test test/session-orchestrator-runtime.test.ts --test-name-pattern 'commission-fork-(auto|followup|lifecycle|mirror|reasoning)$' --only-failures`: 5 pass / 0 fail (each parent validates its isolated production-runtime subprocess).
- `bun typecheck`: pass after the final source/test changes.
- Scoped `git diff --check`: pass before the final test-only hook case; Git reports existing LF/CRLF normalization warnings, not whitespace errors.

The new follow-up probe first failed an inherited same-input-only cache-family assertion. The test was made precise for the explicitly requested new-input contract: old requests/package retain the old family, new human-turn requests use exactly their existing input-derived family. Production cache routing was not changed. The initial tampered-follow-up test exposed a late refusal after claiming; production code now rejects it before claiming.

## Old helper settlement — freshly read, no repair writes

Read-only inspection of the installed `opencode.db` on 2026-11-06:

- `oct_df5b95748d76e205595a6b3ad3353b2004c021b88cbbd89673ce6072e4216841`: cancelled, revision 9, slot_claimed=0, cache low, ratio 0.11321613694157741.
- `oct_8ccd1e171ca50e29aab170271bbdfbdaba53fa6293755ef55c0610c232ee2cbc`: cancelled, revision 9, slot_claimed=0, cache low, ratio 0.1132610704108056.
- Both original child Activities remain failed, closed_seq=266, owner_id=null, lease_until=null. No successful child result and no reinterpretation as completion.
- No reservation rows for these tasks, no related background jobs, no pending/running background jobs in the installed database. Shell works again. No retry or database mutation was performed.

## Maintenance inventory and review limitation

Fresh read-only installed runtime inventory found only this Main as a running Activity. Other local-development database rows have old expired leases and are not treated as current Sessions to contact. There are no currently active known foreign writers to pause. No historical broadcast or session-history read.

Attempt to load `multi-agent-review` was refused verbatim: `Skill multi-agent-review requires an explicit /multi-agent-review invocation`. Do not bypass the manual invocation gate with fanout, shell or another model. No independent review of the current repair is claimed. The user's existing explicit instruction is to continue the ordinary repair/deploy task without another process-approval loop; deterministic checks remain mandatory.

## Deployment / continuation handoff

**Current repair is deployed.** Executed `bun run desktop:deploy automatic --approved-close --force-close-approved` from the OpenCode root. After restart, `bun run desktop:deploy status` returned the new durable completed receipt:

- Run: `auto-20261106T024957Z-2568942b`, phase `automatic-completed`, status `completed`.
- Build: `20261106T025039Z-ff711051`.
- Source fingerprint: `ce5936aba706c0d220ecb87452d4aa6da7078145e3f58c51dec1e75d9394705a`.
- Artifact SHA-256: `7670819e3d1623cc4f5159bc11e1b86d2350a799473dabda0c2b2aee97c0c577`.
- Backup: `C:\Users\crisc\AppData\Local\Programs\@opencode-aidesktop.backup-20261106T025331Z-20261106T025039Z-ff711051`.
- Build log: `C:\Users\crisc\AppData\Local\OpenCodeDeploy\build-20261106T025039Z-ff711051.log`.
- Restart: `true`; force-close approval retained; completed at `2026-11-06T02:54:01.632Z`.

Final scoped `git diff --check` passed immediately before launch. No Git mutations or partial ASAR replacement. Deployment checks the whole packaged application; this is installed delivery evidence, not a new live helper cache result.

The last observed *previous*, unrelated completed deploy was build `20261105T182255Z-5fcc3ad4`, source fingerprint `c283a46992a9251ee17d1f8dbb89cd3274ef4293ec776c9472b5e76ff4c965d0`, artifact SHA-256 `6ae8ac4acb1f63fc0e5dcc1b5883ff85296da2f4ea804b254fcd7487d4bdaa9e`, restart=true. It does not contain or prove this repair.

After verified deployment, resume PU with legitimate native helper commissioning. The two failed analysis children remain cancelled tombstones, not retry candidates. Original scope: Normal MatchCard materials/nameplates, exact board-square fit, remove only the duplicate artifact Fly-in while preserving Chris's transition, then Trello Gameground/Milestone-Demo candidates assigned to Nikolas Crisci. PU intent revision 32 had no card/intent choice; apply its real owning workflow without inventing approval. The `main-orchestrator` tool/skill is not currently advertised in this session's supplied catalog: deployment alone is not permission to bypass a missing capability or manual activation gate.

Installed repair receipt is complete (above). Still open: live helper resumption and original PU implementation; old optional UI-video/evidence-retention work has not been completed. Never mark those complete from source tests alone.

Post-restart PU check: master unchanged, only the same three pre-existing `.opencode/agents/` edits. Fresh canonical index, match-cards current/history and location-events current/history remain revision 32, storeHash/snapshotDigest as above, projections current. Workflow snapshot still has no card/intent choice. Initial read using the instructions' old C: spelling was rejected `hook_project_path_mismatch`; corrected read used the runtime-confirmed `E:\GitRepros\PU` root, no workflow writes.

Post-restart actual `perf.jsonl` runner metrics for this exact Main contain 24 tools, including `skill`/`surface` but no `orchestrator`, `task` or `spawn_agent`. PU build agent uses `tools.mode: inherit`, with an intentional task deny; it does not explicitly hide orchestrator. `skill({name:"main-orchestrator"})` was refused exactly: `Skill main-orchestrator requires an explicit /main-orchestrator invocation`. This is a fresh manual activation boundary, not evidence that the deployed continuation fix failed. Do not activate via shell, HTTP, database, another model, fabricated user input or a popup-default inference; a genuine explicit slash message is required by the installed host. No PU product edits while this remains blocked.
