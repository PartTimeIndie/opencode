# Public read-only session context

App plugins can declare `host:session-context` and call
`api.host.sessions.context({ directory, sessionID, limit?, maxTextChars?, signal? })`.
This is an additive app API v2 capability available to **every app plugin**;
neither the plugin ID nor the spoken-summary plugin is special-cased.
`host:sessions` does not implicitly grant it, and the capability grants no
prompt, interrupt, permission reply, question reply or navigation mutation.

## Ownership and entry points

- Public types: `packages/plugin/src/app.ts`, backed by the generated JS SDK.
- Projection/schema: `packages/core/src/session/plugin-context.ts`.
- Authenticated transport: `pluginServices.sessionContext`,
  `POST /app/host/session-context`, in the existing PluginServices HttpApi.
- Browser binding: `packages/app/src/plugin/app-runtime.tsx`.
- Reference consumer: `.opencode/plugin-sources/spoken-summary-app`.

The browser supplies its registered manifest ID/version/hash; the server checks
that identity and capability and rejects foreign session directories/workspaces.
Responses use `Cache-Control: no-store`. Plugins must not construct caller
identities, access host internals, scrape Question DOM, or use a private service
as a substitute for this public contract.

## Contract

Success is `{ ok: true, context }`. Host failures return
`{ ok: false, error: { code, message } }`, with `forbidden`, `not_found`,
`invalid_input`, `unavailable`, or `aborted`. The HTTP transport uses typed
400/403/503 errors; the host binding maps them to the plugin result and never
converts an unavailable read to an apparently empty chat.

Version 1 contains session identity, captured time, a content fingerprint,
activity status/liveness/sequence boundaries, selected visible messages,
active native questions, runtime permission requests, optional interactive
controls, counts and explicit truncation flags. Passive informational surfaces
are not pending decisions. Completed/rejected/orphaned/queued questions are
excluded; a still-active question remains visible even with an expired runner
lease. Only active state is read: **do not use `QuestionV2.list()`**, since that
method reconciles orphans and can write. Reads must not repair or settle state.

The window includes the triggering user prompt *before* activity opening and
the newest user/assistant evidence thereafter. Without usable activity metadata,
the last real user turn is the explicit fallback. The freshest result has
priority; a 200-message ceiling never loses it in favor of the oldest page.
Use `boundaryComplete`, `totals` and `truncated`, not idle status alone, to judge
whether the evidence is complete. `working` describes a currently live lease;
the stored terminal status remains distinct from success claims in prose.

Defaults: 80 messages / 24,000 visible characters. Maximums: 200 messages /
48,000 visible characters, and 32 pending entries. Oversized transport requests
are rejected. The shared character budget covers visible question/form context
first, then newest result text; truncation is explicit. Multi-question requests
and their options/form fields are independently bounded. A fingerprint excludes
capture time and includes visible content, request revisions, activity and
permissions. It is a change detector, **not a lock or an authorization token**.

Reasoning, raw tool outputs, files/media, hidden form labels, default/current
form values, private metadata, executable action payloads and credentials are
not projected. Markdown body/section content and ordinary labels are visible
data and can themselves be sensitive. Consumers choose the model/provider
deliberately and must not claim visible chat text is guaranteed secret-free.

## Minimal consumer

```ts
const result = await api.host.sessions.context({ directory, sessionID, signal })
if (!result.ok) {
  // Surface the specific error; never pretend the session is empty.
  return
}
const context = result.context
// Operate only on this captured session, and re-read the fingerprint before
// presenting a delayed result involving a pending question or permission.
```

Independent consumers with IDs `neutral-alpha` and `neutral-beta` are covered by
`packages/opencode/test/server/httpapi-session-context.test.ts`, including a
third plugin with only `host:sessions`, forged hashes and foreign directories.
Core tests exercise actual SQLite selection, visible-only projection and
unchanged question state. New consumers must retain these safety boundaries.

## Lifecycle and delivery

Calls combine the consumer AbortSignal with the plugin scope signal. Server
switch or plugin unload aborts the scope; switching ordinary session tabs does
not transfer the captured source identity. New plugins should feature-detect
the additive method and report a required host update, not bypass capabilities.

Deploy the host, SDK and plugin artifact together through the full prod desktop
workflow. Source/runtime sync alone is not evidence that the installed app has
the new API. Process close/restart always needs current explicit permission.
