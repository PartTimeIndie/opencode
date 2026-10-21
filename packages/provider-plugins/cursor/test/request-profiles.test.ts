import { describe, expect, test } from "bun:test"
import { Plugin } from "../src"
import { requestProfiles } from "../src/request-profiles"

describe("Cursor request profile", () => {
  test("registers the provider-owned option namespace", () => {
    expect(Plugin.requestProfiles).toBe(requestProfiles)
    expect(requestProfiles["cursor-opencode-provider"]).toEqual({
      namespace: "cursor",
      semantics: {
        cursorVariantParameters: "cursorVariantParameters",
        cursorModelId: "cursorModelId",
        reasoningEffort: "reasoningEffort",
        maxMode: "maxMode",
        opencodeCompaction: "opencodeCompaction",
      },
    })
  })
})
