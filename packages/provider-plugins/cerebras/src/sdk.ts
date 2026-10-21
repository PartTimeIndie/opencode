import type { CerebrasProviderSettings } from "@ai-sdk/cerebras"

/** Keep the SDK serializer's OpenAI-specific fields out of Cerebras requests. */
export async function createSDK(options: CerebrasProviderSettings) {
  const { createCerebras } = await import("@ai-sdk/cerebras")
  const fetcher = options.fetch ?? globalThis.fetch
  return createCerebras({
    ...options,
    fetch: Object.assign(
      (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        fetcher(input, {
          ...init,
          body: typeof init?.body === "string" ? normalizeRequest(init.body) : init?.body,
        }),
      { preconnect: globalThis.fetch.preconnect },
    ),
  })
}

export function normalizeRequest(body: string) {
  // This JSON is produced by the SDK, not user input. Only assistant history is
  // renamed; tool arguments/results and other providers must remain unchanged.
  const request: Record<string, unknown> = JSON.parse(body)
  if (Array.isArray(request.messages)) {
    request.messages = request.messages.map((message: unknown) => {
      if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant")
        return message
      if (!("reasoning_content" in message)) return message
      const result = { ...message, reasoning: "reasoning" in message ? message.reasoning : message.reasoning_content }
      delete result.reasoning_content
      return result
    })
  }
  delete request.stream_options
  delete request.store
  return JSON.stringify(request)
}
