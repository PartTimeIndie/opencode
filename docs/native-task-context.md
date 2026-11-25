# Native task context and workspace

Native `task` and registered `multi_agent_fanout` calls use the ordinary Session execution owner. Conversation inheritance and filesystem placement are independent choices; neither changes the child's tool or permission ceiling.

## Context

- `context: "fork"` (default) imports sanitized current parent working history, including compaction and chronological system updates. The unfinished dispatch assistant is excluded. Parent system identity, approvals, read receipts and executable capabilities are not transferred.
- `context: "fresh"` starts with the self-contained assignment and the selected child's own instructions. It imports no parent dialogue, system updates or attachments. The host still validates the exact running dispatch, originating promoted user input, source epoch, placement and policy.
- A failed fork never silently switches to fresh. Follow-ups retain the existing child's history, workspace and original context mode. Explicit attempts to change that mode refuse admission. Older saved native child policies without a mode mean fork.
- Native conversation-task forks get a host system instruction on each regular model request: imported parent history is background, the child handles and verifies its own assignment without delegating it again, and Main coordinates and reviews. This is guidance only; history, task text and available tools stay unchanged. Fresh tasks and ordinary user forks do not get this handoff.

Examples:

```json
{ "description": "Inspect parser", "prompt": "Inspect src/parser.ts for malformed input handling.", "subagent_type": "explore", "context": "fresh", "workspace": "readonly" }
```

```json
{ "description": "Implement agreed fix", "prompt": "Implement the fix agreed in the preceding dialogue and add regression coverage.", "subagent_type": "build", "context": "fork", "workspace": "mirror" }
```

The agent IDs above must be configured and permitted. Fresh assignments must contain their own requirements; referring to unseen parent dialogue does not transmit it.

## Workspace

`mirror` remains the default private copy. `main` still requires fresh single-use host consent for writing. `readonly` retains the explicit read/grep/glob ceiling. Context selection neither grants Main access nor supplies a destination path, credentials or additional tools. Mirrors are independent copies, not operating-system sandboxes.

## Future inputs and attachments

A native dispatch may capture while explicit unheld `queue` inputs await future activities. Those prompts stay pending and are not imported or treated as authority. Pending steer and all held inputs still block capture. The deferred ledger is part of the source binding: new inputs or changes during preparation or retry refuse admission rather than silently recapturing. Ordinary non-dispatch fork capture remains strict about every pending input.

Quoted `attachment://` links in text or structured reports are not ownership grants. Fork preparation resolves only source-owned attachments or verified inherited aliases. Unowned textual links remain inert text. Declared file attachments, canonical top-level managed-output envelopes (`$opencode`, `$opencode.text` and legacy `$opencode.output`) and managed `outputPaths` must resolve with verified bytes. Missing or corrupt replay dependencies still fail closed; nested quoted reports do not become dependencies merely by containing similar strings. Imported copies belong to the child and can be inherited by descendants through the same scoped owner.

## Ownership and verification

- Context schema: `packages/core/src/session/task-context.ts`.
- Capture and attachment materialization: `session/fork.ts` and `session/fork-import.ts`.
- Atomic admission, retry binding and follow-ups: `session/task-admission.ts`.
- Model-facing execution handoff: `session/host-context.ts`, derived from the child's saved task source and context mode.
- Model-facing Task and fanout schemas: `tool/task.ts`.
- Contracts: `test/task-admission.test.ts`, `test/session-fork-import.test.ts`, `test/session-fork.test.ts`, and production Location/LocalExecution loopbacks in `test/session-orchestrator-runtime.test.ts` (paths relative to `packages/core`).

Run tests and `bun typecheck` from the package directory. Source tests and a source Dev browser do not certify the installed desktop runtime; deployment and restart require separate approval.
