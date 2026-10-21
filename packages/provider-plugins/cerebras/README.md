# cerebras

Independent provider package for public OpenCode Provider API 1. Build with `bun run build`; verify with `bun typecheck`. Configure the package normally in `plugins`; the host resolves its `./provider` export and owns lifecycle, credential permissions, and catalogue validation.

Both the V2 `aisdk.sdk` hook and the legacy transport factory use `src/sdk.ts`.
It corrects the actual SDK-generated request: assistant `reasoning_content`
becomes Cerebras' documented `reasoning`, while `store` and `stream_options`
are omitted. Keep custom fetch, headers, credentials and cancellation intact.
Do not rely only on the legacy message transform: V2 sessions bypass it.
The provider's `requestProfiles` maps configured reasoning efforts into the
SDK's `cerebras` options namespace; verify the actual wire value, not only the
list of selectable variants.

Verify the wire contract with `bun test test/sdk.test.ts` here and
`bun test test/cerebras-session.test.ts` from `packages/core`. The real runner's
durable reasoning/tool continuation is covered by the Cerebras regression in
`packages/core/test/session-runner.test.ts`.

TPM exhaustion is a rate limit, not a context-window overflow. The host SDK
adapter preserves HTTP status and Retry-After; it shares the native HTTP parser
and the activity's five-recovery budget. Auth, invalid requests and exhausted
account quota remain terminal. Provider waits beyond five minutes are deferred,
not shortened. Verify real HTTP, durable failure metadata, tool execution and
cancellation with `bun test test/session-provider-drain.test.ts --test-name-pattern 'provider sdk-' --timeout 120000`
from `packages/core`. This isolated fixture does not touch the installed app or
call the public API.

Cerebras can report a minute limit as `type: too_many_tokens_error`,
`param: quota`, `code: token_quota_exceeded`. The shared host quota classifier
treats that explicit minute window as transient; it must not turn it into
account-quota exhaustion or a Report-only failure. Daily/ambiguous token limits
and explicit account/credit quotas remain terminal. Keep the complete error body
in regression fixtures. The 59/60-second deadline tests live in
`packages/core/test/session-runner.test.ts`; the `native-tpm-tool` drain case
also verifies native HTTP recovery without executing a completed tool twice.

API reference: https://inference-docs.cerebras.ai/api-reference/chat-completions
