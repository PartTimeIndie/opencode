# Composer reference toggles

Declare `appendOnSubmit: true` and exactly one `command: { name }` or
`skill: { name, aliases? }` on a composer toolbar item. Declare `ui:toolbar`
and `host:composer`. The host uses the existing icon button, including named
icons, tooltip, order, enabled/visible rules and accessible `aria-pressed` state.
Skill-toggle tooltips keep the plugin's description (or title fallback); do not
append a generic manual-only or missing-tools warning. Actual invocation and
permission checks remain unchanged.

```ts
api.toolbar.register({
  id: "image",
  title: "Image reference",
  tooltip: "Arm /codex-image for the next message",
  placement: "composer",
  icon: { name: "code" },
  command: { name: "codex-image" },
  appendOnSubmit: true,
})
```

A click only arms/disarms the item. It does not open a prompt dialog, submit a
message, dispatch a command or generate an image. Custom `run` or `mount`
handlers override the standard behavior completely. Multi-Agent Review, Visual QA,
and Progressive Plan Builder use this standard so remounts do not erase their
selection and rejected sends do not consume it. The former Progressive Plan
plugin-wide selection is not imported into an arbitrary composer; its obsolete
stored value is ignored. Other plugins without this option retain their behavior.

State belongs to plugin/item plus server, directory, optional session and composer.
New-chat composers can arm a toggle before the first message creates a session;
their exact server/directory/composer identity still prevents cross-draft use.
Arming does not require text or create a session. A
same-target remount retains it. Reload, item removal, disabling/hiding the item
or plugin unload clears it. Missing capability, stale editor, foreign server
or ambiguous palette target fails closed without selecting another draft.

The final composer phase runs after ordinary before-submit handlers and appends
plain slash references only to non-whitespace normal manual drafts. It dedupes
whitespace-delimited identical tokens; it is not a Markdown or authorization
parser. Structured attachments and file/agent references use the existing
structured append path. An empty or attachment-only draft gets no token and
retains its activation. Shell, programmatic `composer.submitText`, and
Continue/Resume do not append or consume it. Deliberate manual Queue/Steer
retains its chosen delivery. Only durable prompt admission (or acceptance by
the existing local Queue callback) commits the captured activation. Validation,
abort, stale edits and rejected admissions leave it pending. A later re-arming
is never consumed by an older in-flight receipt.

For a palette action, declare `commands` and `host:toolbar`, then call
`api.host.toolbar.toggle({ item: "image" })`. This only operates on that plugin's
standard action; it cannot invoke arbitrary custom toolbar handlers. Explicit
directory/session/composer targets are optional; omitted composer identity is
resolved only if exactly one live composer matches.

## Commands, skills and tools are different

- `/codex-image` is a command reference. Appending it to existing text does not
  guarantee command-template execution.
- `imagegen` is a skill. Do not create a second `codex-image` skill to shadow it.
- `image_generate` is the executing tool. A reference does not grant tool access.

`host.skills.list` remains the existing skill-reference projection.
`host.skills.diagnostics` (requires `host:skills`) returns readable
`command-not-skill`, `not-found`, `manual-only`, and `missing-tools` hints.
Pass the selected agent, or an exact current composer target to derive it.
Without a resolvable agent, no missing-tool verdict is claimed. The read-only
server constraint endpoint projects the current registry and calls the existing
`SkillV2.missingTools` evaluator; it neither stores a second catalog nor grants
execution. Skill content resolution keeps its existing `ResolveIssue` contract
and `host:skill-content` capability.

An armed toolbar click alone does nothing; submitting the message appends the
exact `/name` token, which the core gate accepts as authentic explicit user
invocation — no manual retyping is required. Multiple appended manual skills
are submitted together. The anchored latest durable user-message recognition,
and all agent/project/tool permissions, remain unchanged.

Source and plugin-runtime synchronization do not install this API. Installed
acceptance requires a separately authorized full desktop deployment; never
patch an ASAR or stop/restart the app as an implicit part of this workflow.

## Mirror

The general `mirror-app` uses this standard with `skill: { name: "mirror" }`.
It is available in every project's composer, including before Session creation.
Never gate arming on a Session ID or a project-specific lease subprocess. The
executing skill resolves the actual ID from the authoritative host context after
admission. A reference does not grant file permissions or relocate the Session.
Standalone workspaces use the Core private-file adapter through `script/mirror.ts`;
the source and stable Session identity bind the retained lease. Native task
helpers use their separate host-bound admission and reviewed `task_integrate`
path. A standalone mirror reference never creates a task or grants integration
authority.

## Native Orchestrator

The manual `native-orchestrator-app` toggle appends `/native-orchestrator`.
Its [maintained skill and installation guide](../../.opencode/plugin-sources/native-orchestrator-app/README.md)
route planning through the same main conversation before any implementation
forks are dispatched. Native `task` forks inherit the completed planning context;
private file mirrors remain a separate workspace boundary. Reviewed changes use
`task_integrate` with exact-plan host approval. The toggle restores no legacy
Main-Orchestrator service, activation, children or approvals. Registration and
browser fixture checks do not certify installed reload or live Task readiness.
