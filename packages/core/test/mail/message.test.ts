import { expect, test } from "bun:test"
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { simpleParser } from "mailparser"
import { prepare, readBounded, verifyFiles } from "../../src/mail/message"

test("outgoing MIME keeps Bcc only in the SMTP envelope and preserves rich content", async () => {
  const mail = await prepare({
    from: "sender@example.com", to: ["recipient@example.com"], bcc: ["blind@example.com"],
    subject: "Prüfung", text: "Grüße", html: "<strong>Grüße</strong>",
  })
  const parsed = await simpleParser(mail.raw)
  expect(parsed.subject).toBe("Prüfung")
  expect(parsed.text).toContain("Grüße")
  expect(parsed.html).toContain("<strong>Grüße</strong>")
  expect(mail.envelope.to).toEqual(["recipient@example.com", "blind@example.com"])
  expect(parsed.headers.has("bcc")).toBe(false)
  expect(mail.raw.toString()).not.toContain("blind@example.com")
})

test("header injection is rejected before MIME creation", async () => {
  await expect(prepare({ from: "me@example.com", to: ["you@example.com"], subject: "ok\r\nBcc: bad@example.com", text: "hi" }))
    .rejects.toThrow("Invalid mail header")
})

test("changed attachments invalidate a prepared message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mail-test-"))
  try {
    const filename = join(dir, "file.txt")
    await writeFile(filename, "first")
    const mail = await prepare({ from: "me@example.com", to: ["you@example.com"], subject: "file", text: "hi", attachments: [filename] })
    await verifyFiles(mail.files)
    await writeFile(filename, "later")
    await expect(verifyFiles(mail.files)).rejects.toThrow("Attachment changed")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("oversized attachments are rejected before reading their content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mail-test-"))
  try {
    const filename = join(dir, "large.bin")
    await writeFile(filename, "")
    await truncate(filename, 11 * 1024 * 1024)
    await expect(prepare({ from: "me@example.com", to: ["you@example.com"], subject: "file", text: "hi", attachments: [filename] }))
      .rejects.toThrow("Attachments exceed")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("streamed attachment reads stop at the exact approved byte limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mail-test-"))
  try {
    const filename = join(dir, "changed.bin")
    await writeFile(filename, "a".repeat(80_000))
    await expect(readBounded(filename, 10)).rejects.toThrow("exceeds the size limit")
    expect((await readBounded(filename, 80_000)).byteLength).toBe(80_000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
