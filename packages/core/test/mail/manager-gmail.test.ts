import { expect, test } from "bun:test"
import { requireSourceLabel } from "../../src/mail/manager-gmail"

test("every view-scoped Gmail action checks current source membership before provider mutation", () => {
  const ref = { provider: "gmail" as const, accountID: "gmail-default" as const, messageID: "m1", sourceLabel: "INBOX" }
  expect(() => requireSourceLabel(ref, ["INBOX", "UNREAD"])).not.toThrow()
  expect(() => requireSourceLabel(ref, ["UNREAD"])).toThrow("Source label changed")
  expect(() => requireSourceLabel({ ...ref, sourceLabel: undefined }, ["INBOX"])).toThrow("Source label changed")
})
