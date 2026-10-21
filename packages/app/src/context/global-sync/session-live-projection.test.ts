import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { createSessionLiveProjection, type LiveProjectionAction } from "./session-live-projection"
import { mergePartsPreservingText } from "./session-message-window"

function harness() {
  const sessionID = "ses_1"
  const store = {
    message: {
      [sessionID]: [
        {
          id: "msg_user",
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.5" },
        },
      ] as Message[],
    } as Record<string, Message[] | undefined>,
    part: {} as Record<string, Part[] | undefined>,
  }
  const controller = createSessionLiveProjection()
  const apply = (action: LiveProjectionAction | undefined) => {
    if (!action || action.kind === "handled") return action
    if (action.kind === "message") {
      const messages = store.message[action.sessionID] ?? []
      const index = messages.findIndex((message) => message.id === action.message.id)
      if (index >= 0) messages[index] = action.message
      else messages.push(action.message)
      store.message[action.sessionID] = messages
      for (const part of action.parts ?? []) {
        const parts = store.part[action.message.id] ?? []
        const partIndex = parts.findIndex((item) => item.id === part.id)
        if (partIndex >= 0) parts[partIndex] = part
        else parts.push(part)
        store.part[action.message.id] = parts
      }
      return action
    }
    const parts = store.part[action.messageID] ?? []
    const index = parts.findIndex((part) => part.id === action.part.id)
    if (index >= 0) parts[index] = action.part
    else parts.push(action.part)
    store.part[action.messageID] = parts
    return action
  }
  const dispatch = (id: string, type: string, data: Record<string, unknown>) =>
    apply(controller.handle({ id, type, data: { sessionID, ...data } }, store))
  return { controller, dispatch, sessionID, store }
}

function startRunningTool(test: ReturnType<typeof harness>) {
  test.dispatch("evt_step", "session.next.step.started", {
    timestamp: 2,
    assistantMessageID: "msg_assistant",
    agent: "build",
    model: { providerID: "openai", id: "gpt-5.5" },
  })
  test.dispatch("evt_tool_called", "session.next.tool.called", {
    timestamp: 3,
    assistantMessageID: "msg_assistant",
    callID: "call_1",
    tool: "read",
    input: { path: "README.md" },
    provider: { executed: false },
  })
}

describe("session live projection", () => {
  test("reconciles externalized clipboard files when the promotion arrives before a page refresh", () => {
    const test = harness()
    const aliases: Part[] = [0, 1].map((index) => ({
      id: `prt_alias_${index}`, sessionID: test.sessionID, messageID: "msg_user", type: "file",
      mime: "image/png", filename: "image.png", url: `data:image/png;base64,${index}`,
    }))
    test.store.part.msg_user = aliases
    const action = test.controller.handle({
      id: "evt_promoted", type: "session.next.prompt.promoted", data: {
        sessionID: test.sessionID, messageID: "msg_user", timestamp: 2,
        prompt: { text: "Inspect these images", files: [0, 1].map((index) => ({
          uri: `attachment://att_${index}`, mime: "image/png", name: "image.png",
        })) },
      },
    }, test.store)
    expect(action?.kind).toBe("message")
    if (action?.kind !== "message") throw new Error("promoted user message required")
    const parts = mergePartsPreservingText(aliases, action.parts ?? [], {})
    expect(parts.filter((part) => part.type === "file").map((part) => part.id)).toEqual([
      "msg_user:file:0", "msg_user:file:1",
    ])
  })

  test.each(["step", "shell", "promoted"])(
    "resumes %s from the latest chronological user in an ID-sorted store",
    (kind) => {
      const test = harness()
      const root = {
        ...test.store.message[test.sessionID]![0]!,
        id: "msg_80daf1f1f62f000994c26e3603",
        time: { created: 1788418804026 },
      } as Message
      const resumed = {
        ...root,
        id: "msg_06d8e45f2001F5K1Hrks6Vfk9F",
        time: { created: 1788544435744 },
        agent: "review",
        model: { providerID: "openai", modelID: "gpt-6-astra", variant: "low" },
      } as Message
      const latest = {
        ...root,
        id: "msg_06da7942d001gZ4lUKMCOdb3m9",
        time: { created: 1788546145359 },
        agent: "plan",
        model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" },
      } as Message
      test.store.message[test.sessionID] = [resumed, latest, root]

      const action =
        kind === "step"
          ? test.dispatch("evt_resume", "session.next.step.started", {
              timestamp: 1788544435745,
              assistantMessageID: "msg_new_assistant",
            })
          : kind === "shell"
            ? test.dispatch("evt_resume", "session.next.shell.started", {
                timestamp: 1788544435745,
                messageID: "msg_new_shell",
                callID: "call_resume",
                command: "git status",
              })
            : test.dispatch("evt_resume", "session.next.prompt.promoted", {
                timestamp: 1788544435745,
                messageID: "msg_new_prompt",
                prompt: { text: "continue the morning review" },
              })

      expect(action).toMatchObject({
        kind: "message",
        message:
          kind === "step"
            ? { role: "assistant", parentID: latest.id }
            : { role: "user", agent: "plan", model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" } },
      })
    },
  )

  test("projects a promoted prompt before its assistant starts in an old session", () => {
    const test = harness()
    test.dispatch("evt_promoted", "session.next.prompt.promoted", {
      timestamp: 2,
      messageID: "msg_promoted",
      timeCreated: 2,
      prompt: {
        text: "continue the old session",
        files: [{ uri: "file:///tmp/context.txt", mime: "text/plain", name: "context.txt" }],
      },
    })

    expect(test.store.message[test.sessionID]?.map((message) => message.id)).toEqual(["msg_user", "msg_promoted"])
    expect(test.store.part.msg_promoted).toMatchObject([
      { id: "msg_promoted:text", type: "text", text: "continue the old session" },
      { id: "msg_promoted:file:0", type: "file", filename: "context.txt" },
    ])

    test.dispatch("evt_step", "session.next.step.started", {
      timestamp: 3,
      assistantMessageID: "msg_assistant",
      agent: "build",
      model: { providerID: "openai", id: "gpt-5.5" },
    })

    expect(test.store.message[test.sessionID]?.at(-1)).toMatchObject({
      id: "msg_assistant",
      role: "assistant",
      parentID: "msg_promoted",
    })
  })

  test("does not duplicate an optimistic prompt when its promotion arrives", () => {
    const test = harness()
    test.store.message[test.sessionID]!.push({
      id: "msg_promoted",
      sessionID: test.sessionID,
      role: "user",
      time: { created: 2 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.5" },
    })
    test.store.part.msg_promoted = [
      {
        id: "part_optimistic",
        sessionID: test.sessionID,
        messageID: "msg_promoted",
        type: "text",
        text: "continue the old session",
      },
    ]

    expect(
      test.controller.handle(
        {
          id: "evt_promoted",
          type: "session.next.prompt.promoted",
          data: {
            sessionID: test.sessionID,
            timestamp: 3,
            messageID: "msg_promoted",
            timeCreated: 2,
            prompt: { text: "continue the old session" },
          },
        },
        test.store,
      ),
    ).toEqual({ kind: "handled", sessionID: test.sessionID })
    expect(test.store.part.msg_promoted).toHaveLength(1)
  })

  test("adds only missing promoted parts to an optimistic prompt", () => {
    const test = harness()
    test.store.message[test.sessionID]!.push({
      id: "msg_promoted",
      sessionID: test.sessionID,
      role: "user",
      time: { created: 2 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.5" },
    })
    test.store.part.msg_promoted = [
      {
        id: "msg_promoted:text",
        sessionID: test.sessionID,
        messageID: "msg_promoted",
        type: "text",
        text: "continue the old session",
      },
    ]

    expect(
      test.dispatch("evt_promoted", "session.next.prompt.promoted", {
        timestamp: 2,
        messageID: "msg_promoted",
        timeCreated: 2,
        prompt: {
          text: "continue the old session",
          files: [{ uri: "file:///tmp/context.txt", mime: "text/plain", name: "context.txt" }],
        },
      }),
    ).toMatchObject({ kind: "message", parts: [{ id: "msg_promoted:file:0", type: "file" }] })
    expect(test.store.message[test.sessionID]?.filter((message) => message.id === "msg_promoted")).toHaveLength(1)
    expect(test.store.part.msg_promoted?.map((part) => part.id)).toEqual(["msg_promoted:text", "msg_promoted:file:0"])
  })

  test("reconciles stale optimistic metadata when its promotion arrives", () => {
    const test = harness()
    test.store.message[test.sessionID]!.push({
      id: "msg_promoted",
      sessionID: test.sessionID,
      role: "user",
      time: { created: 2 },
      agent: "assistant",
      model: { providerID: "openai", modelID: "gpt-6-astra" },
    })
    test.store.part.msg_promoted = [
      {
        id: "msg_promoted:text",
        sessionID: test.sessionID,
        messageID: "msg_promoted",
        type: "text",
        text: "continue the old session",
      },
    ]

    expect(
      test.dispatch("evt_promoted", "session.next.prompt.promoted", {
        timestamp: 3,
        messageID: "msg_promoted",
        timeCreated: 2,
        prompt: {
          text: "continue the old session",
          agent: "build",
          model: {
            providerID: "zhipuai-coding-plan",
            id: "glm-5.3-flash",
            chain: { name: "GLM - Codex", active: 0 },
          },
        },
      }),
    ).toMatchObject({
      kind: "message",
      message: {
        id: "msg_promoted",
        agent: "build",
        model: { providerID: "zhipuai-coding-plan", modelID: "glm-5.3-flash" },
      },
    })
    expect(test.store.message[test.sessionID]?.filter((message) => message.id === "msg_promoted")).toHaveLength(1)
    expect(test.store.message[test.sessionID]?.at(-1)).toMatchObject({
      agent: "build",
      model: { providerID: "zhipuai-coding-plan", modelID: "glm-5.3-flash" },
    })
    expect(test.store.part.msg_promoted?.map((part) => part.id)).toEqual(["msg_promoted:text"])
  })

  test("reconciles stale optimistic metadata while adding missing text and file parts", () => {
    const test = harness()
    test.store.message[test.sessionID]!.push({
      id: "msg_promoted",
      sessionID: test.sessionID,
      role: "user",
      time: { created: 2 },
      agent: "assistant",
      model: { providerID: "openai", modelID: "gpt-6-astra" },
    })
    test.store.part.msg_promoted = []

    expect(
      test.dispatch("evt_promoted", "session.next.prompt.promoted", {
        timestamp: 2,
        messageID: "msg_promoted",
        timeCreated: 2,
        prompt: {
          text: "continue the old session",
          files: [{ uri: "file:///tmp/context.txt", mime: "text/plain", name: "context.txt" }],
          agent: "build",
          model: { providerID: "zhipuai-coding-plan", id: "glm-5.3-flash" },
        },
      }),
    ).toMatchObject({
      kind: "message",
      message: {
        id: "msg_promoted",
        agent: "build",
        model: { providerID: "zhipuai-coding-plan", modelID: "glm-5.3-flash" },
      },
      parts: [
        { id: "msg_promoted:text", type: "text" },
        { id: "msg_promoted:file:0", type: "file" },
      ],
    })
    expect(test.store.message[test.sessionID]?.filter((message) => message.id === "msg_promoted")).toHaveLength(1)
    expect(test.store.message[test.sessionID]?.at(-1)).toMatchObject({
      agent: "build",
      model: { providerID: "zhipuai-coding-plan", modelID: "glm-5.3-flash" },
    })
    expect(test.store.part.msg_promoted?.map((part) => part.id)).toEqual(["msg_promoted:text", "msg_promoted:file:0"])
  })

  test("keeps existing metadata when the promoted prompt carries none", () => {
    const test = harness()
    test.store.message[test.sessionID]!.push({
      id: "msg_promoted",
      sessionID: test.sessionID,
      role: "user",
      time: { created: 2 },
      agent: "build",
      model: { providerID: "zhipuai-coding-plan", modelID: "glm-5.3-flash" },
    })
    test.store.part.msg_promoted = [
      {
        id: "msg_promoted:text",
        sessionID: test.sessionID,
        messageID: "msg_promoted",
        type: "text",
        text: "continue the old session",
      },
    ]

    expect(
      test.dispatch("evt_promoted", "session.next.prompt.promoted", {
        timestamp: 3,
        messageID: "msg_promoted",
        timeCreated: 2,
        prompt: { text: "continue the old session" },
      }),
    ).toEqual({ kind: "handled", sessionID: test.sessionID })
    expect(test.store.message[test.sessionID]?.at(-1)).toMatchObject({
      agent: "build",
      model: { providerID: "zhipuai-coding-plan", modelID: "glm-5.3-flash" },
    })
    expect(test.store.part.msg_promoted).toHaveLength(1)
  })

  test("uses agent and model metadata from the promoted prompt", () => {
    const test = harness()
    test.dispatch("evt_promoted", "session.next.prompt.promoted", {
      timestamp: 2,
      messageID: "msg_promoted",
      timeCreated: 2,
      prompt: {
        text: "continue the old session",
        agent: "review",
        model: { providerID: "anthropic", id: "claude-opus-4-6", variant: "max" },
      },
    })

    expect(test.store.message[test.sessionID]?.at(-1)).toMatchObject({
      id: "msg_promoted",
      role: "user",
      agent: "review",
      model: { providerID: "anthropic", modelID: "claude-opus-4-6", variant: "max" },
    })
  })

  test("matches the authoritative fallback for the first promoted prompt", () => {
    const test = harness()
    test.store.message[test.sessionID] = []
    test.dispatch("evt_promoted", "session.next.prompt.promoted", {
      timestamp: 2,
      messageID: "msg_promoted",
      timeCreated: 2,
      prompt: { text: "start the session" },
    })

    expect(test.store.message[test.sessionID]?.at(-1)).toMatchObject({
      id: "msg_promoted",
      role: "user",
      agent: "assistant",
      model: { providerID: "", modelID: "" },
    })
  })

  test("materializes shell output before the next assistant step", () => {
    const test = harness()
    test.dispatch("evt_shell_start", "session.next.shell.started", {
      timestamp: 2,
      messageID: "msg_shell",
      callID: "call_shell",
      command: "python render.py",
    })

    expect(test.store.message[test.sessionID]?.at(-1)).toMatchObject({ id: "msg_shell", role: "user" })
    expect(test.store.part.msg_shell).toMatchObject([
      { id: "msg_shell:shell", type: "text", text: "$ python render.py" },
    ])

    test.dispatch("evt_shell_end", "session.next.shell.ended", {
      timestamp: 3,
      callID: "call_shell",
      output: "rendered first page",
    })
    test.dispatch("evt_step", "session.next.step.started", {
      timestamp: 4,
      assistantMessageID: "msg_assistant",
      agent: "build",
      model: { providerID: "openai", id: "gpt-5.5" },
    })

    expect(test.store.part.msg_shell?.[0]).toMatchObject({
      type: "text",
      text: "$ python render.py\nrendered first page",
    })
    expect(test.store.message[test.sessionID]?.at(-1)).toMatchObject({
      id: "msg_assistant",
      role: "assistant",
      parentID: "msg_shell",
    })
  })

  test("materializes assistant text and tool lifecycle without a message refresh", () => {
    const test = harness()
    test.dispatch("evt_step", "session.next.step.started", {
      timestamp: 2,
      assistantMessageID: "msg_assistant",
      agent: "build",
      model: { providerID: "openai", id: "gpt-5.5" },
    })
    test.dispatch("evt_text_start", "session.next.text.started", {
      timestamp: 3,
      assistantMessageID: "msg_assistant",
      textID: "text_1",
    })
    test.dispatch("evt_tool_start", "session.next.tool.input.started", {
      timestamp: 4,
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      name: "read",
    })

    const assistant = test.store.message[test.sessionID]?.find((message) => message.id === "msg_assistant")
    expect(assistant).toMatchObject({ role: "assistant", parentID: "msg_user", agent: "build", modelID: "gpt-5.5" })
    expect(test.store.part.msg_assistant).toMatchObject([
      { id: "msg_assistant:text_1", type: "text", text: "" },
      { id: "call_1", type: "tool", tool: "read", state: { status: "pending", raw: "" } },
    ])

    test.dispatch("evt_tool_input", "session.next.tool.input.ended", {
      timestamp: 5,
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      text: '{"path":"README.md"}',
    })
    test.dispatch("evt_tool_called", "session.next.tool.called", {
      timestamp: 6,
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      tool: "read",
      input: { path: "README.md" },
      provider: { executed: false },
    })
    test.dispatch("evt_tool_success", "session.next.tool.success", {
      timestamp: 7,
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      structured: {},
      content: [{ type: "text", text: "file contents" }],
      provider: { executed: false },
    })
    test.dispatch("evt_text_end", "session.next.text.ended", {
      timestamp: 8,
      assistantMessageID: "msg_assistant",
      textID: "text_1",
      text: "Done",
    })

    expect(test.store.part.msg_assistant?.find((part) => part.id === "call_1")).toMatchObject({
      type: "tool",
      state: { status: "completed", input: { path: "README.md" }, output: "file contents" },
    })
    expect(test.store.part.msg_assistant?.find((part) => part.id === "msg_assistant:text_1")).toMatchObject({
      type: "text",
      text: "Done",
    })
  })

  test("does not regress a running tool when a reordered input boundary arrives", () => {
    const test = harness()
    test.dispatch("evt_step", "session.next.step.started", {
      timestamp: 2,
      assistantMessageID: "msg_assistant",
      agent: "build",
      model: { providerID: "openai", id: "gpt-5.5" },
    })
    test.dispatch("evt_tool_start", "session.next.tool.input.started", {
      timestamp: 3,
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      name: "read",
    })
    test.dispatch("evt_tool_called", "session.next.tool.called", {
      timestamp: 4,
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      tool: "read",
      input: { path: "README.md" },
      provider: { executed: false },
    })

    expect(
      test.dispatch("evt_tool_input_late", "session.next.tool.input.ended", {
        timestamp: 5,
        assistantMessageID: "msg_assistant",
        callID: "call_1",
        text: '{"path":"stale.md"}',
      }),
    ).toBeUndefined()
    expect(test.store.part.msg_assistant?.find((part) => part.id === "call_1")).toMatchObject({
      type: "tool",
      state: { status: "running", input: { path: "README.md" } },
    })
  })

  test("does not replace pending tool input with a conflicting second boundary", () => {
    const test = harness()
    test.dispatch("evt_step", "session.next.step.started", {
      timestamp: 2,
      assistantMessageID: "msg_assistant",
      agent: "build",
      model: { providerID: "openai", id: "gpt-5.5" },
    })
    test.dispatch("evt_tool_start", "session.next.tool.input.started", {
      timestamp: 3,
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      name: "read",
    })
    test.dispatch("evt_tool_input", "session.next.tool.input.ended", {
      timestamp: 4,
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      text: '{"path":"README.md"}',
    })

    expect(
      test.dispatch("evt_tool_input_conflict", "session.next.tool.input.ended", {
        timestamp: 5,
        assistantMessageID: "msg_assistant",
        callID: "call_1",
        text: '{"path":"stale.md"}',
      }),
    ).toBeUndefined()
    expect(test.store.part.msg_assistant?.find((part) => part.id === "call_1")).toMatchObject({
      type: "tool",
      state: { status: "pending", raw: '{"path":"README.md"}' },
    })
  })

  test("keeps a successful tool terminal when late progress arrives", () => {
    const test = harness()
    startRunningTool(test)
    test.dispatch("evt_tool_success", "session.next.tool.success", {
      timestamp: 5,
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      structured: {},
      content: [{ type: "text", text: "file contents" }],
      provider: { executed: false },
    })

    expect(
      test.dispatch("evt_tool_progress_late", "session.next.tool.progress", {
        timestamp: 6,
        assistantMessageID: "msg_assistant",
        callID: "call_1",
        structured: { path: "stale.md" },
        content: [{ type: "text", text: "stale progress" }],
      }),
    ).toEqual({ kind: "handled", sessionID: test.sessionID })
    expect(test.store.part.msg_assistant?.find((part) => part.id === "call_1")).toMatchObject({
      type: "tool",
      state: {
        status: "completed",
        input: { path: "README.md" },
        output: "file contents",
        time: { start: 3, end: 5 },
      },
    })
  })

  test("keeps a failed tool terminal when a late called event arrives", () => {
    const test = harness()
    startRunningTool(test)
    test.dispatch("evt_tool_failed", "session.next.tool.failed", {
      timestamp: 5,
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      error: { message: "read failed" },
      provider: { executed: false },
    })

    expect(
      test.dispatch("evt_tool_called_late", "session.next.tool.called", {
        timestamp: 6,
        assistantMessageID: "msg_assistant",
        callID: "call_1",
        tool: "read",
        input: { path: "stale.md" },
        provider: { executed: false },
      }),
    ).toEqual({ kind: "handled", sessionID: test.sessionID })
    expect(test.store.part.msg_assistant?.find((part) => part.id === "call_1")).toMatchObject({
      type: "tool",
      state: {
        status: "error",
        input: { path: "README.md" },
        error: "read failed",
        time: { start: 3, end: 5 },
      },
    })
  })

  test.each(["success", "failed"])("lets an older-timestamp %s terminal settle newer progress", (result) => {
    const test = harness()
    startRunningTool(test)
    test.dispatch("evt_progress_newer", "session.next.tool.progress", {
      timestamp: 10,
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      input: { path: "README.md" },
    })
    test.controller.clear()
    test.dispatch(
      "evt_terminal_older",
      `session.next.tool.${result}.1`,
      result === "success"
        ? {
            timestamp: 9,
            assistantMessageID: "msg_assistant",
            callID: "call_1",
            content: [{ type: "text", text: "done" }],
          }
        : {
            timestamp: 9,
            assistantMessageID: "msg_assistant",
            callID: "call_1",
            error: { message: "failed" },
          },
    )

    expect(test.store.part.msg_assistant?.find((part) => part.id === "call_1")).toMatchObject({
      type: "tool",
      state: result === "success" ? { status: "completed", output: "done" } : { status: "error", error: "failed" },
    })
  })

  test("orders conflicting terminal events by their timestamps regardless of delivery order", () => {
    const project = (reverse: boolean) => {
      const test = harness()
      startRunningTool(test)
      const success = () =>
        test.dispatch("evt_terminal_1", "session.next.tool.success", {
          timestamp: 5,
          assistantMessageID: "msg_assistant",
          callID: "call_1",
          structured: {},
          content: [{ type: "text", text: "stale success" }],
          provider: { executed: false },
        })
      const failed = () =>
        test.dispatch("evt_terminal_2", "session.next.tool.failed", {
          timestamp: 6,
          assistantMessageID: "msg_assistant",
          callID: "call_1",
          error: { message: "authoritative failure" },
          provider: { executed: false },
        })
      if (reverse) {
        failed()
        success()
      } else {
        success()
        failed()
      }
      return test.store.part.msg_assistant?.find((part) => part.id === "call_1")
    }

    expect(project(false)).toMatchObject({
      type: "tool",
      state: { status: "error", error: "authoritative failure", time: { start: 3, end: 6 } },
    })
    expect(project(true)).toEqual(project(false))
  })

  test("uses monotonic event IDs to break equal-timestamp terminal ties", () => {
    const project = (reverse: boolean) => {
      const test = harness()
      startRunningTool(test)
      const success = () =>
        test.dispatch("evt_0001", "session.next.tool.success", {
          timestamp: 5,
          assistantMessageID: "msg_assistant",
          callID: "call_1",
          structured: {},
          content: [{ type: "text", text: "stale success" }],
          provider: { executed: false },
        })
      const failed = () =>
        test.dispatch("evt_0002", "session.next.tool.failed", {
          timestamp: 5,
          assistantMessageID: "msg_assistant",
          callID: "call_1",
          error: { message: "sequenced failure" },
          provider: { executed: false },
        })
      if (reverse) {
        failed()
        success()
      } else {
        success()
        failed()
      }
      return test.store.part.msg_assistant?.find((part) => part.id === "call_1")
    }

    expect(project(false)).toMatchObject({
      type: "tool",
      state: { status: "error", error: "sequenced failure", time: { start: 3, end: 5 } },
    })
    expect(project(true)).toEqual(project(false))
  })

  test("keeps terminal state across direct and synchronized copies with different IDs", () => {
    const test = harness()
    startRunningTool(test)
    const data = {
      sessionID: test.sessionID,
      timestamp: 5,
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      structured: {},
      content: [{ type: "text", text: "file contents" }],
      provider: { executed: false },
    }

    test.dispatch("evt_direct", "session.next.tool.success", data)
    test.dispatch("evt_synchronized", "session.next.tool.success.1", data)
    const late = test.dispatch("evt_synchronized_progress", "session.next.tool.progress.1", {
      ...data,
      timestamp: 6,
      structured: { stale: true },
      content: [],
    })

    expect(late).toEqual({ kind: "handled", sessionID: test.sessionID })
    expect(test.store.part.msg_assistant?.find((part) => part.id === "call_1")).toMatchObject({
      type: "tool",
      state: { status: "completed", output: "file contents", time: { start: 3, end: 5 } },
    })
  })

  test("orders running tool evidence across direct, versioned, and reconnected streams", () => {
    const test = harness()
    startRunningTool(test)
    test.dispatch("evt_0005", "session.next.tool.progress", {
      timestamp: 5,
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      input: { path: "new.md" },
      structured: { state: "running" },
    })

    expect(test.dispatch("evt_0003", "session.next.tool.called.1", {
      timestamp: 3,
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      tool: "read",
      input: { path: "old.md" },
    })).toEqual({ kind: "handled", sessionID: test.sessionID })
    test.controller.clear()
    expect(test.dispatch("evt_0004", "session.next.tool.progress.1", {
      timestamp: 4,
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      input: { path: "older.md" },
    })).toEqual({ kind: "handled", sessionID: test.sessionID })
    expect(test.store.part.msg_assistant?.find((part) => part.id === "call_1")).toMatchObject({
      type: "tool",
      state: { status: "running", input: { path: "new.md" } },
    })
  })

  test("orders assistant terminal evidence by timestamp and equal-time event id", () => {
    const test = harness()
    startRunningTool(test)
    test.dispatch("evt_0005", "session.next.step.ended", {
      timestamp: 5,
      assistantMessageID: "msg_assistant",
      finish: "stop",
      cost: 5,
      tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    test.controller.clear()
    expect(test.dispatch("evt_0004", "session.next.step.failed.1", {
      timestamp: 4,
      assistantMessageID: "msg_assistant",
      error: { message: "stale" },
    })).toEqual({ kind: "handled", sessionID: test.sessionID })
    test.dispatch("evt_0006", "session.next.step.failed.1", {
      timestamp: 5,
      assistantMessageID: "msg_assistant",
      error: { message: "new failure" },
    })

    expect(test.store.message[test.sessionID]?.find((message) => message.id === "msg_assistant")).toMatchObject({
      time: { completed: 5 },
      finish: "error",
      error: { data: { message: "new failure" } },
      cost: 5,
      tokens: { input: 5, output: 5 },
    })

    const reverse = harness()
    startRunningTool(reverse)
    reverse.dispatch("evt_0005", "session.next.step.failed", {
      timestamp: 5,
      assistantMessageID: "msg_assistant",
      error: { message: "older failure" },
    })
    reverse.dispatch("evt_0006", "session.next.step.ended.1", {
      timestamp: 5,
      assistantMessageID: "msg_assistant",
      finish: "stop",
      cost: 6,
      tokens: { input: 6, output: 6, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    expect(reverse.store.message[reverse.sessionID]?.find((message) => message.id === "msg_assistant")).toMatchObject({
      time: { completed: 5 },
      finish: "stop",
      error: undefined,
      cost: 6,
      tokens: { input: 6, output: 6 },
    })
  })

  test("deduplicates direct and synchronized copies by event id", () => {
    const test = harness()
    const data = {
      sessionID: test.sessionID,
      timestamp: 2,
      assistantMessageID: "msg_assistant",
      agent: "build",
      model: { providerID: "openai", id: "gpt-5.5" },
    }

    const first = test.controller.handle({ id: "evt_step", type: "session.next.step.started", data }, test.store)
    const duplicate = test.controller.handle({ id: "evt_step", type: "session.next.step.started.1", data }, test.store)

    expect(first?.kind).toBe("message")
    expect(duplicate?.kind).toBe("handled")
  })

  test("does not invent an assistant turn before its user parent is available", () => {
    const test = harness()
    test.store.message[test.sessionID] = []

    expect(
      test.controller.handle(
        {
          id: "evt_step",
          type: "session.next.step.started",
          data: {
            sessionID: test.sessionID,
            timestamp: 2,
            assistantMessageID: "msg_assistant",
            agent: "build",
            model: { providerID: "openai", id: "gpt-5.5" },
          },
        },
        test.store,
      ),
    ).toBeUndefined()
  })
})
