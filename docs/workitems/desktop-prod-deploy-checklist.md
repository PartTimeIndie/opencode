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

## Native storage-worker verification failures

The storage verifier runs a real Electron-as-Node worker and a nested session
worker against a temporary database. Run `bun run verify:storage-worker-sidecar`
from `packages/desktop` to investigate it without deploying, restarting the
installed app or opening the production database. Keep the original failed log
and distinguish the outer verifier from the nested worker named in its stack.

A native `InitializeBundledRootCertificates` / X509 assertion is not a database
migration validation error. Check the exact Electron/Node versions, inherited
TLS-related environment variable names (never secret values), and available
memory before attributing a cause. A separate local `node:tls` root-certificate
initialization probe needs no network connection. Passing current probes or a
later isolated migration does not establish the historical cause or prove a fix.
Do not disable certificate validation, add automatic retries, skip the verifier
or relabel an old failed/recovering deployment as successful. Run relevant
worker/migration contracts and package typechecks before the next authorized
build; deployed readiness still requires that build's own complete verification.
