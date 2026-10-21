import { describe, expect, test } from "bun:test"
import { confirmGoalOverride, prepareGoalMetadataUpdate, type GoalOverride } from "./session-goal-state"

describe("session goal optimistic state", () => {
  test("recognizes an idempotent metadata update before creating an override", () => {
    expect(prepareGoalMetadataUpdate("  ship it  ", { "opencode.session.goal": "ship it" })).toMatchObject({
      goal: "ship it",
      isIdempotent: true,
    })
  })

  test("does not confirm a disappeared or stale override when an ack arrives", () => {
    const override: GoalOverride = {
      value: "ship it",
      before: { present: false, value: "" },
      confirmed: false,
    }

    expect(confirmGoalOverride(undefined, true)).toBeUndefined()
    expect(confirmGoalOverride(override, false)).toBeUndefined()
    expect(confirmGoalOverride(override, true)).toEqual({ ...override, confirmed: true })
  })
})
