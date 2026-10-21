import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Global } from "../global"
import { Flock } from "../util/flock"
import type { Account } from "./accounts"
import { savePreparedDraft, sendPrepared } from "./gmx"
import { prepare } from "./message"
import type { Outgoing } from "./message"

export type Intent = "send" | "draft"

export async function preview(account: Account, message: Outgoing) {
  if (!account.enabled || account.email.toLowerCase() !== message.from.toLowerCase())
    throw new Error("Sender does not match the active GMX account")
  const prepared = await prepare(message)
  return { hash: digest(account, message, prepared.files), bytes: prepared.raw.byteLength, attachments: prepared.files.map((file) => ({ name: file.name, size: file.size })) }
}

export async function deliver(input: {
  account: Account
  message: Outgoing
  intent: Intent
  requestID: string
  expectedHash: string
  state?: string
  transport?: { send: typeof sendPrepared; draft: typeof savePreparedDraft }
}) {
  if (!/^[0-9a-f-]{36}$/.test(input.requestID) || !/^[0-9a-f]{64}$/.test(input.expectedHash))
    throw new Error("Invalid delivery request")
  const prepared = await prepare(input.message)
  if (input.account.email.toLowerCase() !== prepared.envelope.from.toLowerCase()) throw new Error("Sender does not match the active GMX account")
  if (digest(input.account, input.message, prepared.files) !== input.expectedHash)
    throw new Error("The message or attachment has changed since approval")

  const state = input.state ?? join(Global.Path.state, "gmx-delivery")
  await mkdir(state, { recursive: true, mode: 0o700 })
  const file = join(state, `${input.requestID}.json`)
  return Flock.withLock(`gmx-delivery:${input.requestID}`, async () => {
    const existing = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (existing !== undefined) {
      const previous: unknown = JSON.parse(existing)
      if (!previous || typeof previous !== "object" || !("hash" in previous) || previous.hash !== input.expectedHash ||
        !("accountID" in previous) || previous.accountID !== input.account.id ||
        !("intent" in previous) || previous.intent !== input.intent)
        throw new Error("Request ID is already bound to another message")
      throw new Error("Request has already started; check delivery status before any new attempt")
    }
    // Persist the single-use claim before SMTP or IMAP APPEND. After a crash the
    // result is unknown, so retrying this ID is never allowed automatically.
    await writeFile(file, JSON.stringify({ hash: input.expectedHash, accountID: input.account.id, intent: input.intent, state: "unknown", startedAt: Date.now() }), { mode: 0o600, flag: "wx" })
    const transport = input.transport ?? { send: sendPrepared, draft: savePreparedDraft }
    const persist = async (value: object) => {
      const temp = `${file}.${crypto.randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" })
        await rename(temp, file)
      } finally {
        await rm(temp, { force: true })
      }
    }
    const result = input.intent === "send"
      ? await transport.send(input.account, prepared, async (receipt) =>
          persist({ hash: input.expectedHash, accountID: input.account.id, intent: input.intent, state: "provider_accepted", result: receipt, completedAt: Date.now() }))
      : await transport.draft(input.account, prepared)
    const value = { hash: input.expectedHash, accountID: input.account.id, intent: input.intent, state: input.intent === "draft" ? "draft_saved" : "provider_accepted", result, completedAt: Date.now() }
    await persist(value)
    return value
  })
}

export async function status(requestID: string, state = join(Global.Path.state, "gmx-delivery")) {
  if (!/^[0-9a-f-]{36}$/.test(requestID)) throw new Error("Invalid request ID")
  const text = await readFile(join(state, `${requestID}.json`), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  return text === undefined ? undefined : JSON.parse(text) as unknown
}

function digest(account: Account, message: Outgoing, files: Awaited<ReturnType<typeof prepare>>["files"]) {
  return createHash("sha256").update(JSON.stringify({ accountID: account.id, message, files })).digest("hex")
}
