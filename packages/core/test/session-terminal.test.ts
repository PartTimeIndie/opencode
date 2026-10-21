import { describe, expect, test } from "bun:test"
import { SessionTerminal } from "@opencode-ai/core/session/terminal"

describe("SessionTerminal", () => {
  test("requires visible output or a completed tool instead of reasoning alone", () => {
    expect(
      SessionTerminal.assistantResult({
        finish: "stop",
        content: [
          { type: "reasoning", text: "I am planning the work" },
          { type: "text", text: " \n\t" },
        ],
      }),
    ).toBe("incomplete")
    expect(
      SessionTerminal.assistantResult({
        finish: "stop",
        content: [
          { type: "reasoning", text: "Planned the work" },
          { type: "tool", name: "StructuredOutput", state: { status: "completed" } },
        ],
      }),
    ).toBe("done")
  })

  test("classifies a stopped text response as done regardless of usage", () => {
    expect(
      SessionTerminal.assistantResult({
        finish: "stop",
        tokens: { output: 4 },
        content: [{ type: "text", text: "Finished" }],
      }),
    ).toBe("done")
  })

  test("classifies a settled tool response as done", () => {
    expect(
      SessionTerminal.assistantResult({
        finish: "tool-calls",
        content: [{ type: "tool", state: { status: "completed" } }],
      }),
    ).toBe("done")
  })

  test("does not treat an empty stopped provider response as successful", () => {
    expect(
      SessionTerminal.assistantResult({
        finish: "stop",
        tokens: { input: 40, output: 1 },
        content: [{ type: "text", text: "" }],
      }),
    ).toBe("incomplete")
  })

  test("keeps provider errors, aborts, and unsettled tools incomplete", () => {
    expect(SessionTerminal.assistantResult({ finish: "error", content: [] })).toBe("incomplete")
    expect(SessionTerminal.assistantResult({ finish: "stop", error: { name: "Aborted" }, content: [] })).toBe(
      "incomplete",
    )
    expect(
      SessionTerminal.assistantResult({
        finish: "stop",
        content: [{ type: "tool", state: { status: "error" } }],
      }),
    ).toBe("incomplete")
  })

  test("leaves a non-terminal assistant step undecided", () => {
    expect(SessionTerminal.assistantResult({ content: [{ type: "text", text: "partial" }] })).toBeUndefined()
  })
})
