import { describe, expect, it } from "bun:test"
// Side-effect import: the session module graph evaluates tool/builtins before
// tool/surface, avoiding a circular-import init error on SurfaceTool.layer.
import "@opencode-ai/core/session"
import { Cause, Effect, Exit, Schema } from "effect"
import { SurfaceTool } from "@opencode-ai/core/tool/surface"
import { Tool } from "@opencode-ai/core/tool/tool"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { toolIdentity } from "./lib/tool"

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

  it("accepts a one-click chat approval on a blocking question", () => {
    const input = {
      mode: "blocking",
      questions: [
        {
          ...question,
          chatSend: { text: "/multi-agent-review", label: "Review starten", description: "Starts the review swarm" },
        },
      ],
    }
    expect(SurfaceTool.validateInput(input)).toBeUndefined()
    expect(Schema.is(SurfaceTool.Input)(input)).toBe(true)
  })

  it("rejects an empty one-click chat approval text", () => {
    const input = { mode: "blocking", questions: [{ ...question, chatSend: { text: "" } }] }
    expect(Schema.is(SurfaceTool.Input)(input)).toBe(false)
  })

  it("keeps questions without chat approval valid", () => {
    expect(Schema.is(SurfaceTool.Input)({ mode: "blocking", questions: [question] })).toBe(true)
  })

  it("rejects a non-string title on blocking inputs", () => {
    expect(SurfaceTool.validateInput({ mode: "blocking", title: 123, questions: [question] })).toContain(
      'Invalid field ["title"]',
    )
    expect(Schema.is(SurfaceTool.Input)({ mode: "blocking", title: 123, questions: [question] })).toBe(false)
  })
})

describe("surface tool control input validation", () => {
  const status = {
    version: 1,
    controlID: "review-status",
    title: "Review status",
    markdown: "Erwartet: Keine Aktion nötig",
    controls: [{ id: "status", type: "review_section", label: "Status", content: "Review complete; handoff pending." }],
  }

  function settle(input: unknown) {
    const tool = Tool.make({
      description: SurfaceTool.description,
      input: SurfaceTool.Input,
      output: Schema.Boolean,
      validateInput: SurfaceTool.validateInput,
      execute: () => Effect.succeed(true),
    })
    return Effect.runSyncExit(
      Tool.settle(
        tool,
        { type: "tool-call", id: "surface-test", name: "surface", input },
        { ...toolIdentity, sessionID: SessionSchema.ID.make("ses_surface_validation"), toolCallID: "surface-test" },
      ),
    )
  }

  it.each(["passive", "interactive"] as const)("accepts canonical %s controls through actual tool decoding", (mode) => {
    expect(SurfaceTool.validateInput({ mode, ...status })).toBeUndefined()
    const result = settle({ mode, ...status })
    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) expect(result.value.structured).toBe(true)
  })

  it.each([
    { mode: "passive", title: "Status", markdown: "Review complete." },
    { mode: "passive", ...status, controls: [{ id: "status", type: "markdown", label: "Status", content: "Complete" }] },
  ])("keeps invalid passive payloads failed and gives a valid passive correction: %j", (input) => {
    const diagnostic = SurfaceTool.validateInput(input)
    expect(diagnostic).toContain('"mode": "passive"')
    expect(diagnostic).toContain('"version": 1')
    expect(diagnostic).toContain('"controlID":')
    expect(diagnostic).toContain('"type": "review_section"')
    expect(diagnostic).not.toContain('"mode": "blocking"')
    const result = settle(input)
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(diagnostic!)
    const example = diagnostic?.match(/input: (\{.+\})\./)?.[1]
    if (!example) throw new Error("Missing canonical Control input")
    expect(Exit.isSuccess(settle(JSON.parse(example)))).toBe(true)
  })

  it.each(["passive", "interactive"] as const)("preserves %s mode in semantic and phase error guidance", (mode) => {
    for (const extra of [{ phase: "invalid" }, { controls: [], effects: [{ id: "bad", target: "unsafe", value: "x" }] }]) {
      const diagnostic = SurfaceTool.validateInput({ mode, ...status, ...extra })
      expect(diagnostic).toContain(`"mode": "${mode}"`)
      expect(diagnostic).not.toContain('"mode": "blocking"')
    }
  })

  it("does not permit actions on passive surfaces or convert them into interactive surfaces", () => {
    const diagnostic = SurfaceTool.validateInput({
      mode: "passive",
      ...status,
      actions: [{ id: "go", trigger: { event: "click" }, steps: [{ type: "setValue", target: "values.status", value: "x" }] }],
    })
    expect(diagnostic).toContain("Passive surfaces cannot declare actions")
    expect(diagnostic).toContain('"mode": "passive"')
    expect(diagnostic).not.toContain('"mode": "interactive"')
  })

  it("keeps blocking correction guidance unchanged", () => {
    expect(SurfaceTool.validateInput({ mode: "blocking", questions: [], actions: [] })).toContain('"mode": "blocking"')
  })
})
