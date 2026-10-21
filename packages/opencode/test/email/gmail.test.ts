import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { executeGmailFormAction } from "../../src/email/gmail"
import { tmpdir } from "../fixture/fixture"

describe("gmail email helper", () => {
  test("sends rich-text mail with attachments through runtime-agnostic file IO", async () => {
    await using tmp = await tmpdir()
    const credentials = path.join(tmp.path, "credentials.json")
    const attachment = path.join(tmp.path, "attach.txt")
    await writeFile(
      credentials,
      JSON.stringify({ client_id: "client", client_secret: "secret", refresh_token: "refresh" }),
    )
    await writeFile(attachment, "attached content")

    const originalFetch = globalThis.fetch
    const sentRaw: string[] = []
    const mockFetch = async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "token" }), {
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
        const body = JSON.parse(String(init?.body)) as { raw?: unknown }
        if (typeof body.raw === "string") sentRaw.push(body.raw)
        return new Response(JSON.stringify({ id: "msg_test" }), { headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({ error: "unexpected url" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    }
    globalThis.fetch = mockFetch as typeof fetch

    try {
      const result = await executeGmailFormAction({
        mode: "send",
        credentials,
        values: {
          to: ["recipient@example.test"],
          cc: [],
          bcc: [],
          subject: "Rich text attachment test",
          body: "<p><strong>Hello</strong> <u>there</u></p>",
          attachments: [attachment],
        },
      })

      expect(result.messageID).toBe("msg_test")
      expect(result.attachments).toEqual([
        { path: attachment, name: "attach.txt", size: 16, contentType: "text/plain" },
      ])
      expect(sentRaw).toHaveLength(1)
      const raw = sentRaw[0]
      expect(raw).toBeString()
      const mime = decodeBase64Url(raw!)
      expect(mime).toContain("Content-Type: multipart/mixed")
      expect(mime).toContain("Content-Type: text/html; charset=UTF-8")
      expect(mime).toContain('filename="attach.txt"')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("does not reference Bun-only file APIs in server-shipped Gmail code", async () => {
    const source = await readFile(path.join(process.cwd(), "src", "email", "gmail.ts"), "utf8")
    expect(source).not.toContain("Bun.")
  })

  test("creates Gmail drafts through the draft endpoint", async () => {
    await using tmp = await tmpdir()
    const credentials = path.join(tmp.path, "credentials.json")
    await writeFile(
      credentials,
      JSON.stringify({ client_id: "client", client_secret: "secret", refresh_token: "refresh" }),
    )

    const originalFetch = globalThis.fetch
    const draftRaw: string[] = []
    const mockFetch = async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "token" }), {
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "https://gmail.googleapis.com/gmail/v1/users/me/drafts") {
        const body = JSON.parse(String(init?.body)) as { message?: { raw?: unknown } }
        if (typeof body.message?.raw === "string") draftRaw.push(body.message.raw)
        return new Response(JSON.stringify({ id: "draft_test", message: { id: "msg_draft" } }), {
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ error: "unexpected url" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    }
    globalThis.fetch = mockFetch as typeof fetch

    try {
      const result = await executeGmailFormAction({
        mode: "draft",
        credentials,
        values: {
          to: ["recipient@example.test"],
          subject: "Draft endpoint test",
          body: "Draft body",
          attachments: [],
        },
      })

      expect(result.mode).toBe("draft")
      expect(result.draftID).toBe("draft_test")
      expect(result.messageID).toBe("msg_draft")
      expect(draftRaw).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("does not double-escape rich text entity content", async () => {
    await using tmp = await tmpdir()
    const credentials = path.join(tmp.path, "credentials.json")
    await writeFile(
      credentials,
      JSON.stringify({ client_id: "client", client_secret: "secret", refresh_token: "refresh" }),
    )

    const originalFetch = globalThis.fetch
    const sentRaw: string[] = []
    const mockFetch = async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "token" }), {
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
        const body = JSON.parse(String(init?.body)) as { raw?: unknown }
        if (typeof body.raw === "string") sentRaw.push(body.raw)
        return new Response(JSON.stringify({ id: "msg_entities" }), { headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({ error: "unexpected url" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    }
    globalThis.fetch = mockFetch as typeof fetch

    try {
      await executeGmailFormAction({
        mode: "send",
        credentials,
        values: {
          to: ["recipient@example.test"],
          subject: "Entity rich text test",
          body: "2 &lt; 3 &amp; &quot;quoted&quot;",
          attachments: [],
        },
      })

      const mime = decodeBase64Url(sentRaw[0]!).replace(/\s/g, "")
      expect(mime).toContain(base64('2 < 3 & "quoted"'))
      expect(mime).toContain(base64("2 &lt; 3 &amp; &quot;quoted&quot;"))
      expect(mime).not.toContain(base64("2 &amp;lt; 3 &amp;amp; &amp;quot;quoted&amp;quot;"))
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

function decodeBase64Url(value: string) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
}

function base64(value: string) {
  return Buffer.from(value, "utf8").toString("base64")
}
