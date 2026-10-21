# Core Tool Architecture

This folder owns Core's one local tool representation, process and Location registration, effective lookup, and settlement.

## Representations

- `tool.ts` defines the opaque canonical `Tool.make({ description, input, output, execute, toModelOutput })` value. Application tools and shipped built-ins use the same type.
- `application-tools.ts` stores process-scoped application registrations.
- `tools.ts` exposes the registration-only `Tools.Service` view used by Location producers.
- `registry.ts` stores only canonical tools, overlays Location registrations over application registrations, derives definitions, invokes tools, and applies generic output bounding.

Do not add a second executable entry type, registry-owned executor, authorization callback, output-path callback, or legacy normalization path.

## Construction

Tool schemas and projection use `input` and `output` terminology. A tool value is opaque: its codecs, executor, definition derivation, and catalog permission declaration are private runtime details.

Tool descriptions state when to invoke the capability, not just how it executes. For `multi_agent_fanout`, describe the triggering request for multiple independent agents or an already authorized workflow, route ordinary document and source lookups to direct read/search tools, and distinguish model-chain selection from parallel review. Preserve explicit user requests to look directly. Test this guidance through the registered model-facing definition.

Location-scoped built-in layers acquire `PermissionV2.Service` and every other required Location service while the layer is constructed. The executor captures those services. Permission sources are always constructed from the canonical invocation context:

```ts
const source = {
  type: "tool" as const,
  messageID: context.assistantMessageID,
  callID: context.toolCallID,
}
```

Leaves own resolution, permission, and side-effect ordering. Translate only expected typed errors into `ToolFailure`; do not use `catchCause`, because interruption and defects must survive.

Manual-only skills (`disable-model-invocation: true`) remain in the user slash catalog, but their names and descriptions are excluded from model guidance. A model skill call needs a leading canonical slash or alias in the durable user prompt before that assistant call; missing intent fails closed. Keep permission checks and host-granted capability leases after this gate. Test discovery, context updates, explicit loading and denied calls together.

OpenCode's global `skill_invocation.manual` restricts only the listed exact canonical skill names after source precedence. Aliases cannot expand the list and project config cannot relax it. Unlisted skills retain their existing modes and project exceptions; never turn a composer-toolbar-only request into a catalog-wide manual default. Keep the user catalog and explicit selection intact, and never rewrite shared Claude/Codex sources for this OpenCode-only policy. Image-generation tools are separate from skill invocation.

## Skill group presentation

Keep group projection in `../skill/catalog.ts`, shared by guidance and the skill tool.
Filter scope, permission, required tools and manual invocation before grouping. Groups
need three actually visible unique leaves and smaller rendered text, including the
navigation hint. They grant no capabilities. Full skill loading still uses the existing
leaf authorization. Never add model-time grouping, global search, a task-driven flat
fallback, or a process-level already-loaded ledger. Deduplicate only against exact,
unpruned group output in the current projected history, so compaction/revert can reload.
Group config and portable membership authoring live in the `customize-opencode` skill.
Bound guidance-context caches across catalog and policy revisions; eviction must allow
the same catalog to be reconstructed without changing visibility or invocation rules.

## Registration

Built-ins register through `Tools.Service.register({ [name]: tool })`. Application tools register through `ApplicationTools.Service.register(...)`, exposed publicly as `opencode.tools.register(...)`.

Both are scoped:

- The latest active same-placement registration wins.
- Closing any registration removes only that registration and reveals the next active one.
- Location registrations take precedence over application registrations.
- An invocation captures the effective tool once settlement starts.

`ApplicationTools.Service` is process-scoped and shared by all Locations. `ToolRegistry.Service` is Location-scoped. Do not make the registry process-global or construct a separate application-tool service for each Location.

## Permissions

The registry has no `PermissionV2.Service` dependency and performs no execution authorization. An internal built-in-only operation attaches a permission action solely to preserve whole-tool definition filtering; it is not part of public `Tool.make`. Most tools default to their registered name; `edit`, `write`, and `apply_patch` declare the shared `edit` action.

Definition filtering is catalog visibility, not execution authorization. A call still executes the captured leaf policy if it reaches settlement.

## Output

Built-ins return complete validated domain output. `ToolRegistry.Materialization.settle` is the only execution and generic model-output bounding boundary and owns managed retention references.

Producer capture limits are separate. For example, Bash keeps `AppProcess.maxOutputBytes` and accurately reports stdout/stderr capture loss, but it does not run model-output truncation or return a managed `outputPath`.

`outputPaths` remains the legacy field name at the event boundary, but new shared-store entries in that field must be opaque `attachment://` references. Never persist the physical content-store path in Session messages, events, or checkpoints.

## Current Gaps

- Plugin boot has not been redesigned to register canonical tools through `Tools.Service`; do not redesign it as part of leaf migrations.
- MCP and future Session-scoped registrations still need an explicit canonical registration design.
