# @opencode-ai/llm

Schema-first LLM core for opencode. One typed request, response, event, and tool language; provider quirks live in adapters, not in calling code.

```ts
import { Effect } from "effect"
import { LLM, LLMClient } from "@opencode-ai/llm"
import { OpenAI } from "@opencode-ai/llm/providers"

const model = OpenAI.configure({ apiKey: process.env.OPENAI_API_KEY }).responses("gpt-4o-mini")

const request = LLM.request({
  model,
  system: "You are concise.",
  prompt: "Say hello in one short sentence.",
  generation: { maxTokens: 40 },
})

const program = Effect.gen(function* () {
  const response = yield* LLMClient.generate(request)
  console.log(response.text)
})
```

Run `LLMClient.stream(request)` instead of `generate` when you want incremental `LLMEvent`s. The event stream is provider-neutral — same shape across OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini, Bedrock Converse, and any OpenAI-compatible deployment.

## Public API

- **`LLM.request({...})`** — build a provider-neutral `LLMRequest`. Accepts ergonomic inputs (`system: string`, `prompt: string`) that normalize into the canonical Schema classes.
- **`LLM.generate` / `LLM.stream`** — re-exported from `LLMClient` for one-import use.
- **`Message.user(...)` / `Message.assistant(...)` / `Message.tool(...)`** — message constructors from the canonical schema model.
- **`Model.make(...)` / `ToolCallPart.make(...)` / `ToolResultPart.make(...)` / `ToolDefinition.make(...)`** — model and tool-related constructors from the canonical schema model.
- **`LLMClient.prepare(request)`** — compile a request through protocol body construction, validation, and HTTP preparation without sending. Useful for inspection and testing.
- **`LLMEvent.is.*`** — typed guards (`is.textDelta`, `is.toolCall`, `is.finish`, …) for filtering streams.

## Structured results

Use `LLM.generateObject({ model, prompt, schema })` for a typed Effect Schema,
or pass `jsonSchema` for a runtime JSON Schema. The helper validates the original
JSON value or tool input before decoding, so a decoder cannot silently remove unexpected
properties. Runtime schemas are copied before the request and unsupported rules
fail before HTTP. A valid result requires exactly one JSON value (native mode) or
one result call (tool mode) and a complete provider finish, not a promise to return JSON later.

Automatic selection uses native JSON only for the direct OpenAI Chat/Responses
and Google Gemini profiles at their canonical endpoints. Protocol wire support
alone does not enable it on compatible hosts, proxies or other provider identities.
Those routes retain their result-tool path. A custom native JSON request remains
an explicit low-level choice, not an automatic enforcement claim.

The helper owns at most one same-model format correction for a missing or invalid
result. `retryCount: 0` disables it; larger values are capped at one. It does not
correct provider refusals, transport failures or interrupted streams. Both turns
retain the same schema and transport: native JSON with no tools, or only the
inert result tool with the same tool choice.
`response` is the final response; `responses` retains the original and corrected
responses separately, and `usage` sums the reported usage of both. Missing usage
fields remain unknown rather than being treated as zero. Do not wrap this helper
in another format-repair loop. The correction explicitly uses zero HTTP retries,
including when the initial request or route has a larger transport budget. A failure
during that correction keeps its original error reason and carries
`structuredOutputCorrectionAttempted: true`; outer model chains must stop rather
than renew the consumed budget through retry or fallback.

The conservative runtime-schema subset supports JSON types, required properties,
enums/constants, arrays, additional-property schemas, schema alternatives and
acyclic local `$ref`/`$defs`/`definitions`. It rejects unknown keywords, unknown
dialects, recursive/external references and non-JSON values. Compilation counts
expanded references, bounds reference depth and enum comparison work, and refuses
excessive complexity before HTTP. Validation has a separate per-result work budget;
exhaustion fails closed with an explicit complexity diagnostic. Diagnostics contain
bounded paths and expectations, not result-value dumps.

Low-level `responseFormat` selects transport, not successful result validation:

- `tool` normalizes to a named result tool without mutating the original request;
  conflicting tool choices or definitions fail before HTTP.
  The existing Responses profile for `opencode-go` explicitly selects `auto`
  instead: the schema is still advertised and checked locally, but the provider
  cannot be claimed to force a result call. Arbitrary compatible endpoints do
  not inherit that exception.
- `json` is serialized by the OpenAI Chat/Responses and Gemini protocols. Gemini
  uses `responseJsonSchema`, without the lossy function-schema projection.
  Protocols without native JSON support refuse this mode; use a result tool.
- Native OpenAI JSON schema requests use `strict: true` only for a conservative
  subset of closed objects with every property required and supported nested
  types. Other supported schemas use `strict: false`; optional fields are never
  made required and open objects are never closed just to enable strict mode.
  Wire support is not proof that an arbitrary deployment or model enforces the
  schema. Callers still own local validation.
- HTTP body overlays cannot replace result schemas, formats or tool choices.
  Conflicting request or route-default overlays fail before HTTP. Ordinary
  generation overlays remain available. Managed request fingerprints include
  the structured transport contract version; old accepted profiles are not upgraded.

`LLM.stream` and `LLM.generate` still perform one provider turn and never start a
format correction themselves. Session runners own their separate durable
execution, correction budget and terminal-success gate.

## Caching

Prompt caching is **on by default**. Every `LLMRequest` resolves to `cache: "auto"` unless the caller opts out with `cache: "none"`. Each protocol translates `CacheHint`s to its wire format (`cache_control` on Anthropic, `cachePoint` on Bedrock; OpenAI and Gemini do implicit caching server-side and don't need inline markers — auto is a no-op there).

### Auto placement

`"auto"` places three breakpoints — last tool definition, last system part, latest user message. The last-user-message boundary is the load-bearing detail: in a tool-use loop, a single user turn expands into many assistant/tool round-trips, all sharing that prefix. Caching at that boundary lets every intra-turn API call hit.

The math justifies the default: Anthropic's 5-minute cache write is 1.25× base, read is 0.1×, so a single reuse within 5 minutes already wins. One-shot completions below the per-model minimum-cacheable-token threshold silently no-op on the wire, so the worst case is harmless.

### Opting out

```ts
LLM.request({
  model,
  system,
  prompt: "one-off question",
  cache: "none",
})
```

### Granular policy

```ts
cache: {
  tools?: boolean,
  system?: boolean,
  messages?: "latest-user-message" | "latest-assistant" | { tail: number },
  ttlSeconds?: number,         // ≥ 3600 → 1h on Anthropic/Bedrock; else 5m
}
```

### Manual hints

Inline `CacheHint` on any text / system / tool / tool-result part overrides automatic placement. The auto policy preserves manual hints; it only fills gaps.

```ts
LLM.request({
  model,
  system: [
    { type: "text", text: "stable system prompt", cache: { type: "ephemeral" } },
  ],
  ...
})
```

### Provider behavior table

| Protocol                | `cache: "auto"`                                                           |
| ----------------------- | ------------------------------------------------------------------------- |
| Anthropic Messages      | emits up to 3 `cache_control` markers (4-breakpoint cap enforced)         |
| Bedrock Converse        | emits up to 3 `cachePoint` blocks (4-breakpoint cap enforced)             |
| OpenAI Chat / Responses | no-op (implicit caching above 1024 tokens)                                |
| Gemini                  | no-op (implicit caching on 2.5+; explicit `CachedContent` is out-of-band) |

Normalized cache usage is read back into `response.usage.cacheReadInputTokens` and `cacheWriteInputTokens` across every provider.

## Providers

Provider facades configure endpoint/auth/deployment details first, then expose model selectors that take only a model or deployment id. The selected model carries the executable route value used at runtime.

```ts
import { OpenAI, CloudflareAIGateway } from "@opencode-ai/llm/providers"

const openai = OpenAI.configure({ apiKey: process.env.OPENAI_API_KEY }).responses("gpt-4o-mini")
const gateway = CloudflareAIGateway.configure({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  gatewayApiKey: process.env.CLOUDFLARE_API_TOKEN,
}).model("workers-ai/@cf/meta/llama-3.1-8b-instruct")
```

Included providers: OpenAI, Anthropic, Google (Gemini), Amazon Bedrock, Azure OpenAI, Cloudflare AI Gateway, Cloudflare Workers AI, GitHub Copilot, OpenRouter, xAI, plus generic OpenAI-compatible helpers for DeepSeek, Cerebras, Groq, Fireworks, Together, etc.

## Provider options & HTTP overlays

Three escape hatches in order of stability:

1. **`generation`** — portable knobs (`maxTokens`, `temperature`, `topP`, `topK`, penalties, seed, stop).
2. **`providerOptions: { <provider>: {...} }`** — typed-at-the-facade provider-specific knobs (OpenAI `promptCacheKey`, Anthropic `thinking`, Gemini `thinkingConfig`, OpenRouter routing).
3. **`http: { body, headers, query }`** — last-resort serializable overlays merged into the final HTTP request. Reach for this only when a stable typed path doesn't yet exist.

Route/provider defaults are overridden by request-level values for each axis.

## Routes

Adding a new model or deployment is usually 5-15 lines using `Route.make({ protocol, endpoint, auth, framing, ... })`. The route owns endpoint/auth/framing and the protocol owns body construction plus stream parsing. Transports are reusable IO templates that receive route endpoint/auth at compile time. Capability/catalog metadata lives outside this low-level package; unsupported request shapes fail during protocol lowering. See `AGENTS.md` for the architectural detail.

## Effect

This package is built on Effect. Public methods return `Effect` or `Stream`; provide `LLMClient.layer` for runtime dispatch and import the provider/protocol modules for the routes you use. The example at `example/tutorial.ts` is a runnable walkthrough.

## See also

- `AGENTS.md` — architecture, route construction, contributor guide
- `example/tutorial.ts` — runnable end-to-end walkthrough
- `test/provider/*.test.ts` — fixture-first protocol tests; `*.recorded.test.ts` files cover live cassettes
