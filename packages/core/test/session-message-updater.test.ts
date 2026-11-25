import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"

const sessionID = SessionV2.ID.make("ses_message_updater")
const assistantMessageID = SessionMessage.ID.make("msg_message_updater")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

describe("SessionMessageUpdater", () => {
  test("preserves optional structured attempt receipts through settlement and message JSON", async () => {
    const receipt = {
      version: 1 as const, phase: "correction" as const, mode: "tool" as const,
      inputID: SessionMessage.ID.make("msg_original_input"),
      inputDigest: "a".repeat(64), schemaDigest: "b".repeat(64), model,
    }
    for (const structuredOutputAttempt of [undefined, receipt]) {
      const state: SessionMessageUpdater.MemoryState = { messages: [] }
      const adapter = SessionMessageUpdater.memory(state)
      await Effect.runPromise(SessionMessageUpdater.update(adapter, {
        id: EventV2.ID.make("evt_attempt_started"), type: "session.next.step.started",
        data: { sessionID, assistantMessageID, agent: "build", model, timestamp: created, structuredOutputAttempt },
      } satisfies SessionEvent.Event))
      await Effect.runPromise(SessionMessageUpdater.update(adapter, {
        id: EventV2.ID.make("evt_attempt_ended"), type: "session.next.step.ended",
        data: {
          sessionID, assistantMessageID, timestamp: DateTime.makeUnsafe(1), finish: "stop", cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      } satisfies SessionEvent.Event))
      const message = state.messages[0]
      expect(message?.type).toBe("assistant")
      if (message?.type !== "assistant") throw new Error("Missing projected assistant")
      expect(message.structuredOutputAttempt).toEqual(structuredOutputAttempt)
      const decoded = Schema.decodeUnknownSync(SessionMessage.Message)(JSON.parse(JSON.stringify(
        Schema.encodeSync(SessionMessage.Message)(message),
      )))
      expect(decoded).toMatchObject({ type: "assistant", finish: "stop" })
      if (decoded.type !== "assistant") throw new Error("Missing decoded assistant")
      expect(decoded.structuredOutputAttempt).toEqual(structuredOutputAttempt)
    }
  })
  test("makes an activity failure visible on an assistant that never emitted content", async () => {
    const state: SessionMessageUpdater.MemoryState = {
      messages: [
        new SessionMessage.Assistant({
          id: assistantMessageID,
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created },
        }),
      ],
    }

    await Effect.runPromise(
      SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
        id: EventV2.ID.make("evt_activity_failed"),
        type: "session.next.activity.failed",
        data: {
          sessionID,
          activityID: "activity-model-resolution",
          timestamp: DateTime.makeUnsafe(1),
          error: { type: "unknown", message: "GPT-5.6 max is unavailable for the current OAuth connection" },
        },
      } satisfies SessionEvent.Event),
    )

    const assistant = state.messages[0]
    expect(assistant).toMatchObject({
      id: assistantMessageID,
      type: "assistant",
      finish: "error",
      error: { type: "unknown", message: "GPT-5.6 max is unavailable for the current OAuth connection" },
    })
    if (assistant?.type !== "assistant" || !assistant.time.completed) return
    expect(DateTime.toEpochMillis(assistant.time.completed)).toBe(1)
  })

  test("keeps typed step failure metadata on the projected assistant message", async () => {
    const state: SessionMessageUpdater.MemoryState = {
      messages: [
        new SessionMessage.Assistant({
          id: assistantMessageID,
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created },
        }),
      ],
    }

    await Effect.runPromise(
      SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
        id: EventV2.ID.make("evt_step_failed_typed"),
        type: "session.next.step.failed",
        data: {
          sessionID,
          assistantMessageID,
          timestamp: DateTime.makeUnsafe(1),
          error: { type: "unknown", message: "The provider stream or request failed before completion." },
          failure: {
            code: "provider.transport",
            message: "The provider stream or request failed before completion.",
            retryability: "auto-retry",
            remediation: "retry",
          },
        },
      } satisfies SessionEvent.Event),
    )

    expect(state.messages[0]).toMatchObject({
      type: "assistant",
      failure: { code: "provider.transport", remediation: "retry" },
    })
  })

  test("projects successful tool file content into completed attachments", async () => {
    const state: SessionMessageUpdater.MemoryState = {
      messages: [
        new SessionMessage.Assistant({
          id: assistantMessageID,
          type: "assistant",
          agent: "build",
          model,
          content: [
            new SessionMessage.AssistantTool({
              type: "tool",
              id: "call-svg",
              name: "attach",
              time: { created },
              state: new SessionMessage.ToolStateRunning({
                status: "running",
                input: {},
                structured: {},
                content: [],
              }),
            }),
          ],
          time: { created },
        }),
      ],
    }

    await Effect.runPromise(
      SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
        id: EventV2.ID.make("evt_tool_success"),
        type: "session.next.tool.success",
        data: {
          sessionID,
          assistantMessageID,
          callID: "call-svg",
          timestamp: DateTime.makeUnsafe(1),
          structured: {},
          content: [
            {
              type: "file",
              uri: "data:image/svg+xml;base64,PHN2Zy8+",
              mime: "image/svg+xml",
              name: "icon.svg",
            },
          ],
          provider: { executed: false },
        },
      } satisfies SessionEvent.Event),
    )

    const message = state.messages[0]
    expect(message?.type).toBe("assistant")
    if (message?.type !== "assistant") return
    const tool = message.content[0]
    expect(tool?.type).toBe("tool")
    if (tool?.type !== "tool" || tool.state.status !== "completed") return
    expect(tool.state.attachments).toMatchObject([
      {
        uri: "data:image/svg+xml;base64,PHN2Zy8+",
        mime: "image/svg+xml",
        name: "icon.svg",
      },
    ])
  })

  test("keeps typed tool failure metadata on the projected tool state", async () => {
    const state: SessionMessageUpdater.MemoryState = {
      messages: [
        new SessionMessage.Assistant({
          id: assistantMessageID,
          type: "assistant",
          agent: "build",
          model,
          content: [
            new SessionMessage.AssistantTool({
              type: "tool",
              id: "call-failing-tool",
              name: "failing-tool",
              time: { created },
              state: new SessionMessage.ToolStateRunning({
                status: "running",
                input: {},
                structured: {},
                content: [],
              }),
            }),
          ],
          time: { created },
        }),
      ],
    }

    await Effect.runPromise(
      SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
        id: EventV2.ID.make("evt_tool_failed_typed"),
        type: "session.next.tool.failed",
        data: {
          sessionID,
          assistantMessageID,
          callID: "call-failing-tool",
          timestamp: DateTime.makeUnsafe(1),
          error: { type: "unknown", message: "Tool execution failed." },
          failure: {
            code: "tool.defect",
            message: "Tool execution failed.",
            retryability: "none",
            remediation: "report",
          },
          provider: { executed: true },
        },
      } satisfies SessionEvent.Event),
    )

    expect(state.messages[0]).toMatchObject({
      type: "assistant",
      content: [
        {
          type: "tool",
          state: { status: "error", failure: { code: "tool.defect", remediation: "report" } },
        },
      ],
    })
  })
})
