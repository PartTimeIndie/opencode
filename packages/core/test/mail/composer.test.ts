import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Control } from "../../src/control"
import { composer } from "../../src/mail/composer"

test("shared composer binds GMX actions to its account and defaults to send", () => {
  const form = Schema.decodeUnknownSync(Control.PartData)(composer({
    provider: "gmx", account: "gmx-example", sender: "sender@example.test", message: { to: ["person@example.com"], subject: "Hallo", text: "Hi" },
  })).controls[0]?.form
  expect(form?.fields.find((item) => item.id === "sender")?.description).toBe("sender@example.test")
  expect(form?.fields.find((item) => item.id === "action")?.defaultValue).toBe("send")
  expect(form?.fields.find((item) => item.id === "to")?.defaultValue).toEqual(["person@example.com"])
  expect(form?.actions?.find((item) => item.id === "send")?.steps).toEqual([{ type: "gmx", account: "gmx-example", mode: "send" }])
  expect(form?.fields.find((item) => item.id === "body")?.type).toBe("textarea")
})

test("Gmail retains its existing OAuth action and rich text editor", () => {
  const form = Schema.decodeUnknownSync(Control.PartData)(composer({ provider: "gmail" })).controls[0]?.form
  expect(form?.actions?.find((item) => item.id === "send")?.steps).toEqual([{ type: "gmail", mode: "send" }])
  expect(form?.fields.find((item) => item.id === "action")?.defaultValue).toBe("send")
  expect(form?.fields.find((item) => item.id === "body")?.type).toBe("rich_text")
  expect(form?.fields.find((item) => item.id === "to")?.autocomplete?.provider).toBe("gmail-recipients")
})

test("GMX composer requires a configured account selection", () => {
  expect(() => composer({ provider: "gmx" })).toThrow("GMX account ID required")
})
