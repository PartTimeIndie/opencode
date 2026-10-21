# Config reload session interrupt runbook

## Purpose

Config and provider reloads may dispose cached project instances so new turns pick up fresh runtime state. A global instance reload must not abort an active session runner.

## Expected behavior

- `InstanceStore.disposeAll()` disposes cached instance resources with reason `all`.
- `SessionRunState` ignores disposal reasons `all` and `reload`, so active session runners keep their current scope until they finish or are explicitly cancelled.
- Targeted disposal paths such as `InstanceStore.dispose(ctx)` still clear the matching `SessionRunState` and cancel active runners for that instance.

## Regression check

Run from `packages/opencode`:

```sh
bun test --timeout 30000 test/project/instance.test.ts
```

The test `InstanceStore > does not cancel active session runs during global instance disposal` verifies that a running session remains busy after `InstanceStore.disposeAll()` and completes normally after its work is released.

The adjacent tests verify that `InstanceStore.reload(input)` keeps active runs alive while `InstanceStore.dispose(ctx)` still cancels active runs during explicit targeted disposal.

## Triage

If logs show `disposing all instances` followed by `AbortError` in unrelated active sessions:

1. Confirm the abort came from `SessionRunState.disposeState`, not from an explicit user interrupt or targeted session cancellation.
2. Check that `SessionRunState` still treats disposer reasons `all` and `reload` as non-cancelling reloads.
3. Re-run the regression check above before changing reload behavior.
