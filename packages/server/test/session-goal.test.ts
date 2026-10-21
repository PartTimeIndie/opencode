import { describe, expect, test } from "bun:test"
import { parseSessionGoalControl, sessionGoalMetadataPatch, SessionGoalMetadataKey } from "../src/session-goal"

describe("session-goal command control", () => {
  test("leaves stateful goal operations to the plugin without replacing its focused goal first", () => {
    for (const args of ["add second goal", "edit revised goal", "sisyphus first; second"]) {
      const control = parseSessionGoalControl(args)
      expect(control).toEqual({ type: "plugin" })
      expect(control && sessionGoalMetadataPatch(control)).toBeUndefined()
    }
  })

  test("interprets text controls without relying on model output", () => {
    expect(parseSessionGoalControl("set ship it")).toEqual({ type: "set", value: "ship it" })
    expect(parseSessionGoalControl("edit ship it")).toEqual({ type: "plugin" })
    expect(parseSessionGoalControl("add ship it")).toEqual({ type: "plugin" })
    expect(parseSessionGoalControl("clear")).toEqual({ type: "clear" })
    expect(parseSessionGoalControl("focus now")).toEqual({ type: "focus" })
    expect(parseSessionGoalControl("status")).toEqual({ type: "status" })
  })

  test("produces idempotent set and clear patches while status stays read-only", () => {
    const set = parseSessionGoalControl("set ship it")
    const clear = parseSessionGoalControl("clear")
    const status = parseSessionGoalControl("status")

    const firstSetPatch = set && sessionGoalMetadataPatch(set)
    const secondSetPatch = set && sessionGoalMetadataPatch(set)
    expect(firstSetPatch).toEqual({ set: { [SessionGoalMetadataKey]: "ship it" } })
    expect(secondSetPatch).toEqual(firstSetPatch)
    expect(clear && sessionGoalMetadataPatch(clear)).toEqual({ unset: [SessionGoalMetadataKey] })
    expect(status && sessionGoalMetadataPatch(status)).toBeUndefined()
  })

  test("leaves empty or incomplete controls for the model to clarify", () => {
    expect(parseSessionGoalControl("")).toBeUndefined()
    expect(parseSessionGoalControl("set")).toBeUndefined()
    expect(parseSessionGoalControl("edit")).toBeUndefined()
    expect(parseSessionGoalControl("add")).toBeUndefined()
    expect(parseSessionGoalControl("sisyphus")).toBeUndefined()
    expect(parseSessionGoalControl("status please")).toBeUndefined()
  })
})
