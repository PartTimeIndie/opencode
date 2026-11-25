import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2/client"

/** Presentation only: the durable source remains a system message, never user authority. */
export function recoveryNotice(sessionID: string, input: { id: string; text: string; time: { created: number } }, parentID: string) {
  const message: AssistantMessage = {
    id: input.id, sessionID, parentID, role: "assistant", agent: "system", mode: "system",
    modelID: "", providerID: "", path: { cwd: "", root: "" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: input.time.created, completed: input.time.created }, finish: "stop",
  }
  const parts: Part[] = [{ id: `${input.id}:notice`, sessionID, messageID: input.id, type: "text", text: `Systemhinweis: ${input.text}` }]
  return { message, parts }
}
