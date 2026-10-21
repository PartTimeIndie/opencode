import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deliver, preview, status } from "../../src/mail/delivery"

const account = { id: "gmx-personal", name: "Personal", email: "person@gmx.de", secretID: "12345678-1234-1234-1234-123456789abc", enabled: true }
const message = { from: "person@gmx.de", to: ["friend@example.com"], subject: "Hello", text: "Message" }

test("a reviewed request cannot send or save a draft twice", async () => {
  const state = await mkdtemp(join(tmpdir(), "gmx-delivery-"))
  try {
    const expectedHash = (await preview(account, message)).hash
    const requestID = crypto.randomUUID()
    let calls = 0
    const transport = {
      send: async () => { calls++; return { accepted: ["friend@example.com"], rejected: [], archive: "saved" as const, messageID: "<test>" } },
      draft: async () => { calls++; return { messageID: "<test>", uid: 1, uidValidity: "1", mailbox: "Drafts" } },
    }
    const input = { account, message, requestID, expectedHash, state, intent: "send" as const, transport }
    const results = await Promise.allSettled([deliver(input), deliver({ ...input, intent: "draft" })])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(calls).toBe(1)
    const winner = await status(requestID, state) as { state: string; intent: string }
    expect(["provider_accepted", "draft_saved"]).toContain(winner.state)
    await expect(deliver({ ...input, intent: winner.intent as "send" | "draft" })).rejects.toThrow("already started")
    await expect(deliver({ ...input, intent: winner.intent === "send" ? "draft" : "send" })).rejects.toThrow("bound to another message")
  } finally {
    await rm(state, { recursive: true, force: true })
  }
})

test("an uncertain provider result remains blocked after failure", async () => {
  const state = await mkdtemp(join(tmpdir(), "gmx-delivery-"))
  try {
    const requestID = crypto.randomUUID()
    const input = { account, message, requestID, expectedHash: (await preview(account, message)).hash, state, intent: "send" as const,
      transport: { send: async () => { throw new Error("transport uncertain") }, draft: async () => { throw new Error("not used") } } }
    await expect(deliver(input)).rejects.toThrow("transport uncertain")
    expect((await status(requestID, state)) as { state: string }).toHaveProperty("state", "unknown")
    await expect(deliver(input)).rejects.toThrow("already started")
    await expect(deliver({ ...input, message: { ...message, subject: "changed" } })).rejects.toThrow("changed since approval")
  } finally {
    await rm(state, { recursive: true, force: true })
  }
})

test("accepted SMTP result remains durable when Sent archival fails afterwards", async () => {
  const state = await mkdtemp(join(tmpdir(), "gmx-delivery-"))
  try {
    const requestID = crypto.randomUUID()
    const input = { account, message, requestID, expectedHash: (await preview(account, message)).hash, state, intent: "send" as const,
      transport: { send: async (_account: typeof account, _prepared: unknown, accepted?: (value: { messageID: string; accepted: string[]; rejected: string[] }) => Promise<void>) => {
        await accepted?.({ messageID: "<accepted>", accepted: ["friend@example.com"], rejected: [] })
        throw new Error("archive failed")
      }, draft: async () => { throw new Error("not used") } } }
    await expect(deliver(input)).rejects.toThrow("archive failed")
    const receipt = await status(requestID, state) as { state: string; result: { messageID: string } }
    expect(receipt.state).toBe("provider_accepted")
    expect(receipt.result.messageID).toBe("<accepted>")
    await expect(deliver(input)).rejects.toThrow("already started")
  } finally {
    await rm(state, { recursive: true, force: true })
  }
})
