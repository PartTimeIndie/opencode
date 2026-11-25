# Native Orchestrator

Manual OpenCode entrypoint: **plan in the main conversation, then create native
conversation forks from that plan**. Workspace placement follows explicit user
and project boundaries; mirrors are not implied. Main reviews actual changes and
uses the guarded integration path for any expressly authorized mirror.
This is a skill plus a standard toolbar toggle, not a second execution service.
It does not reactivate the retired Main-Orchestrator or migrate its children.

## Use

Click **Nativer Orchestrator**, write the task and send, or include
`/native-orchestrator` in a normal message. Clicking alone never starts work.
For example: `Discuss the settings change with me; implement only after we
agree. /native-orchestrator`. Planning stays in the Orchestrator main conversation
in normal mode, even when the user says to plan first. The workflow does not
switch agents or enter Plan Mode. An already authorized plan does not start
another planning or approval round. Once the plan
is authorized, native `task` children fork that completed conversation with their
individual assignments. Later messages in Main are not automatically sent to
existing children. If the user explicitly requests ordinary subagents without
conversation forks, `context: "fresh"` is allowed with the complete agreed scope
and self-contained assignments. It is never an automatic admission fallback.
Shared-checkout work requires user/project permission, disjoint ownership and
serialized shared effects; model, reasoning and permission settings stay intact.
Main keeps planning and rule decisions.

`/native-orchestrator` together with `/mirror` selects native mirror children,
not a second standalone checkout for Main. Existing child placement and all
historical ownership protections remain authoritative.

## Global installation

1. Preserve the maintained source here. Synchronize only this plugin from the
   repository root with `bun run sync:plugins --only=native-orchestrator-app`.
2. Install `skills/native-orchestrator/SKILL.md` into the OpenCode personal skill
   root `~/.config/opencode/skills/native-orchestrator/SKILL.md`. Keep
   `disable-model-invocation: true` and ensure no scoped invocation override
   changes it to automatic. Do not install copies into other harnesses: they do
   not expose this OpenCode host workflow.
3. Add the absolute path of the maintained `.opencode/plugins/native-orchestrator-app`
   runtime directory once to `plugin` in `~/.config/opencode/app.jsonc`, preserving
   existing entries. A global registration covers all projects; do not add a
   redundant project entry. No new tool permissions or models are required.

The icon is reversible: disarm it, hide it with the host toolbar controls, or
remove this one registration. Keep skill removal a separate explicit action.

## Verification and readiness

Run `bun test app.test.js` in this source directory. From `packages/app`, run
`bun run test:e2e:controlled -- e2e/regression/native-orchestrator.spec.ts`,
`bun test --preload ./happydom.ts ./src/plugin/append-on-submit.test.ts`, and
`bun typecheck`. The browser fixture loads this real plugin and checks Enter,
Send, pre-session/mobile availability and deduplication; it does not execute a
provider or certify the installed native Task lifecycle.

Source tests, runtime synchronization and global registration are not proof that
the running desktop has reloaded them or that native forks can currently run.
Report a Task ownership/admission failure separately from entrypoint readiness.
Never stop/restart the installed app, patch its ASAR or deploy as an implicit
installation step. A required full desktop deployment needs separate approval.
