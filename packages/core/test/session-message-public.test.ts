import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment } from "@opencode-ai/core/session/prompt"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

describe("SessionMessage public projection", () => {
  test("references a legacy oversized PNG duplicate without mutating canonical history", () => {
    const bytes = Buffer.alloc(4_079_264 * 3 / 4)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
    const base64 = bytes.toString("base64")
    const attachment = new FileAttachment({
      uri: "attachment://att_3c3465dba373ef177da42ed8e41f19c1",
      mime: "image/png",
      name: "screenshot.png",
    })
    const text = "x".repeat(300_000)
    const message = new SessionMessage.Assistant({
      id: SessionMessage.ID.make("msg_legacy_oversized_media"),
      type: "assistant",
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("model") },
      time: { created: DateTime.makeUnsafe(1) },
      content: [
        new SessionMessage.AssistantTool({
          type: "tool",
          id: "tool_read",
          name: "read",
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
          state: new SessionMessage.ToolStateCompleted({
            status: "completed",
            input: {},
            content: [{ type: "file", ...attachment }],
            attachments: [attachment],
            outputPaths: [attachment.uri],
            structured: { content: base64, report: text },
          }),
        }),
      ],
    })

    const projected = SessionMessage.projectForPublicRead(message)
    const tool = projected.type === "assistant" ? projected.content[0] : undefined
    if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("expected completed tool")
    expect(tool.state.structured).toEqual({
      content: {
        $opencode: {
          type: "content-reference",
          uri: attachment.uri,
          mime: attachment.mime,
          sizeBytes: bytes.byteLength,
          encoding: "base64",
        },
      },
      report: text,
    })
    expect(JSON.stringify(projected)).not.toContain(base64)
    expect(JSON.stringify(message)).toContain(base64)
    const original = message.content[0]
    if (original?.type !== "tool" || original.state.status !== "completed") throw new Error("expected original tool")
    expect(original.state.structured).toMatchObject({ content: base64 })
  })

  test("preserves large text, unmatched base64, and ambiguous attachment candidates", () => {
    const bytes = Buffer.alloc(300_000)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
    const base64 = bytes.toString("base64")
    const message = new SessionMessage.Assistant({
      id: SessionMessage.ID.make("msg_legacy_ambiguous_media"),
      type: "assistant",
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("model") },
      time: { created: DateTime.makeUnsafe(1) },
      content: [
        new SessionMessage.AssistantTool({
          type: "tool",
          id: "tool_read",
          name: "read",
          time: { created: DateTime.makeUnsafe(1) },
          state: new SessionMessage.ToolStateCompleted({
            status: "completed",
            input: {},
            content: [
              { type: "file", uri: "attachment://att_first", mime: "image/png" },
              { type: "file", uri: "attachment://att_second", mime: "image/png" },
            ],
            outputPaths: [],
            structured: {
              content: base64,
              dataUri: `data:image/png;base64,${base64}`,
              text: "z".repeat(300_000),
            },
          }),
        }),
      ],
    })

    expect(SessionMessage.projectForPublicRead(message)).toBe(message)
  })
})
