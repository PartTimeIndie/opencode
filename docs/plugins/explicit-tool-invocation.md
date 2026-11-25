# Explicit, activity-bound plugin tools

Use this contract when a plugin tool must not be present in ordinary model
requests. Agent `tools.mode: explicit` is an allowlist, not an invocation gate.
Skill `disable-model-invocation` controls skill loading, not the tool schema.

## Plugin declaration

A server/local tool may declare `explicitInvocation: "export-report"`, or a
nonempty list of exact command names for aliases. Names are lowercase kebab-case,
without the leading slash. Normal agent visibility, project scope and permission
denies still apply. Activation never adds a tool omitted from an explicit policy.

The tool remains in the Settings catalog, but its schema is absent from model
requests until all conditions below hold. Catalog availability is not activation.

1. The latest promoted, durable input starts with the exact `/export-report`
   command. Mentions in prose, quotes, code fences, tool output or compacted model
   history do not qualify. There is no fallback to an earlier matching input.
   For `session.command`, the host retains the explicitly selected command as a
   leading line after template/plugin expansion, but only if a registered tool
   declares that exact name. Ordinary commands keep their existing prompt text.
   This preserves the candidate, not approval; generated API requests still need
   the host click below. The metadata lookup never materializes a tool schema.
2. That input belongs to the currently running, owned activity. A queued but not
   promoted input, a completed task, or an ownership lease that expired cannot
   activate a tool.
3. The host receives single-use permission approval for exposing that tool for
   this command. A user-shaped prompt is only a candidate: automation can create
   one too. Full-access mode, remembered Allow rules and model confirmation text
   must not replace the host's one-time click. Denial/cancellation does not cause
   an automatic repeated activation question for the same registration/input.
4. The input, owner and activity still match after the approval. The same checks
   run again at tool settlement, before executing the plugin callback.

Consent is bound to the session, selected agent, activity and owner, input ID and
content digest, and tool registration identity. Replacing a held input uses its
released execution prompt rather than reviving the original command. Replacing
the registration or restarting the runtime requires fresh activation. Within the
same unchanged input/activity, normal tool continuations reuse consent. Parallel
materializations serialize the decision for that one tool; unrelated sessions do
not share the lock. Cache keys include the binding, not only the tool list.

Any new user input ends the prior input's activation. If a later task still needs
the tool, start its slash command again. Native Surface/permission replies that
continue the same input do not themselves add a new user instruction. Completed,
failed or interrupted activities cannot retain executable grants.

## Tool execution is separate

`ToolContext.explicitInvocation` contains the host-bound command, input ID and
activity ID. It is not a model argument. Plugins that require this contract should
refuse execution when the receipt is absent, including on older runtimes. This is
an additional guard, not a substitute for normal operation-specific permissions
and human review of writes, sending, deployment or other side effects.

No durable lease table or database migration is added. A runtime restart loses
activation, safely requiring another host decision. The existing input, activity
and permission stores remain authoritative. An explicitly denied agent policy
keeps the tool hidden and causes no activation prompt.

## Integration and rollout

Ownership: `packages/plugin/src/tool.ts` defines the public declaration;
`packages/core/src/tool/local.ts` carries it through the plugin adapter;
`tool/explicit-invocation.ts` binds durable inputs to host consent;
`tool/registry.ts` gates both schema materialization and execution.
`location-layer.ts` provides the database dependency to the production registry.

Do not enable the tool in an older installed runtime merely because a newer
plugin declares this field: older loaders may ignore metadata. Verify the complete
installed Core gate first, then configure the specific agent tool entry. Keep
ordinary request `tool_ids` free of the tool; prove a fresh explicit invocation
plus host approval includes it and a later ordinary request excludes it again.
A local library build or source test is not an installed desktop deployment.
Deployment and stop/restart permissions remain separate.

## Verification

From `packages/core`, run the explicit-invocation, runner-tool-context,
runner-tool-registry, registry-cache, local-tools and permission tests, followed
by `bun typecheck`. From `packages/plugin`, run `bun typecheck` and the normal
library build when a local consumer uses its generated `dist` types.
From `packages/server`, run the session-command tests and `bun typecheck` to
check the command-expansion boundary. Respect installation permissions: the
existing local-tools fixture that runs a package installation needs separate
authorization; select the non-installing tests when that authorization is absent.

Tests use synthetic tools and isolated databases. They cover ordinary/quoted
prompts, host denial, automated user-shaped input, exact aliases, policy ceilings,
cache isolation, changed/released inputs, activity and owner changes, cross-session
calls, concurrent materialization, compaction and actual captured runner requests.
This proves source behavior, not any still-running installed version.
