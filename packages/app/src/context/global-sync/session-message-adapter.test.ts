import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@opencode-ai/sdk/v2/client"
import { adaptSessionMessages, needsOlderSessionMessageContext } from "./session-message-adapter"

describe("session message adapter", () => {
  test("maps V2 user and assistant messages into timeline messages and parts", () => {
    const result = adaptSessionMessages("ses_1", [
      {
        id: "msg_1",
        type: "model-switched",
        time: { created: 1 },
        model: { providerID: "openai", id: "gpt-5.5", variant: "fast" },
      },
      { id: "msg_2", type: "agent-switched", time: { created: 2 }, agent: "build" },
      { id: "msg_3", type: "user", time: { created: 3 }, text: "hello" },
      {
        id: "msg_4",
        type: "assistant",
        time: { created: 4, completed: 5 },
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.5", variant: "fast" },
        content: [{ id: "part_1", type: "text", text: "hi" }],
        cost: 0.1,
        tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
      },
    ] satisfies SessionMessage[])

    expect(result.messages.map((message) => [message.id, message.role])).toEqual([
      ["msg_3", "user"],
      ["msg_4", "assistant"],
    ])
    expect(result.messages[0]).toMatchObject({ agent: "build", model: { providerID: "openai", modelID: "gpt-5.5" } })
    expect(result.messages[1]).toMatchObject({ parentID: "msg_3", providerID: "openai", modelID: "gpt-5.5" })
    expect(result.parts.map((item) => [item.id, item.part.map((part) => part.type)])).toEqual([
      ["msg_3", ["text"]],
      ["msg_4", ["text"]],
    ])
  })

  test("parents assistants to the latest chronological user across mixed ID generations", () => {
    const input = [
      { id: "msg_06d8e45f2001F5K1Hrks6Vfk9F", type: "user", time: { created: 1788544435744 }, text: "first resume" },
      { id: "msg_06da7942d001gZ4lUKMCOdb3m9", type: "user", time: { created: 1788546145359 }, text: "latest resume" },
      {
        id: "msg_06db2f832001gcUXbdxJwK1vkJ",
        type: "assistant",
        time: { created: 1788546145360 },
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.6-sol" },
        content: [{ id: "part_latest", type: "text", text: "latest output" }],
      },
      { id: "msg_80daf1f1f62f000994c26e3603", type: "user", time: { created: 1788418804026 }, text: "root" },
    ] satisfies SessionMessage[]
    const ids = input.map((message) => message.id)

    const result = adaptSessionMessages("ses_1", input)

    expect(result.messages.map((message) => message.id)).toEqual([
      "msg_80daf1f1f62f000994c26e3603",
      "msg_06d8e45f2001F5K1Hrks6Vfk9F",
      "msg_06da7942d001gZ4lUKMCOdb3m9",
      "msg_06db2f832001gcUXbdxJwK1vkJ",
    ])
    expect(result.messages.at(-1)).toMatchObject({
      role: "assistant",
      parentID: "msg_06da7942d001gZ4lUKMCOdb3m9",
    })
    expect(input.map((message) => message.id)).toEqual(ids)
  })

  test("does not expose system context as a user turn", () => {
    const result = adaptSessionMessages("ses_1", [
      { id: "msg_1", type: "user", time: { created: 1 }, text: "hello" },
      { id: "msg_2", type: "system", time: { created: 2 }, text: "context" },
      {
        id: "msg_3",
        type: "assistant",
        time: { created: 3 },
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.5" },
        content: [{ id: "part_1", type: "text", text: "hi" }],
      },
    ] satisfies SessionMessage[])

    expect(result.messages.map((message) => [message.id, message.role])).toEqual([
      ["msg_1", "user"],
      ["msg_3", "assistant"],
    ])
    expect(result.messages[1]).toMatchObject({ parentID: "msg_1" })
  })

  test("keeps assistant auth errors renderable even when historical fields are incomplete", () => {
    const result = adaptSessionMessages("ses_1", [
      { id: "msg_1", type: "user", time: { created: 1 }, text: "hello" },
      {
        id: "msg_2",
        type: "assistant",
        time: { created: 2, completed: 3 },
        agent: "build",
        error: { name: "ProviderAuthError", message: "invalid_request_error: Missing bearer or basic authentication in header" },
      },
    ] as SessionMessage[])

    expect(result.messages.map((message) => [message.id, message.role])).toEqual([
      ["msg_1", "user"],
      ["msg_2", "assistant"],
    ])
    expect(result.messages[1]).toMatchObject({
      error: {
        data: {
          message: "invalid_request_error: Missing bearer or basic authentication in header",
        },
      },
      modelID: "",
      parentID: "msg_1",
      providerID: "",
    })
  })

  test("preserves typed failure metadata for the timeline error card", () => {
    const result = adaptSessionMessages("ses_1", [
      { id: "msg_1", type: "user", time: { created: 1 }, text: "hello" },
      {
        id: "msg_2",
        type: "assistant",
        time: { created: 2, completed: 3 },
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.5" },
        content: [],
        error: { type: "unknown", message: "Error: Integration.Authorization\n    at app.asar/dist/server.js:123:45" },
        failure: {
          code: "provider.transport",
          message: "The provider stream or request failed before completion.",
          retryability: "auto-retry",
          remediation: "retry",
        },
      },
    ] satisfies SessionMessage[])

    expect(result.messages[1]).toMatchObject({
      error: {
        data: {
          code: "provider.transport",
          message: "The provider stream or request failed before completion.",
          remediation: "retry",
        },
      },
    })
  })

  test("renders a failure-only assistant message as a timeline error", () => {
    const result = adaptSessionMessages("ses_1", [
      { id: "msg_1", type: "user", time: { created: 1 }, text: "hello" },
      {
        id: "msg_2",
        type: "assistant",
        time: { created: 2, completed: 3 },
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.5" },
        content: [],
        failure: {
          code: "provider.transport",
          message: "The provider stream or request failed before completion.",
          retryability: "auto-retry",
          remediation: "retry",
        },
      },
    ] satisfies SessionMessage[])

    expect(result.messages[1]).toMatchObject({
      error: {
        data: {
          code: "provider.transport",
          message: "The provider stream or request failed before completion.",
          remediation: "retry",
        },
      },
    })
  })

  test("keeps canonical task output fields as tool metadata without exposing arbitrary structured output", () => {
    const result = adaptSessionMessages("ses_parent", [
      { id: "msg_1", type: "user", time: { created: 1 }, text: "Run the repeated task." },
      {
        id: "msg_2",
        type: "assistant",
        time: { created: 2, completed: 3 },
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.6" },
        content: [
          {
            id: "part_task",
            type: "tool",
            name: "task",
            state: {
              status: "completed",
              input: { description: "Repeated description", subagent_type: "research" },
              content: [{ type: "text", text: "Done." }],
              structured: {
                task_id: "ses_child_exact",
                sessionID: "ses_child_exact",
                background: true,
                state: "completed",
                ignored: { sessionID: "ses_child_wrong" },
              },
            },
            provider: { executed: false, resultMetadata: { provider: { traceID: "trace_1" } } },
            time: { created: 2, ran: 2, completed: 3 },
          },
        ],
      },
    ] satisfies SessionMessage[])

    const task = result.parts[1]?.part[0]
    expect(task?.type).toBe("tool")
    if (task?.type !== "tool" || task.state.status !== "completed") throw new Error("Expected completed task part")
    expect(task.state.metadata).toEqual({
      provider: { traceID: "trace_1" },
      task_id: "ses_child_exact",
      sessionID: "ses_child_exact",
      background: true,
      state: "completed",
    })
    expect(task.state.metadata).not.toHaveProperty("ignored")
  })

  test("detects when a page starts inside an assistant turn", () => {
    expect(
      needsOlderSessionMessageContext([
        {
          id: "msg_2",
          type: "assistant",
          time: { created: 2 },
          agent: "build",
          model: { providerID: "openai", id: "gpt-5.5" },
          content: [{ id: "part_1", type: "text", text: "hi" }],
        },
        { id: "msg_3", type: "user", time: { created: 3 }, text: "next" },
      ] satisfies SessionMessage[]),
    ).toBe(true)

    expect(
      needsOlderSessionMessageContext([
        { id: "msg_1", type: "user", time: { created: 1 }, text: "hello" },
        {
          id: "msg_2",
          type: "assistant",
          time: { created: 2 },
          agent: "build",
          model: { providerID: "openai", id: "gpt-5.5" },
          content: [{ id: "part_1", type: "text", text: "hi" }],
        },
      ] satisfies SessionMessage[]),
    ).toBe(false)
  })
})
