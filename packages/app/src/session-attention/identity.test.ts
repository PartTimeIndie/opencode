import { expect, test } from "bun:test"
import { attentionKey, sameAttentionTarget } from "./identity"

test("Windows path spelling shares one priority state and visibility target", () => {
  expect(attentionKey("server", "C:\\Repo\\", "s")).toBe(attentionKey("server", "c:/repo", "s"))
  expect(sameAttentionTarget({ directory: "C:\\Repo\\", sessionID: "s" }, { directory: "c:/repo", sessionID: "s" })).toBe(true)
  expect(sameAttentionTarget({ directory: "C:\\Repo", sessionID: "s" }, { directory: "c:/repo", sessionID: "other" })).toBe(false)
})
