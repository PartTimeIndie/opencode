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

function failedAssistant(id: string) {
  return {
    ...assistantMessage,
    id,
    error: {
      name: "UnknownError",
      data: {
        message: "The provider stream or request failed before completion.",
        code: "provider.transport",
        remediation: "retry",
      },
    },
  } as AssistantMessage
}

function textPart(id: string, messageID: string, text: string) {
  return { id, sessionID: "session", messageID, type: "text", text } as Part
}

describe("Timeline.constructMessageRows", () => {
  test("does not append Thinking when active assistant text is visible", () => {
    const rows = Timeline.constructMessageRows(
      userMessage,
      (messageID) =>
        messageID === assistantMessage.id
          ? ([
              {
                id: "part",
                sessionID: "session",
                messageID: assistantMessage.id,
                type: "text",
                text: "visible streamed text",
              },
            ] as Part[])
          : [],
      [assistantMessage],
      0,
      false,
      "busy",
      true,
    )

    expect(rows.map((row) => row._tag)).toEqual(["UserMessage", "AssistantPart"])
  })

  test("shows Thinking while the active assistant has no visible text yet", () => {
    const rows = Timeline.constructMessageRows(userMessage, () => [], [assistantMessage], 0, false, "busy", true)

    expect(rows.map((row) => row._tag)).toEqual(["UserMessage", "Thinking"])
  })

  test("keeps the active thinking indicator mounted as tools appear and disappear", () => {
    const tool = {
      id: "tool",
      sessionID: "session",
      messageID: assistantMessage.id,
      type: "tool",
      tool: "read",
      callID: "call",
      state: { status: "running", input: {} },
    } as Part
    const tags = (parts: Part[]) =>
      Timeline.constructMessageRows(
        userMessage,
        (id) => (id === assistantMessage.id ? parts : []),
        [assistantMessage],
        0,
        false,
        "busy",
        true,
      ).map((row) => row._tag)

    expect(tags([])).toEqual(["UserMessage", "Thinking"])
    expect(tags([tool])).toEqual(["UserMessage", "AssistantPart", "Thinking"])
    expect(tags([])).toEqual(["UserMessage", "Thinking"])
  })
})

describe("Timeline error placement", () => {
  test("places a provider error inline after the failed attempt, above later retry output", () => {
    const failed = failedAssistant("assistant-failed")
    const retry = { ...assistantMessage, id: "assistant-retry" } as AssistantMessage
    const rows = Timeline.constructMessageRows(
      userMessage,
      (messageID) =>
        messageID === failed.id
          ? [textPart("part-failed", failed.id, "output before the transport dropped")]
          : messageID === retry.id
            ? [textPart("part-retry", retry.id, "output from the successful retry")]
            : [],
      [failed, retry],
      0,
      false,
      "idle",
      false,
    )

    expect(rows.map((row) => row._tag)).toEqual(["UserMessage", "AssistantPart", "Error", "AssistantPart"])
    expect(rows[2]).toMatchObject({
      _tag: "Error",
      assistantMessageID: failed.id,
      code: "provider.transport",
      action: "retry",
    })
  })

  test("keeps repeated provider failures as separate rows in chronological order", () => {
    const first = failedAssistant("assistant-failed-1")
    const second = { ...assistantMessage, id: "assistant-retry-1" } as AssistantMessage
    const third = failedAssistant("assistant-failed-2")
    const fourth = { ...assistantMessage, id: "assistant-retry-2" } as AssistantMessage
    const rows = Timeline.constructMessageRows(
      userMessage,
      (messageID) =>
        messageID === second.id
          ? [textPart("part-retry-1", second.id, "first retry output")]
          : messageID === fourth.id
            ? [textPart("part-retry-2", fourth.id, "second retry output")]
            : [],
      [first, second, third, fourth],
      0,
      false,
      "idle",
      false,
    )

    expect(rows.map((row) => row._tag)).toEqual([
      "UserMessage",
      "Error",
      "AssistantPart",
      "Error",
      "AssistantPart",
    ])
    expect(rows.flatMap((row) => (row._tag === "Error" ? [row.assistantMessageID] : []))).toEqual([first.id, third.id])
  })

  test("shows a failure without parts above the interrupted divider of the aborted retry", () => {
    const failed = failedAssistant("assistant-failed")
    const aborted = {
      ...assistantMessage,
      id: "assistant-aborted",
      error: { name: "MessageAbortedError", data: { message: "aborted by user" } },
    } as AssistantMessage
    const after = { ...assistantMessage, id: "assistant-after" } as AssistantMessage
    const rows = Timeline.constructMessageRows(
      userMessage,
      (messageID) => (messageID === after.id ? [textPart("part-after", after.id, "second attempt")] : []),
      [failed, aborted, after],
      0,
      false,
      "idle",
      false,
    )

    expect(rows.map((row) => row._tag)).toEqual([
      "UserMessage",
      "Error",
      "TurnDivider",
      "AssistantPart",
    ])
    expect(rows[1]).toMatchObject({ _tag: "Error", assistantMessageID: failed.id })
  })
})

describe("Timeline error placement", () => {
  test("places a provider error inline after the failed attempt, above later retry output", () => {
    const failed = failedAssistant("assistant-failed")
    const retry = { ...assistantMessage, id: "assistant-retry" } as AssistantMessage
    const rows = Timeline.constructMessageRows(
      userMessage,
      (messageID) =>
        messageID === failed.id
          ? [textPart("part-failed", failed.id, "output before the transport dropped")]
          : messageID === retry.id
            ? [textPart("part-retry", retry.id, "output from the successful retry")]
            : [],
      [failed, retry],
      0,
      false,
      "idle",
      false,
    )

    expect(rows.map((row) => row._tag)).toEqual(["UserMessage", "AssistantPart", "Error", "AssistantPart"])
    expect(rows[2]).toMatchObject({
      _tag: "Error",
      assistantMessageID: failed.id,
      code: "provider.transport",
      action: "retry",
    })
  })

  test("keeps repeated provider failures as separate rows in chronological order", () => {
    const first = failedAssistant("assistant-failed-1")
    const second = { ...assistantMessage, id: "assistant-retry-1" } as AssistantMessage
    const third = failedAssistant("assistant-failed-2")
    const fourth = { ...assistantMessage, id: "assistant-retry-2" } as AssistantMessage
    const rows = Timeline.constructMessageRows(
      userMessage,
      (messageID) =>
        messageID === second.id
          ? [textPart("part-retry-1", second.id, "first retry output")]
          : messageID === fourth.id
            ? [textPart("part-retry-2", fourth.id, "second retry output")]
            : [],
      [first, second, third, fourth],
      0,
      false,
      "idle",
      false,
    )

    expect(rows.map((row) => row._tag)).toEqual([
      "UserMessage",
      "Error",
      "AssistantPart",
      "Error",
      "AssistantPart",
    ])
    expect(rows.flatMap((row) => (row._tag === "Error" ? [row.assistantMessageID] : []))).toEqual([first.id, third.id])
  })

  test("shows a failure without parts above the interrupted divider of the aborted retry", () => {
    const failed = failedAssistant("assistant-failed")
    const aborted = {
      ...assistantMessage,
      id: "assistant-aborted",
      error: { name: "MessageAbortedError", data: { message: "aborted by user" } },
    } as AssistantMessage
    const after = { ...assistantMessage, id: "assistant-after" } as AssistantMessage
    const rows = Timeline.constructMessageRows(
      userMessage,
      (messageID) => (messageID === after.id ? [textPart("part-after", after.id, "second attempt")] : []),
      [failed, aborted, after],
      0,
      false,
      "idle",
      false,
    )

    expect(rows.map((row) => row._tag)).toEqual([
      "UserMessage",
      "Error",
      "TurnDivider",
      "AssistantPart",
    ])
    expect(rows[1]).toMatchObject({ _tag: "Error", assistantMessageID: failed.id })
  })
})
