import { InvalidRequestReason, LLMError, type LLMRequest } from "./schema"

export * as RequestRuntimeContext from "./runtime-context"

// Raw overlays and provider-side history can replace/reorder the typed prompt.
// Refuse them rather than claim late privileged placement we cannot establish.
const promptFields = new Set([
  "input",
  "messages",
  "system",
  "instructions",
  "model",
  "prompt",
  "previous_response_id",
  "previousResponseId",
  "conversation",
  "truncation",
])

export function validate(request: LLMRequest, supported = request.model.route.runtimeContext === "late-system") {
  if (!request.runtimeContext?.length) return undefined
  const message = !supported
    ? "This route does not support privileged runtimeContext after history"
    : Object.keys(request.http?.body ?? {}).some((key) => promptFields.has(key)) ||
        Object.values(request.providerOptions ?? {}).some(
          (options) =>
            Object.keys(options).some((key) => promptFields.has(key)) || options.systemMessageMode === "remove",
        )
      ? "runtimeContext cannot be combined with prompt overrides, removed system messages or provider-side history"
      : undefined
  return message === undefined
    ? undefined
    : new LLMError({
        module: "RequestRuntimeContext",
        method: "validate",
        reason: new InvalidRequestReason({ message, parameter: "runtimeContext" }),
      })
}
