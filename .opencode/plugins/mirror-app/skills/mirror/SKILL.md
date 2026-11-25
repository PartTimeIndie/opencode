---
name: mirror
description: "Start a standalone Mirror or finish its reviewed merge-back. With native orchestration, keep Main in place and use the children's host-owned mirrors."
disable-model-invocation: true
---

# Mirror

The toolbar appends `/mirror` to the next normal message. It works before a
Session exists. Resolve identity **when executing**, from the authoritative
`OpenCode host session` system context, never a provider thread, guessed ID,
title, quoted message or another Session. No history read or user-supplied ID
is needed. If the host identity is unavailable, report that exact blocker.

The maintained runtime includes `script/mirror.ts` in the OpenCode source
checkout. Use its absolute path supplied by the installation's README. It
requires the existing Bun runtime and Git; never install dependencies or log in
automatically.

## Invocation means start or finish

- **Native orchestration or a task child:** follow the native rules below before
  any standalone status/start/close command. Do not create a second workspace.
- **Active standalone Mirror: close and merge back by default.** This includes
  a message containing only `/mirror` and an empty draft submitted with the Mirror toolbar toggle armed.
  Treat that genuine human submission as the closeout request and proceed directly
  through Finish / close. Do not ask whether to keep using the Mirror or create a
  second workspace. An explicit instruction to keep working in the Mirror takes
  precedence over this default.
- **No existing Mirror: start one** through the guarded standalone start below.
  A click that merely arms the toolbar without submitting is never an instruction.
- Check the current task's already verified workspace as well as the session
  registry. If an existing legacy Mirror is known but not registered here,
  do not create a replacement or pretend it is registered. Preserve its source,
  basis and ownership; use only a supported guarded integration/adoption route.
  If none exists, report the exact blocker rather than silently changing workflows.
- The close request does not approve an unseen merge plan, a Git commit, deletion,
  or stopping an app. Preserve conflict checks and the exact-plan host approval.
  Closing means completing merge-back; physical removal stays a separate action.

This default is for standalone tasks. Native task placement and historical
ownership guards take precedence; a bare toggle never converts an existing task.

## Native orchestration and task children

When the genuine input also selects `/native-orchestrator`, plan in the main
conversation first. After the agreed plan is authorized, use native `task` with
`workspace: "mirror"` for implementation children. Their conversation forks
include the completed planning context. Keep Main in its existing checkout;
do not create a standalone mirror for Main through the CLI.

- **Existing native child:** keep its host-bound workspace. Do not allocate
  another mirror or close its native workspace through the standalone CLI.
- **Native integration:** Main reviews the finished child and uses
  `task_integrate` to prepare and apply the exact plan with fresh host approval.
  Never substitute standalone `mirror_integrate` or shell copies.
- **Historical legacy Main or child:** execution remains blocked. Preserve its
  stop state, children, claims and approvals; never reactivate or reinterpret
  them as native tasks. Missing native tools or placement evidence are blockers,
  not permission to fall back to standalone provisioning.

Keep the existing standalone closeout and explicitly authorized takeover routes
separate from native task admission. A mirror reference grants no extra access.

## Standalone task

1. Resolve the exact current source repository root and the current host Session
   ID. Use argument arrays or the shell's proper quoting; IDs/paths are data.
2. Run `bun <opencode-checkout>/script/mirror.ts --action status --directory
   <source-root> --session <host-session-id>`. This is read-only, even on first use.
   If active, use its exact returned directory and start Finish / close by default;
   reuse it for implementation only when the human explicitly requests more work.
   Never infer ownership from a directory name. Missing/corrupt/incomplete leases stop allocation; preserve
   them for inspection, with no retry that creates another workspace.
3. If available and no already verified task Mirror exists, run the same command
   with `--action start`. It uses the Core
   private-file adapter, with no remote, writable hardlinks, or Git worktrees.
   Tracked dirty source files are included and verified against their captured
   basis. Ignored files and unselected untracked files are excluded; explicitly
   pass one `--untracked <repository-relative-file>` per authorized new file if
   the task needs it. Never copy secrets, dependency caches or private scratch
   files wholesale. Unsupported symlinks/submodules or source drift fail closed.
4. Report the real Session ID, source, mirror directory and basis ID. Perform
   this task's reads/edits/tests only in that workspace, with absolute paths and
   shell working directories. Keep the same model and Session; this operation
   does not relocate the Session's host directory. Native file and external-path
   permissions still apply. Do not bypass a native conflict with Shell/CLI.
5. Continue using the recorded Mirror for later work in this Session, including
   after compaction. Run the normal focused tests and typecheck. Keep the source
   checkout unchanged. A Mirror is independent files, **not an OS sandbox** or
   proof of physical disk savings.

## Failed standalone preparation

An incomplete reservation never authorizes retry, deletion or lease fabrication.
For a drained failure recorded by the current adapter, `--action recover` prepares
a read-only retention plan. Show its error, reservation, retention path and exact
`planDigest` in one blocking native popup with free text. Only after explicit
approval run the same command with `--reservation-digest <planDigest>`. This keeps
all artifacts in a separate archive; it neither changes source files nor starts
another Mirror. Unknown old/crashed owners, missing failure receipts and valid
leases stay blocked for inspection. This is never native/legacy Task recovery.
An existing recovery claim, retained destination or interrupted move also stays
blocked for manual inspection; never remove the claim or replay the move. If the
failure receipt could not be written, preserve the primary preparation error and
its secondary diagnostic instead of treating the unknown slot as recoverable.

An older reservation with **no receipt and no contents at all** has a separate
external maintenance route. Run `--action recover-legacy-empty` without a digest
to inspect the exact Session/source slot and obtain its read-only plan. Apply
only from outside OpenCode, after every OpenCode process has stopped, using the
same command with `--reservation-digest <planDigest>`. The command checks for
OpenCode and other Mirror CLI writers again before the atomic move, and retains
the old empty reservation under the reported path. It refuses any contents,
lease, changed slot, active writer or stale plan. This exception never applies
to an unknown nonempty reservation and never fabricates a lease or failure receipt.

## Finish / close

A submitted `/mirror` requests this closeout by default when a standalone Mirror
is already open, even without accompanying text. Reuse that verified workspace;
do not ask for a second general close-intent confirmation. This does not imply
physical deletion. This route never writes the source through Shell/CLI; the
reviewed merge runs host-side.

1. Show the task-owned mirror diff, the focused tests actually run, the exact
   source/basis and any source drift.
2. Run `bun <opencode-checkout>/script/mirror.ts --action close --directory
   <source-root> --session <host-session-id>`. It is read-only and returns
   either `conflicts` with paths and reasons (resolve them inside the mirror
   and keep the workspace open) or a `ready` plan with `planDigest` and
   per-file write/delete changes. Never edit the source between this plan and
   its application.
3. Present the plan and open ONE blocking native popup whose approval names
   exactly this planDigest (merge / keep open / cancel, plus free text). Green
   tests, prior task approval, silence and dismissal do not approve the merge.
4. After that approval, call the host-bound `mirror_integrate` tool with the
   plan's `plan_digest`. Its apply phase takes the host's fresh single-use
   confirmation, re-derives the whole plan, refuses any source drift and
   commits through the guarded multi-target transaction with journal. If the
   tool or its apply path is unavailable, report that blocker; never write the
   source through the CLI, shell or manual copies as a fallback.
5. Report the applied files. A commit remains a separate explicit step; the
   merge itself never commits.
6. Deleting the integrated mirror is separate: only after another explicit
   approval run `--action discard`. It re-proves the mirror is unchanged since
   integration and refuses otherwise.

Never overwrite dirty source files, reset/clean, force-add ignored files,
push, stop/restart apps, or recursively delete mirrors as an implicit finish
step. Keep the workspace on conflicts, drift, failure or uncertainty.
Native task integration uses `task_integrate`, never this standalone route.
Historical legacy ownership remains protected and non-executable.
