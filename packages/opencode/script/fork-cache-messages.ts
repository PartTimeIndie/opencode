import { Message } from "@opencode-ai/llm"

/** Main writes a cache entry at its last user-message boundary. A fork child
 * must retain that exact message and append its own assignment after it. Merely
 * replacing the last message with another shared-prefix variant is not a test
 * of reuse at the provider's implicit cache-write boundary. */
export function cacheComparisonMessages(prefix: string, role: "main" | "child") {
  return [Message.user(prefix), ...(role === "child" ? [Message.user("Child comparison: reply only OK.")] : [])]
}
