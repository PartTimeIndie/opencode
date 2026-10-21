import { describe, expect, test } from "bun:test"
import { gmxFormMessage } from "../../src/email/gmx"
import { prepare } from "@opencode-ai/core/mail/message"

describe("GMX composer", () => {
  test("derives sender from configured account, retaining edited recipients and plain text", async () => {
    const message = gmxFormMessage("sender@example.test", {
      from: "attacker@gmx.de",
      to: ["recipient@example.test"], cc: ["cc@example.com"], bcc: ["bcc@example.com"],
      subject: "Ein Witz", body: "Hi,\n\nEin Witz.\nNiki", attachments: [],
    })
    expect(message.from).toBe("sender@example.test")
    expect(message.bcc).toEqual(["bcc@example.com"])
    const prepared = await prepare(message)
    expect(prepared.envelope.to).toEqual(["recipient@example.test", "cc@example.com", "bcc@example.com"])
    expect(prepared.raw.toString()).not.toContain("Bcc:")
  })

  test("rejects malformed submitted lists rather than silently dropping recipients", () => {
    expect(() => gmxFormMessage("sender@example.test", { to: ["a@example.com", 7], subject: "x", body: "x" })).toThrow("Invalid to")
    expect(() => gmxFormMessage("sender@example.test", { to: ["a@example.com"], subject: "x", body: "x", attachments: [42] })).toThrow("Invalid attachments")
  })
})
