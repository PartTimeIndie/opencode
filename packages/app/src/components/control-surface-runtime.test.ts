import { describe, expect, it } from "bun:test"
import {
  evaluateSurfaceExpression,
  isClientExecutableSurfaceAction,
  matchingSurfaceActions,
  setValuePath,
  surfaceContainsAgentHandoff,
  submitActionTitle,
  surfaceStyle,
  surfaceTargetValue,
} from "./control-surface-runtime"

describe("control-surface-runtime", () => {
  it("evaluates local preview effects", () => {
    const effects = [
      { id: "scale", target: "ui.head.style.transform", value: "scale(${values.zoom})" },
      { id: "seek", target: "ui.preview.media.currentTime", value: "round(${values.cut.start}, 2)" },
    ]

    expect(surfaceStyle(effects, "head", { values: { zoom: 1.25, cut: { start: 12.345 } } })).toEqual({ transform: "scale(1.25)" })
    expect(surfaceTargetValue(effects, "ui.preview.media.currentTime", { values: { zoom: 1.25, cut: { start: 12.345 } } })).toBe(12.35)
  })

  it("matches actions by event, source, and value condition", () => {
    expect(
      matchingSurfaceActions(
        [
          { id: "send", trigger: { event: "submit", when: { field: "action", equals: "send" } }, steps: [{ type: "gmail", mode: "send" }] },
          { id: "draft", trigger: { event: "submit", when: { field: "action", equals: "draft" } }, steps: [{ type: "gmail", mode: "draft" }] },
        ],
        "submit",
        undefined,
        { action: "draft" },
      ).map((action) => action.id),
    ).toEqual(["draft"])
  })

  it("labels GMX send/draft results without changing Gmail labels", () => {
    expect(submitActionTitle({ id: "send", trigger: { event: "submit" }, steps: [{ type: "gmx", account: "gmx-crisci", mode: "send" }] })).toBe("Email sent")
    expect(submitActionTitle({ id: "draft", trigger: { event: "submit" }, steps: [{ type: "gmx", account: "gmx-crisci", mode: "draft" }] })).toBe("GMX draft created")
    expect(submitActionTitle({ id: "gmail", trigger: { event: "submit" }, steps: [{ type: "gmail", mode: "draft" }] })).toBe("Gmail draft created")
  })

  it("updates whole values and nested range endpoints", () => {
    expect(setValuePath({ cut: { start: 1, end: 2 } }, "values.cut.start", 12.5)).toEqual({ cut: { start: 12.5, end: 2 } })
    expect(setValuePath({ name: "Old" }, "values.name", "New")).toEqual({ name: "New" })
    expect(evaluateSurfaceExpression("translate(${values.x}, ${values.y})", { values: { x: 3, y: 4 } })).toBe("translate(3, 4)")
    expect(evaluateSurfaceExpression("${result.stdout}", { values: {}, result: { stdout: "preview.png" } })).toBe("preview.png")
  })

  it("accepts only isolated handoffs so sibling effects cannot run before confirmation", () => {
    const handoff = { type: "switchAgentAndPrompt" as const, agent: "build", prompt: "Implement", model: { mode: "planning-model" as const } }
    expect(isClientExecutableSurfaceAction({ id: "safe", trigger: { event: "click" }, steps: [handoff] })).toBe(true)
    expect(isClientExecutableSurfaceAction({ id: "automatic", trigger: { event: "submit" }, steps: [handoff] })).toBe(false)
    expect(isClientExecutableSurfaceAction({ id: "mixed", trigger: { event: "click" }, steps: [
      { type: "setValue", target: "values.status", value: "started" },
      handoff,
    ] })).toBe(false)
  })

  it("identifies historical panels that contain an agent handoff", () => {
    expect(surfaceContainsAgentHandoff({ actions: [{ steps: [{ type: "switchAgentAndPrompt" }] }] })).toBe(true)
    expect(surfaceContainsAgentHandoff({ actions: [{ steps: [{ type: "setValue" }] }] })).toBe(false)
    expect(surfaceContainsAgentHandoff({ actions: "invalid" })).toBe(false)
  })
})
