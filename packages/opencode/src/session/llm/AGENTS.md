# Session LLM Runtime Boundaries

`../llm.ts` is the opencode session LLM service. It owns opencode concerns: auth, config, model/provider resolution, plugins, permissions, telemetry headers, and runtime selection. It is the only file in this area that should know about the full session request shape.

This folder contains adapters behind that service boundary:

- `ai-sdk.ts` converts AI SDK `fullStream` parts into `@opencode-ai/llm` `LLMEvent`s. This is the explicit fallback runtime path.
- `native-request.ts` converts opencode's normalized session input into a native `@opencode-ai/llm` `LLMRequest`. It does not execute requests.
- `native-runtime.ts` is the native-first runtime adapter. It decides whether a selected model is supported, builds the native request, bridges opencode tools into native executable tools, and delegates transport to `LLMClient` / `RequestExecutor`.

## File Structure

```txt
src/session/
  llm.ts                    session-owned orchestration and runtime selection
  llm/
    AGENTS.md               boundary notes for the adapter layer
    ai-sdk.ts               AI SDK fullStream -> @opencode-ai/llm LLMEvent adapter
    native-request.ts       opencode/AI SDK-shaped input -> @opencode-ai/llm LLMRequest
    native-runtime.ts       native runtime gate, tool bridge, and LLMClient handoff
```

Integration points:

- `../llm.ts` imports `LLMClient` from `@opencode-ai/llm/route`; native execution is the only path that calls it directly.
- `../llm.ts` imports `LLMAISDK` from `./llm/ai-sdk`; the AI SDK path still calls `streamText(...)` locally, then adapts `result.fullStream` into shared `LLMEvent`s.
- `../llm.ts` imports `LLMNativeRuntime` from `./llm/native-runtime`; this is the runtime-selection seam. Unsupported native requests return a reason and fall back to AI SDK.
- `native-runtime.ts` imports `LLMNative` from `./native-request`; this keeps request lowering separate from transport and tool execution.
- `native-request.ts` is the only adapter file that should construct `LLM.request(...)`, `LLM.model(...)`, `Message.*`, `SystemPart`, `ToolCallPart`, `ToolResultPart`, or `ToolDefinition` values from `@opencode-ai/llm`.
- `ai-sdk.ts` and `native-runtime.ts` both emit `@opencode-ai/llm` `LLMEvent`s so downstream session processing does not care which runtime handled the request.

Keep new integration code on one of these seams. Avoid importing session services into `native-request.ts`; pass normalized data through `RequestInput` instead.

## Runtime selection

Both runtimes converge on the same `LLMEvent` stream consumed by the Core V2 `SessionRunner`. The gate is per request: a single Session can route some calls through native and fall back for others. Core owns provider-turn event publication, tool settlement, projected-history reload, and continuation; this adapter layer owns only request lowering, transport selection, and the shared event stream.

```txt
Core SessionRunner
  -> one LLM.Service.stream(...) call for the provider turn
     -> LLM.Service (../llm.ts)
        -> native gate
           -> native-runtime.ts -> native-request.ts -> LLMClient / RequestExecutor
           -> unsupported reason -> AI SDK streamText -> ai-sdk.ts
     <- shared LLMEvent stream
  -> Core SessionEvent publication and ToolRegistry settlement
  -> reload projected history before durable continuation
```

`native-runtime.ts` evaluates the gate and either bridges into `@opencode-ai/llm` or returns control so `llm.ts` can take the AI SDK path. Core owns the Session tool-call lifecycle in both branches; only request lowering and provider transport differ here.

Safety boundary:

- Native is attempted first for every request.
- AI SDK remains the explicit fallback when the native runtime returns an unsupported provider/package/auth reason.
- Native execution currently supports OpenAI, opencode-managed OpenAI-compatible, and Anthropic API-key paths backed by `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, or `@ai-sdk/anthropic` catalog entries.
- Unsupported providers such as Copilot, OAuth without a provider fetch/native token bridge, and missing API-key cases fall back to AI SDK.
