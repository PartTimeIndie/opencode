import type { ToolPart } from "@opencode-ai/sdk/v2"

export function unemittedTextParts(
  message: { id: string; content: ReadonlyArray<{ id: string; type: string; text?: string }> },
  emitted: ReadonlySet<string>,
) {
  return message.content.filter((part): part is { id: string; type: "text"; text: string } =>
    part.type === "text" && typeof part.text === "string" && !!part.text.trim() &&
    !emitted.has(`${message.id}:${part.id}`),
  )
}

type TurnMessage = {
  id: string
  type: "user" | "assistant"
  time: { created: number }
  content?: Array<{ id: string; type: string; state?: { status?: string } }>
}

/**
 * Return only terminal tool parts produced for one admitted user input.
 *
 * The prompt/command admission response returns the durable user-message ID.
 * The V2 transcript then provides an exact boundary: assistant messages after
 * that user message and before the next user message belong to this turn. This
 * avoids replaying historical parts in resumed sessions and does not depend on
 * an arbitrary oldest-first window.
 */
export function terminalToolPartsForTurn(
  messages: readonly unknown[],
  turnID: string,
  emittedPartIDs: ReadonlySet<string>,
): ToolPart[] {
  const ordered = messages
    .filter((value): value is TurnMessage => Boolean(
      value
      && typeof value === "object"
      && typeof (value as Partial<TurnMessage>).id === "string"
      && ((value as Partial<TurnMessage>).type === "user" || (value as Partial<TurnMessage>).type === "assistant")
      && typeof (value as Partial<TurnMessage>).time?.created === "number",
    ))
    .toSorted((left, right) => left.time.created - right.time.created || left.id.localeCompare(right.id))
  const boundary = ordered.findIndex((message) => message.type === "user" && message.id === turnID)
  if (boundary < 0) return []

  const result: ToolPart[] = []
  for (const message of ordered.slice(boundary + 1)) {
    if (message.type === "user") break
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type !== "tool" || emittedPartIDs.has(part.id)) continue
      if (part.state?.status !== "completed" && part.state?.status !== "error") continue
      result.push(part as ToolPart)
    }
  }
  return result
}
