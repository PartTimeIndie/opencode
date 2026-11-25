# goal-plugin

In-repo session goal plugin for OpenCode (replaces the external npm
`opencode-goal-plugin`). Loaded via a `file://` plugin entry.

## Behavior

- `/goal <text>` sets the goal (server metadata path), `/goal clear` removes it.
- At each turn boundary (`session.turn.completed`, `session.idle`,
  `session.runner.settled`) the plugin re-syncs from session metadata and
  continues the session via the host prompt API until the model reports
  `[goal:complete]` with a `[goal:evidence]` line, reports `[goal:blocked]`
  with a concrete blocker, or the continuation cap is reached.
- Cap: `maxContinuations` automatic continuations per goal run (default 50).
  Reaching it pauses the goal with stop reason `max-continuations`; the app's
  Continue control resets the counter.
- Pause/Continue run through the `opencode-goal-plugin/control` v1 service
  (used by `POST /app/host/session-goal` and `/goal pause|resume`).

## Removed legacy surface

`/goal add`, `/goal edit`, `/goal sisyphus`, `/goal status`, `/goal history`
have no special handling anymore; such text reaches the model like any other
input. The goal dock, pause/continue and `/goal <text>|clear` are unchanged.

## Host contracts and safety

- The default export is `{ id: "opencode-goal-plugin", server: GoalPlugin }`.
  A legacy function-only file export would receive a generated identity and
  would break the app's fixed control-service address. The named `GoalPlugin`
  function remains available for tests.
- Only the host prompt bridge admits automatic inputs. The Session operation
  lock fences the inbox head, Goal text, run ID and exact prior serialized
  status. Admission and the host-generated `active.promptID` receipt commit in
  one transaction. A typed busy refusal retains demand for a real settlement
  event; an ambiguous transport failure pauses rather than retries.
- Status projection uses `goalOwnership.project` compare-and-patch with the
  same Goal/run/prior-status identity. It cannot overwrite a replacement or
  recreate cleared state. Older hosts without this API are not compatible.
- The command metadata setter assigns a fresh run ID in the same patch as
  the goal text and removes old status. Setting the same text again is a new
  run. The Server applies this patch only on the command's first durable
  admission; an exact message-ID retry cannot regenerate a run or erase a
  newer Goal. A conflicting retry is rejected. Clear removes all three keys.
  Do not reintroduce a text-only setter or bootstrap identity with an unguarded
  plugin read/write sequence.
- Evidence comes from the exact input's host execution view, including earlier
  assistant/tool steps. Unrelated history never supplies completion markers.
  Pending questions, newer admissions and failed tools prevent completion.
- Successful completion uses run-bound ownership clear. This atomically
  removes goal, run and status; the plugin does not recreate an orphaned
  `achieved` status afterward.
- Pause/resume share a serialized session lane with admission. A pause
  invalidates an awaiting pre-admission check. Operation receipts are capped
  at 128 per run. Failed persistence keeps runtime stopped and permits repair
  with the original operation ID and revision. Queued cancelled controls and
  unloaded services cannot start new admission.
- Paused state, revision, continuation count and active receipt are restored
  from validated matching-run metadata after reload. Before consuming evidence,
  the receipt's input origin must be host-attested `plugin`. Failed/interrupted
  continuations pause until explicit Continue; malformed saved state pauses
  rather than gaining working authority.

## Verification

From `packages/goal-plugin`: `bun test` and `bun typecheck`.
The typecheck uses the workspace's existing Bun types; no package installation
is needed in this checkout. After normal workspace installation, local
`@types/bun` takes precedence.

The real-module contract test is
`packages/opencode/test/server/goal-plugin-contract.test.ts`. Run it from
`packages/opencode`, alongside `test/server/httpapi-plugin-services.test.ts`.
Run `test/session-turn-continuation.test.ts` from `packages/core` (not opencode).
App submit and mocked desktop/mobile toolbar tests remain unchanged.

## Migration

After verification and implementation review, replace the existing plugin
entry, rather than adding a second entry:

```json
["file:///E:/GitRepros/opencode/packages/goal-plugin", { "maxContinuations": 50 }]
```

Options are forwarded by the file loader; omitting them keeps the default cap
of 50. Record the exact old npm entry before changing config so rollback can
restore it without guessing. Activation requires the next plugin load; a source
test or config edit does not prove installed activation. Do not stop/restart the
app as part of this migration without explicit permission.

The installed host must contain the atomic Goal setter, exactly-once command
admission, run/status admission fence, `goalOwnership.project` CAS and atomic
active-receipt persistence described above. Loading this source plugin by file
URL does **not** deploy Host/Core/Server code. Keep the old config until the
installed contract is verified or a separately approved complete deployment
ships it. Source and mocked toolbar tests do not prove a real backend Goal
lifecycle or installed activation.

Keep both old installations until activation is confirmed. Removing either
`~/.config/opencode/node_modules/opencode-goal-plugin` or the external source
checkout requires separate approval.
