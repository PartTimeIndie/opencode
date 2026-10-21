import { expect, test } from "bun:test"
import { saveDraft, send } from "../../src/mail/gmx"

const account = { id: "gmx-personal", name: "Personal", email: "person@gmx.de", secretID: "12345678-1234-1234-1234-123456789abc", enabled: true, drafts: "Drafts" }
const message = { from: "wrong@gmx.de", to: ["friend@example.org"], subject: "test", text: "Hi" }

test("GMX send and draft reject a mismatched sender before requesting a secret or connecting", async () => {
  await expect(send(account, message)).rejects.toThrow("Sender does not match")
  await expect(saveDraft(account, message)).rejects.toThrow("Sender does not match")
})
