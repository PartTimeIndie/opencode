import { expect, test } from "bun:test"
import { selectedMailAction } from "../../src/mail/manager"
import type { MailView } from "../../src/mail/manager"

const view: MailView = {
  id: "v", sessionID: "s", directory: "d", accountID: "gmx-example", address: "sender@example.test", provider: "gmx",
  mailbox: "INBOX", createdAt: 0, revision: 1, state: "ready",
  destinations: [{ id: "Rechnungen", label: "Rechnungen", kind: "folder" }],
  rows: [{ key: "1", ref: { provider: "gmx", accountID: "gmx-example", mailbox: "INBOX", uid: 12, uidValidity: "4" }, from: "a@example.com", subject: "A", snippet: "", unread: true, starred: false }],
}

test("only IDs from the bound view and a valid existing destination can be applied", () => {
  expect(selectedMailAction(view, { keys: ["1"], operation: "move", destination: "Rechnungen" }).rows[0]?.ref).toEqual(view.rows[0]?.ref)
  expect(() => selectedMailAction(view, { keys: ["missing"], operation: "move", destination: "Rechnungen" })).toThrow("stale")
  expect(() => selectedMailAction(view, { keys: ["1"], operation: "move", destination: "invented" })).toThrow("available destination")
  expect(() => selectedMailAction(view, { keys: ["1", "1"], operation: "mark_read" })).toThrow("Select")
})

test("never converts trash into permanent deletion or GMX folders into Gmail labels", () => {
  expect(() => selectedMailAction({ ...view, mailbox: "trash" }, { keys: ["1"], operation: "trash" })).toThrow("permanent deletion")
  expect(() => selectedMailAction(view, { keys: ["1"], operation: "add_label", destination: "Rechnungen" })).toThrow("Gmail")
  expect(() => selectedMailAction(view, { keys: ["1"], operation: "mark_read", destination: "Rechnungen" })).toThrow("Unexpected destination")
})
