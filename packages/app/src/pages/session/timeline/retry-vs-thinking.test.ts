import { describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"

mock.module("@opencode-ai/ui/message-part", () => ({
  renderable(part: { type: string; text?: string }, showReasoningSummaries = true) {
    if (part.type === "text") return !!part.text?.trim()
    if (part.type === "reasoning") return showReasoningSummaries && !!part.text?.trim()
    return true
  },
  groupParts(refs: { messageID: string; part: { id: string } }[]) {
    return refs.map((ref) => ({
      key: `part:${ref.messageID}:${ref.part.id}`,
      type: "part",
      ref: { messageID: ref.messageID, partID: ref.part.id },
    }))
  },
}))

const { Timeline } = await import("./rows")

const userMessage = {
  id: "user",
  sessionID: "session",
  role: "user",
  time: { created: 1 },
  agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
} as UserMessage

const assistantMessage = {
  id: "assistant",
  sessionID: "session",
  parentID: userMessage.id,
  role: "assistant",
  time: { created: 2 },
  agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
} as unknown as AssistantMessage

// Regression contract for the retry-countdown cutover: the server keeps
// `session.status` on "retry" until the retried provider turn really starts,
// so the timeline must show the retry card and never an empty Thinking bubble
// while only the countdown is running.
describe("Timeline retry vs empty thinking", () => {
  test("renders the Retry row, not an empty Thinking row, while the session status is retry", () => {
    const rows = Timeline.constructMessageRows(
      userMessage,
      () => [] as Part[],
      [assistantMessage],
      0,
      false,
      "retry",
      true,
    )

    expect(rows.map((row) => row._tag)).toEqual(["UserMessage", "Retry"])
  })

  test("renders an empty Thinking row only after real provider progress made the session busy", () => {
    const rows = Timeline.constructMessageRows(
      userMessage,
      () => [] as Part[],
      [assistantMessage],
      0,
      false,
      "busy",
      true,
    )

    expect(rows.map((row) => row._tag)).toEqual(["UserMessage", "Thinking"])
  })

  test("drops the Retry row once the turn settled to idle", () => {
    const rows = Timeline.constructMessageRows(
      userMessage,
      () => [] as Part[],
      [assistantMessage],
      0,
      false,
      "idle",
      true,
    )

    expect(rows.map((row) => row._tag)).toEqual(["UserMessage"])
  })
})
