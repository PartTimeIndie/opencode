import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { executeGmailFormAction, GmailActionError, prepareGmailMessage } from "../../src/email/gmail"
import { tmpdir } from "../fixture/fixture"

const credentialsFile = async (tmpPath: string) => {
  const credentials = path.join(tmpPath, "credentials.json")
  await writeFile(
    credentials,
    JSON.stringify({ client_id: "client", client_secret: "secret", refresh_token: "refresh" }),
  )
  return credentials
}

const tokenFetch = () =>
  Promise.resolve(new Response(JSON.stringify({ access_token: "token" }), {
    headers: { "content-type": "application/json" },
  }))

describe("gmail send phase classification", () => {
  test("attachment read failure is a preflight error with zero provider calls", async () => {
    await using tmp = await tmpdir()
    const credentials = await credentialsFile(tmp.path)
    let providerCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0]) => {
      providerCalls += 1
      return tokenFetch()
    }) as typeof fetch
    try {
      const error = await executeGmailFormAction({
        mode: "send",
        credentials,
        values: { to: ["recipient@example.test"], subject: "x", body: "y", attachments: [path.join(tmp.path, "missing.txt")] },
      }).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(GmailActionError)
      expect((error as GmailActionError).phase).toBe("preflight")
      expect(providerCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("provider failure after MIME preparation is an unknown error", async () => {
    await using tmp = await tmpdir()
    const credentials = await credentialsFile(tmp.path)
    let sendCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input) === "https://oauth2.googleapis.com/token") return tokenFetch()
      if (String(input) === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
        sendCalls += 1
        return new Response(JSON.stringify({ error: { code: 500, message: "backend" } }), { status: 500 })
      }
      return new Response("{}", { status: 404 })
    }) as typeof fetch
    try {
      const error = await executeGmailFormAction({
        mode: "send",
        credentials,
        values: { to: ["recipient@example.test"], subject: "x", body: "y" },
      }).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(GmailActionError)
      expect((error as GmailActionError).phase).toBe("unknown")
      expect(sendCalls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("preparation freezes values and attachment bytes before delivery", async () => {
    await using tmp = await tmpdir()
    const attachment = path.join(tmp.path, "attach.txt")
    await writeFile(attachment, "frozen")
    const prepared = await prepareGmailMessage({
      mode: "send",
      values: { to: ["recipient@example.test"], subject: "Freeze", body: "body", attachments: [attachment] },
    })
    await writeFile(attachment, "changed-after-prepare")
    const raw = Buffer.from(prepared.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    expect(raw).toContain(Buffer.from("frozen", "utf8").toString("base64").replace(/(.{76})/, "$1\r\n"))
    expect(prepared.attachments[0]?.size).toBe(6)
  })
})
