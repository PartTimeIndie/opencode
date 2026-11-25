# Core Tool Architecture

This folder owns Core's one local tool representation, process and Location registration, effective lookup, and settlement.

## Representations

- `tool.ts` defines the opaque canonical `Tool.make({ description, input, output, execute, toModelOutput })` value. Application tools and shipped built-ins use the same type.
- `application-tools.ts` stores process-scoped application registrations.
- `tools.ts` exposes the registration-only `Tools.Service` view used by Location producers.
- `registry.ts` stores only canonical tools, overlays Location registrations over application registrations, derives definitions, invokes tools, and applies generic output bounding.

Fanout reviewer call IDs are deterministic local correlation keys, not host tool
calls. Permission attribution uses the actual enclosing fanout call through a
private host-owned boundary; never infer authority from a reviewer suffix. This
separation does not itself authorize history capture or child admission.

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

Manual-only skills (`disable-model-invocation: true`, the global legacy `skill_invocation.manual` list, or an explicit `manual` invocation entry) remain in the user slash catalog, but their names and descriptions stay out of model guidance unless an explicit entry sets `visible: true`. A model skill call needs an exact whitespace-delimited canonical slash or alias in the matching promoted, interactive durable input before that assistant call, including after prose or other slash skills; a toolbar-armed submit satisfies the gate through its appended token. Plugin, unattested, mismatched or later inputs do not grant selection. Keep permission checks and host-granted capability leases after this gate. Test discovery, context updates, explicit loading and denied calls together.

Effective invocation policy resolves per skill in `../skill/policy.ts`: explicit agent entry → explicit global `skill_invocation.entries` → legacy default (frontmatter flag or legacy manual list) → built-in default (visible, `allow`). Catalog visibility is independent of invocation: a hidden skill can be `allow`/`ask`, and `manual` never blocks the user slash catalog. `ask` injects an extra evaluated permission rule layer (never SINGLE_USE metadata); explicit selection satisfies only that skill ask, never deny rules or tool permissions. Skill commands and synthetic injection use the same full permission assertion as the tool; deny and unreadable configuration fail closed before command expansion or hooks, and shell expansions need their own bash permission.

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

Definition filtering controls model-request visibility, not configuration discovery or execution authorization. A call still executes the captured leaf policy if it reaches settlement.

Contract-scoped tools (for example the scheduler result tool) stay advertised for an open scheduled run: the registry advertises them when the current prompt carries their marker or when the session's latest host-injected contracted prompt is still unsettled. `ToolRegistry.openContractMarkers` derives that state from projected history (latest user prompt with the marker, closed by a completed call of the bound tool), and `contractTools()` exposes the name-to-marker pairs the runner feeds back through `MaterializationContext.openContractMarkers`. Ordinary interjected user inputs and allowed agent switches therefore cannot drop a run's result tool, while unrelated sessions and settled runs stay clean. Filtering remains visibility-only, and the configuration catalog still excludes contract tools.

Read-only reviewers inspect Git through `git_status` (`scope: "summary"` or `"patch"`), never by granting a general shell. Availability is the intersection of the parent agent's delegable tools, the review agent's permissions, the registered workflow's tools and the saved child policy. Explicit project agent lists replace global lists: enabling only the reviewer or global build entry is insufficient. Check actual runner `tool_ids` and all owning config layers; do not bypass parent ceilings or widen existing child snapshots. Exercise production child requests and real staged/unstaged Git output in regression tests. Keep Git inspection non-executable (no fsmonitor, external diff or textconv callbacks), strip inherited `GIT_*` redirection and retain capture-loss markers.

The Settings configuration catalog lists registered, user-configurable tools and their input schemas independently of Session capability leases, agent allowlists and execution permissions. Never build it from `materialize()` or activate skills just to populate Settings. Keep turn-only contract tools excluded, preserve Location/application collision rules, and keep all runtime filters and settlement checks in `materialize()`. Test catalog discovery before activation together with denied, unlisted and revoked runtime access; both tool-list endpoints must use the configuration catalog.

## Output

Built-ins return complete validated domain output. `ToolRegistry.Materialization.settle` is the only execution and generic model-output bounding boundary and owns managed retention references.

Producer capture limits are separate. For example, Bash keeps `AppProcess.maxOutputBytes` and accurately reports stdout/stderr capture loss, but it does not run model-output truncation or return a managed `outputPath`.

`outputPaths` remains the legacy field name at the event boundary, but new shared-store entries in that field must be opaque `attachment://` references. Never persist the physical content-store path in Session messages, events, or checkpoints.

## Current Gaps

- Plugin boot has not been redesigned to register canonical tools through `Tools.Service`; do not redesign it as part of leaf migrations.
- MCP and future Session-scoped registrations still need an explicit canonical registration design.
