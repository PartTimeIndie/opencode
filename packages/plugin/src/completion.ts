/** A read-only projection for plugin-owned completion requirements. */
export type CompletionInput = {
  sessionID: string
  messages: ReadonlyArray<{
    role: "user" | "assistant"
    text: string
    tools: ReadonlyArray<{ name: string; status: string }>
  }>
  signal: AbortSignal
}

/** Policies may require more work; they cannot bypass host completion checks. */
export type CompletionPolicy = (input: CompletionInput) => Promise<"incomplete" | undefined>
