import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyMailView, managerSelection, wishMailView } from "../../src/mail/manager-execution"
import { createMailView, readOwnedMailView } from "../../src/mail/manager-view"

const owner = { sessionID: "session", directory: "C:/example", revision: 1 }
const input = {
  ...owner, accountID: "gmx-test", address: "test@gmx.example", provider: "gmx" as const, mailbox: "INBOX",
  destinations: [{ id: "Archive", label: "Archive", kind: "folder" as const }],
  rows: [1, 2].map((uid) => ({ key: String(uid), from: "sender@example.org", subject: "Subject", snippet: "", unread: true, starred: false,
    ref: { provider: "gmx" as const, accountID: "gmx-test", mailbox: "INBOX", uid, uidValidity: "9" } })),
}

test("form selections resolve only stored references", async () => {
  const state = await mkdtemp(join(tmpdir(), "mail-manager-"))
  try {
    const view = await createMailView(input, state)
    expect(managerSelection(view, { "mail-1": true, action: "move", destination: "Archive" }).rows.map((row) => row.key)).toEqual(["2"])
    expect(() => managerSelection(view, { "mail-2": true, action: "move", destination: "Archive" })).toThrow()
    expect(() => managerSelection(view, { "mail-0": "true", action: "mark_read" })).toThrow()
    expect(readOwnedMailView(view.id, { ...owner, sessionID: "another" }, state)).rejects.toThrow("Session")
    const path = join(state, "mail-manager", `${view.id}.json`)
    const stored = JSON.parse(await readFile(path, "utf8"))
    stored.rows[0].ref.accountID = "other-account"
    await writeFile(path, JSON.stringify(stored))
    expect(readOwnedMailView(view.id, owner, state)).rejects.toThrow("Invalid")
  } finally { await rm(state, { recursive: true, force: true }) }
})

test("durable effect boundary blocks duplicates and stops after ambiguous outcome", async () => {
  const state = await mkdtemp(join(tmpdir(), "mail-manager-"))
  try {
    const view = await createMailView(input, state)
    const calls: number[] = []
    const values = { "mail-0": true, "mail-1": true, action: "mark_read" }
    const result = await applyMailView({ id: view.id, owner, values, state }, async (ref) => {
      if (ref.provider !== "gmx") throw new Error("unexpected")
      calls.push(ref.uid)
      if (ref.uid === 2) throw new Error("timeout")
    })
    expect(calls).toEqual([1, 2])
    expect(result.state).toBe("unknown")
    expect(result.result?.map((item) => item.status)).toEqual(["completed", "unknown"])
    expect(applyMailView({ id: view.id, owner, values, state }, async () => { calls.push(3) })).rejects.toThrow("already")
    expect(calls).toEqual([1, 2])
  } finally { await rm(state, { recursive: true, force: true }) }
})

test("wish requires deliberate open and is not sent twice", async () => {
  const state = await mkdtemp(join(tmpdir(), "mail-manager-"))
  try {
    const view = await createMailView(input, state)
    const texts: string[] = []
    const request = { id: view.id, owner, state, values: { wish_open: "true", wish_text: "  Bitte prüfen  " } }
    await wishMailView(request, async (text) => { texts.push(text) })
    expect(texts).toEqual(["Bitte prüfen"])
    expect(wishMailView(request, async (text) => { texts.push(text) })).rejects.toThrow("already")
  } finally { await rm(state, { recursive: true, force: true }) }
})
