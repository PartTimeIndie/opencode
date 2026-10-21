import { describe, expect, test } from "bun:test"
import { settledV2ToolPart, v2RunProgress } from "@/cli/cmd/run/v2-progress"

describe("V2 run progress", () => {
  test("maps V2-only text and tool boundaries for the active Session", () => {
    expect(
      v2RunProgress(
        {
          type: "session.next.text.ended",
          properties: {
            sessionID: "session-1",
            assistantMessageID: "assistant-1",
            textID: "text-0",
            text: "live progress",
            timestamp: 10,
          },
        },
        "session-1",
      ),
    ).toEqual({
      kind: "text",
      sessionID: "session-1",
      messageID: "assistant-1",
      partID: "text-0",
      text: "live progress",
      timestamp: 10,
    })

    const started = v2RunProgress(
      {
        type: "session.next.tool.called",
        properties: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          callID: "call-1",
          tool: "read",
          input: { path: "src/a.ts" },
          timestamp: 11,
        },
      },
      "session-1",
    )
    const settled = v2RunProgress(
      {
        type: "session.next.tool.success",
        properties: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          callID: "call-1",
          content: [{ type: "text", text: "file body" }],
          structured: { bytes: 9 },
          timestamp: 12,
        },
      },
      "session-1",
    )
    expect(started?.kind).toBe("tool-started")
    expect(settled?.kind).toBe("tool-succeeded")
    if (started?.kind !== "tool-started" || settled?.kind !== "tool-succeeded") throw new Error("bad fixture")
    expect(settledV2ToolPart(settled, started)).toEqual({
      id: "call-1",
      sessionID: "session-1",
      messageID: "assistant-1",
      type: "tool",
      callID: "call-1",
      tool: "read",
      state: {
        status: "completed",
        input: { path: "src/a.ts" },
        output: "file body",
        title: "",
        metadata: { bytes: 9 },
        time: { start: 11, end: 12 },
      },
    })
  })

  test("ignores other Sessions and preserves a useful V2 tool failure", () => {
    expect(
      v2RunProgress(
        { type: "session.next.text.ended", properties: { sessionID: "session-2", text: "wrong" } },
        "session-1",
      ),
    ).toBeUndefined()

    const failed = v2RunProgress(
      {
        type: "session.next.tool.failed",
        properties: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          callID: "call-2",
          error: { message: "interrupted cleanly" },
          timestamp: 20,
        },
      },
      "session-1",
    )
    if (failed?.kind !== "tool-failed") throw new Error("bad fixture")
    expect(settledV2ToolPart(failed).state).toEqual({
      status: "error",
      input: {},
      error: "interrupted cleanly",
      time: { start: 20, end: 20 },
    })
  })
})
