# Desktop Prod Deploy Checklist

This checklist is the contract for the local desktop deploy button and the
matching `packages/opencode` CLI flow.

1. Run the build phase first from `packages/desktop` with
   `OPENCODE_CHANNEL=prod bun run build`. Keep the complete temp log path in the
   status output.
2. Verify `packages/desktop/out/.build-channel` contains `prod`. A missing or
   non-prod marker blocks staging and any installation change.
3. Run the main-bundle guard before packaging completes. It must reject
   `bun:` runtime imports and Bun-only APIs such as `Bun.file`, `Bun.write`,
   `Bun.spawn`, `Bun.sleep`, `Bun.serve`, and `Bun.listen`.
4. Only after a complete `READY` build may the deploy phase ask for explicit
   permission to close `OpenCode.exe`. Until that approval exists, no ASAR or
   installation path is replaced.
5. A failed build or guard failure reports the last relevant output tail and the
   full log path, leaves `OpenCode.exe` running, and does not start the deploy
   worker.
6. A successful deploy report must include the prod marker path, backup path,
   and deployed ASAR version, represented by the staged artifact SHA-256.
