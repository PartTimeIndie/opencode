import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Control } from "../../src/control"
import { managerComposer } from "../../src/mail/manager-composer"
import type { MailView } from "../../src/mail/manager"

const view: MailView = {
  id: "12345678-1234-1234-1234-123456789abc", sessionID: "s", directory: "d", accountID: "gmx-example", address: "sender@example.test", provider: "gmx", mailbox: "INBOX", createdAt: 0, revision: 1, state: "ready", destinations: [],
  rows: [{ key: "k1", ref: { provider: "gmx", accountID: "gmx-example", mailbox: "INBOX", uid: 7, uidValidity: "1" }, from: "a@example.com", subject: "Bill", snippet: "Hi", unread: true, starred: false }],
}

test("manager generator produces three user actions without design-choice options", () => {
  const form = Schema.decodeUnknownSync(Control.PartData)(managerComposer(view)).controls[0]?.form
  expect(form?.fields.find((field) => field.id === "mail-0")?.defaultValue).toBe(false)
  expect(form?.fields.filter((field) => field.type === "button").map((field) => field.label)).toEqual([
    "Aktion ausführen", "Schließen", "Wunsch äußern", "Wunsch senden",
  ])
  expect(form?.fields.some((field) => field.id === "design")).toBe(false)
  expect(form?.layout?.children?.find((node) => node.field === "wish_text")?.when).toEqual({ field: "wish_open", equals: "true" })
  expect(form?.fields.find((field) => field.id === "wish_open")?.defaultValue).toBe("false")
  expect(form?.actions?.find((action) => action.id === "apply")?.steps).toEqual([{ type: "mail_manager", viewID: view.id, mode: "apply" }])
})
