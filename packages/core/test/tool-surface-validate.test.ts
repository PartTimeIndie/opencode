import { describe, expect, it } from "bun:test"
// Side-effect import: the session module graph evaluates tool/builtins before
// tool/surface, avoiding a circular-import init error on SurfaceTool.layer.
import "@opencode-ai/core/session"
import { Schema } from "effect"
import { SurfaceTool } from "@opencode-ai/core/tool/surface"

describe("surface tool blocking input validation", () => {
  const question = { question: "Which direction?", options: [{ label: "A" }, { label: "B" }] }

  it("accepts an optional top-level title on inline blocking inputs", () => {
    expect(
      SurfaceTool.validateInput({ mode: "blocking", title: "Choose a direction", questions: [question] }),
    ).toBeUndefined()
  })

  it("accepts an optional top-level title on source-backed blocking inputs", () => {
    expect(
      SurfaceTool.validateInput({
        mode: "blocking",
        title: "Choose a direction",
        sourceFile: { path: "payload.json", sha256: "a".repeat(64), count: 1 },
      }),
    ).toBeUndefined()
  })

  it("still rejects unknown top-level fields on blocking inputs", () => {
    expect(SurfaceTool.validateInput({ mode: "blocking", dock: true, questions: [question] })).toContain(
      'Unexpected field ["dock"]',
    )
  })

  it("still rejects actions on blocking inputs", () => {
    expect(
      SurfaceTool.validateInput({ mode: "blocking", actions: [{ id: "go" }], questions: [question] }),
    ).toContain("cannot declare actions")
  })

  it("accepts title-bearing blocking inputs through the tool schema union", () => {
    expect(Schema.is(SurfaceTool.Input)({ mode: "blocking", title: "Choose a direction", questions: [question] })).toBe(
      true,
    )
    expect(
      Schema.is(SurfaceTool.Input)({
        mode: "blocking",
        title: "Choose a direction",
        sourceFile: { path: "payload.json", sha256: "a".repeat(64), count: 1 },
      }),
    ).toBe(true)
  })

  it("rejects a non-string title on blocking inputs", () => {
    expect(SurfaceTool.validateInput({ mode: "blocking", title: 123, questions: [question] })).toContain(
      'Invalid field ["title"]',
    )
    expect(Schema.is(SurfaceTool.Input)({ mode: "blocking", title: 123, questions: [question] })).toBe(false)
  })
})
