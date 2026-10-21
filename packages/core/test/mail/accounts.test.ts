import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { load, save } from "../../src/mail/accounts"

const example = { id: "gmx-personal", name: "Personal", email: "person@gmx.de", secretID: "12345678-1234-1234-1234-123456789abc", enabled: true }

test("accounts persist without passwords and reject stale revisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mail-accounts-"))
  try {
    const first = await save([example], 0, dir)
    expect(first.revision).toBe(1)
    expect(await load(dir)).toEqual(first)
    await expect(save([example], 0, dir)).rejects.toThrow("reload")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("unknown or duplicate accounts fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mail-accounts-"))
  try {
    await expect(save([example, example], 0, dir)).rejects.toThrow("Invalid")
    const accountWithSecret = { ...example, password: "do-not-write-me" }
    await expect(save([accountWithSecret], 0, dir)).rejects.toThrow("Invalid")
    await writeFile(join(dir, "mail-accounts.json"), JSON.stringify({ version: 1, revision: 0, accounts: [{ ...example, email: "evil@other.org" }] }))
    await expect(load(dir)).rejects.toThrow("Invalid")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
