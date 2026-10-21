import { describe, expect, test } from "bun:test"
import { sanitizeCanonicalMessages } from "../../src/cli/cmd/export"
import type { SessionMessage } from "@opencode-ai/core/session/message"

describe("session export", () => {
  test("sanitizes canonical V2 user and assistant content", () => {
    const messages = [
      {
        id: "msg_user",
        type: "user",
        text: "private prompt",
        files: [
          {
            uri: "file:///private/image.png",
            mime: "image/png",
            name: "image.png",
            description: "private image",
            source: { start: 0, end: 5, text: "private source" },
          },
        ],
        agents: [{ name: "private agent", source: { start: 0, end: 5, text: "private agent source" } }],
        format: { type: "json_schema", schema: { secret: "private schema" } },
        metadata: { secret: "private metadata" },
        time: { created: 1 },
      },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        structured: { secret: "private structured output" },
        error: { name: "Error", data: { message: "private error" } },
        content: [
          { id: "text", type: "text", text: "private answer" },
          {
            id: "tool",
            type: "tool",
            name: "read",
            state: {
              status: "completed",
              input: { filePath: "C:/private/file.txt" },
              structured: { secret: "private tool data" },
              content: [{ type: "text", text: "private tool output" }],
              outputPaths: ["C:/private/output.txt"],
              result: { secret: "private result" },
              attachments: [{ uri: "file:///private/tool.png", mime: "image/png", name: "tool.png" }],
              time: { created: 1 },
            },
            time: { created: 1 },
          },
        ],
        time: { created: 1, completed: 2 },
      },
    ] as unknown as SessionMessage.Message[]

    const result = sanitizeCanonicalMessages(messages)
    const json = JSON.stringify(result)

    expect(json).not.toContain("private")
    expect(result).toMatchObject([
      {
        id: "msg_user",
        type: "user",
        text: "[redacted:v2-user-text:msg_user]",
        files: [{ uri: "[redacted:v2-user-file-uri:msg_user-0]" }],
      },
      {
        id: "msg_assistant",
        type: "assistant",
        content: [
          { id: "text", text: "[redacted:v2-assistant-text:text]" },
          {
            id: "tool",
            state: {
              input: { redacted: "v2-tool-input:tool" },
              content: [{ redacted: "v2-tool-content:tool-0" }],
              outputPaths: ["[redacted:v2-tool-output-path:tool-0]"],
            },
          },
        ],
      },
    ])
  })
})
