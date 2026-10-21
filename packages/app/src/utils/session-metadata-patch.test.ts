import { describe, expect, test } from "bun:test"
import {
  applySessionMetadataPatch,
  setSessionMetadata,
  unsetSessionMetadata,
} from "./session-metadata-patch"

describe("session metadata patches", () => {
  test("composes independent Goal and access-control writes without losing either key", () => {
    const initial = { "opencode.session.goal": "keep this", other: true }
    const accessControl = setSessionMetadata("access_control", { mode: "always" })
    const goal = setSessionMetadata("opencode.session.goal", "ship it")

    expect(applySessionMetadataPatch(applySessionMetadataPatch(initial, accessControl), goal)).toEqual({
      "opencode.session.goal": "ship it",
      access_control: { mode: "always" },
      other: true,
    })
    expect(applySessionMetadataPatch(initial, unsetSessionMetadata("opencode.session.goal"))).toEqual({ other: true })
  })
})
