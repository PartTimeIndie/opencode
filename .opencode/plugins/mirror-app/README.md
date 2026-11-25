# Mirror

General composer toggle for every project, including new chats. Clicking only
arms `/mirror` for the next normal manual message. The host owns exact composer
scope, remount persistence, Enter/Send, deduplication, rejected-admission retention
and one-shot consumption. No Session ID, status subprocess or project filter is
needed at click time. Disarm the toggle to opt out; remove the plugin to disable
this UI. There is no mandatory feature flag or permission widening.

On submission, `/mirror` starts a standalone Mirror when none exists. When one
already exists, it defaults to closeout and reviewed merge-back into its source,
including a bare `/mirror` message or an armed toolbar submission with no draft
text. No second general intent question is needed. The exact plan still requires
host approval; commits, app stops and physical deletion remain separate. Explicit
continued-work instructions override the closeout default. Known legacy mirrors
must not be replaced merely because the standalone registry does not own them.

Register the maintained runtime directory globally in OpenCode's `app.jsonc`
instead of registering it in one project. Existing historical mirrors are not
automatically migrated or adopted.

Install `skills/mirror/SKILL.md` as the OpenCode-only personal `mirror` skill,
keeping manual invocation. Record the absolute maintained checkout path to
`script/mirror.ts` in the installed copy. This repository's reusable skill source
has no private project or machine dependency. The CLI uses the existing Core
private-copy adapter; standalone leases live under OpenCode's global data root
in `standalone-mirrors`. No Session history or title lookup is required. Other
harnesses lack the authoritative OpenCode identity and must not receive this skill.

`/mirror` together with `/native-orchestrator` keeps planning in the main
conversation, then requests native `task` conversation forks with private file
mirrors. It never creates another standalone copy for Main or an existing child.
Main reviews results and uses `task_integrate` with exact-plan host approval.
The retired Main-Orchestrator is not an activation path; historical children,
claims and approvals remain protected and cannot become native admission.

Closing a standalone mirror is a reviewed host-side merge: `--action close`
prepares a read-only three-way plan (`planDigest` plus write/delete changes or
explicit conflicts) from the basis snapshot captured at start; the
`mirror_integrate` host tool applies exactly that plan after a fresh single-use
host approval, re-derives it against the current source and records every
mutation in the session journal. The CLI never writes the source.
`--action discard` deletes the integrated slot only after the mirror is
re-proven unchanged since integration.

Start performs read-only source preflight before allocating a slot. Equal-content
files share one verified basis blob. Ignored `.claude/worktrees/<name>` Gitlinks
are excluded without traversal or deletion evidence; other submodules and links
remain unsupported. A drained preparation failure retains its artifacts and a
generation-bound failure receipt. `--action recover` prepares a read-only retention
plan; after explicit human approval of that digest, `--reservation-digest <digest>`
retains that exact failed slot in a separate archive without deleting work or
changing the source. It never starts another Mirror automatically. Missing failure
receipts, unknown old/crashed writers and valid leases still fail closed.
Existing recovery claims or retained destinations never resume automatically.
Receipt-write failures retain the original preparation cause and a bounded
secondary diagnostic, leaving unknown ownership blocked for manual inspection.
For a pre-receipt reservation proven completely empty, external maintenance can
prepare `--action recover-legacy-empty` read-only and apply its exact digest only
while OpenCode and other Mirror CLI writers are stopped. The old empty directory
is retained, not deleted. Nonempty or changed reservations remain blocked.

Run `bun test app.test.js` here, Core's `test/mirror-session.test.ts` and
`test/mirror-close.test.ts`, and App's `e2e/regression/mirror.spec.ts` from
their respective package directories. Sync only this runtime with
`bun run sync:plugins --only=mirror-app` at the repo root. Plugin/config reload
is distinct from a verified installed desktop deployment; never stop or restart
the installed app without current approval.
