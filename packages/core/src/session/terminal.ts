export * as SessionTerminal from "./terminal"

export type Result = "done" | "incomplete"

/**
 * Classifies the durable evidence of one assistant provider turn without
 * asking another model. An absent/unfinished step stays undecided so callers
 * can keep their existing evaluator or recovery policy.
 */
export function assistantResult(assistant: unknown): Result | undefined {
  if (!isRecord(assistant)) return
  const evidence = isRecord(assistant.info) ? assistant.info : assistant
  if (evidence.error !== undefined) return "incomplete"

  const finish = evidence.finish
  if (typeof finish !== "string") return
  if (finish !== "stop" && finish !== "tool-calls") return "incomplete"

  const content = Array.isArray(assistant.content)
    ? assistant.content
    : Array.isArray(assistant.parts)
      ? assistant.parts
      : []
  const tools = content.filter(isTool)
  if (tools.some((part) => toolResult(part) !== "completed")) return "incomplete"

  const meaningful = content.some((part) => {
    if (!isRecord(part)) return false
    if (part.type === "text") return typeof part.text === "string" && part.text.trim().length > 0
    if (part.type === "tool") return toolResult(part) === "completed"
    return ["custom", "subtask", "file", "patch", "agent"].includes(String(part.type))
  })
  return meaningful ? "done" : "incomplete"
}

function isTool(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === "tool"
}

function toolResult(part: Record<string, unknown>) {
  if (!isRecord(part.state)) return
  return part.state.status
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
