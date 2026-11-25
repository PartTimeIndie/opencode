---
name: native-orchestrator
description: "Plan work in the main conversation, then create native conversation forks for implementation and review their changes before integration."
disable-model-invocation: true
---

# Native Orchestrator

OpenCode-only, manual workflow. Start with a genuine submitted
`/native-orchestrator` or a submitted message armed with its toolbar icon.
Clicking the icon only marks the next message; it does not plan, submit or start
children. A bare skill invocation without an actionable task asks for the task
through one native popup with free text; never invent work.

The goal is **plan together first, fork that conversation second**. Main stays
the coordination conversation, not a fresh context-free dispatcher. This skill
does not restore the retired `/main-orchestrator`, grant tools or change models.

If the host identifies this session as the directly assigned execution fork, do
not run the Main workflow below. Imported parent history is background, not a
new instruction to plan or dispatch. Carry out and verify your current assignment
yourself; do not delegate it again. Report the result and checks to Main. Main
coordinates, reviews and handles any authorized integration.

## 1. Plan in the main conversation

Read the current request, retained conversation, task state and relevant current
files. Reuse decisions already made. Establish scope, acceptance checks, task
boundaries and real dependencies before implementation dispatch.

- Planning and plan refinement stay in the Orchestrator main conversation in
  normal mode, even when the user says to plan first. Do not call `switch_agent`
  or enter Plan Mode for this workflow. Main discusses scope and the plan with
  the user before creating implementation forks.
- If an older host still requires a Plan-agent handoff, report the conflict; do
  not bypass the host instruction or silently change agents.
- Keep the agreed plan in the conversation and its canonical `plan_document`
  when available. Ask only about unresolved decisions that materially change the
  result, using a blocking native popup with actionable options and free text.
- Do not start implementation children during planning. Complete the supported
  plan review and obtain explicit implementation authorization before dispatch.
  A plan already agreed and explicitly authorized for implementation needs no
  second general approval or agent switch; dispatch uses native `task` from Main.

## 2. Fork the agreed plan

After implementation is authorized and the main conversation is ready, use
native `task` with an explicit configured `subagent_type`. Native admission
imports the completed conversation context, including the agreed plan, at its
guarded source boundary and adds each child's precise assignment. Do not replace
this with unrelated fresh sessions carrying only a short task description.

**Start forks one at a time.** For independent assignments, call `task`
directly with `background: true`; do not wrap fork starts from the same Main
in a parallel tool call. Confirm the first start and save its child ID, then
use `task_wait` on that ID with `timeout_ms: 5000` before starting the next.
A timeout ends only the wait. Five seconds worked in practice but is not an
admission guarantee. Independent children may keep working in parallel.
If the short wait delivers a terminal result, keep it; batch-collect only the
remaining IDs. On `Session fork import refused (changed)`, report the exact
error and process any pending Main input normally before another attempt. Do
not blindly retry, switch to `context: "fresh"`, or bypass admission.

If the user explicitly requests ordinary subagents without conversation forks,
use `context: "fresh"` with a self-contained assignment containing the agreed
scope, decisions, owned files, dependencies and acceptance checks. This is an
explicit alternative, never an automatic fallback after fork admission fails.
Use `workspace: "main"` only when the user/project permits the shared checkout;
assign disjoint files and serialize shared generators, builds and Unity access.
No mirror or worktree is implied. The same model, reasoning and permission
settings still apply. Main retains planning and rule decisions; children report
unclear behavior instead of inventing a new rule.

A conversation fork and a file mirror are different: the fork carries context;
`workspace: "mirror"` additionally gives an implementation child its own private
file copy. Keep Main in its existing checkout. Never allocate another standalone
mirror for Main merely because this input also includes `/mirror`.

- Use the same actual model, reasoning/variant and permission settings as the
  parent for implementation. Verify the selected agent's effective inheritance;
  omit overrides only when they preserve those settings. Never guess a provider
  or silently substitute a named agent's different defaults. Permissions remain
  the parent/child intersection; a skill supplies no additional access.
- Start each conversation-fork assignment and follow-up with an explicit handoff:
  "You are the execution fork, not Main. Imported history is background. Carry
  out and verify this assignment yourself; do not delegate it again. Main
  coordinates and reviews your result."
  Give each child an assignment, relevant plan decisions, owned files/boundaries,
  dependencies and verification requirements. Parallelize independent work only;
  dispatch dependent work after its prerequisites are reviewed and integrated.
- Later Main messages are not automatically broadcast to existing forks. Put
  later decisions and integrated prerequisites in an explicit follow-up, or
  create a new native fork after Main has recorded them.
- Include only explicitly selected, relevant untracked files via
  `untracked_paths`; never copy secrets, ignored data or caches wholesale.
  Private mirrors are independent files, not OS sandboxes.
- Use registered fanout only for an explicit multi-agent review/investigation
  request or a workflow that already authorizes it. Ordinary task decomposition
  is not permission to run an unrelated panel of reviewers.

## 3. Collect and review

Prefer foreground tasks for bounded interactive work. For background tasks,
collect all returned IDs with one `task_wait`. Use `task_result` for durable
status after an interruption or missing result. A wait timeout is not inactivity.
Pass `task_id` to `task` only for a new follow-up to a terminal child, with the
same `subagent_type`; never use it to collect a running task. Reviewers have
no total-runtime deadline. Preserve findings and distinguish real provider or
ownership failures from an incomplete wait.
Registered reviewers keep their assigned model and variant without inheriting
Main's fallback chain. Preserve original receipt-bound reports if a later marker
or correction omits findings. A marker or promise to review is not a review;
locally recovered findings do not turn a failed assignment into a clean success.

Main reviews the actual child changes, not just its summary. Require focused
behavior tests, suitable integration/browser checks for real boundaries, and
the affected package's `bun typecheck` where provided. Do not skip or loosen
tests to get green output; report blocked checks and existing failures honestly.

## 4. Integrate reviewed changes

For a finished mirror child, call `task_integrate` without `plan_digest` to
prepare a read-only three-way plan. Inspect the exact changed files and conflicts.
Apply only that reviewed plan with its returned `plan_digest` and the tool's
fresh single-use host approval. Main drift requires a new plan; never edit Main
between preparation and application or replay a consumed plan. Resolve conflicts
inside the child through a supported follow-up, not a shell copy into Main.

Report what was actually applied, checks run and remaining blockers. Integration
does not imply a Git commit, push, deployment, app stop/restart or mirror deletion;
each keeps its own authorization boundary.

## Failure and historical boundaries

If admission refuses pending inputs, process them through the normal runner
before dispatch; never promote them through SQL. On missing tools, invalid
ownership, policy refusals or unsafe source drift, show the exact blocker.
Do not silently switch to direct implementation, fabricate receipts, repair
leases, weaken guards or route through shell/HTTP to bypass native admission.
A terminal error is not proof that a follow-up can be admitted. Inspect its prompt
promotion, live ownership and cleanup state before proposing any follow-up; never
retry a failed preparation or expired lease unchanged. A one-time human-approved
direct-repair exception must name its scope and retain all ordinary write guards.

Historical children, claims and approvals stay unchanged. Never execute retired
legacy children, reinterpret their approvals as native admission, or release
their unresolved claims. A genuine current task is separate from that history.
