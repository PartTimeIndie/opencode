import { simpleParser } from "mailparser"
import type { Account } from "./accounts"
import { appPassword } from "./credentials"
import { prepare, verifyFiles } from "./message"
import type { Outgoing } from "./message"

export async function checkConnection(account: Account) {
  return withInbox(account, async (client) => {
    await client.mailboxOpen("INBOX", { readOnly: true })
    return true
  })
}

export async function folders(account: Account) {
  return withInbox(account, async (client) =>
    (await client.list()).map((item) => ({ path: item.path, specialUse: item.specialUse })),
  )
}

export async function search(account: Account, query: { from?: string; subject?: string; since?: Date; limit?: number }) {
  return withInbox(account, async (client) => {
    const box = await client.mailboxOpen("INBOX", { readOnly: true })
    const ids = await client.search({ since: query.since ?? new Date(Date.now() - 30 * 86400_000), ...(query.from ? { from: query.from } : {}), ...(query.subject ? { subject: query.subject } : {}) }, { uid: true })
    if (!Array.isArray(ids)) return []
    const results = await Promise.all(ids.slice(-Math.min(Math.max(query.limit ?? 20, 1), 50)).reverse().map(async (uid) => {
      const value = await client.fetchOne(String(uid), { envelope: true, uid: true }, { uid: true })
      if (!value || !value.envelope) return
      return { uid, uidValidity: String(box.uidValidity), date: value.envelope.date, subject: value.envelope.subject, from: value.envelope.from }
    }))
    return results.filter((item) => item !== undefined)
  })
}

export async function read(account: Account, uid: number, uidValidity: string) {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error("Invalid message UID")
  return withInbox(account, async (client) => {
    const box = await client.mailboxOpen("INBOX", { readOnly: true })
    if (String(box.uidValidity) !== uidValidity) throw new Error("Mailbox changed; search again")
    const value = await client.fetchOne(String(uid), { source: true }, { uid: true })
    if (!value || !value.source || value.source.byteLength > 2 * 1024 * 1024) throw new Error("Message missing or too large")
    const parsed = await simpleParser(value.source)
    return {
      uid, uidValidity, subject: parsed.subject, from: parsed.from?.text,
      to: Array.isArray(parsed.to) ? parsed.to.map((address) => address.text).join(", ") : parsed.to?.text,
      cc: Array.isArray(parsed.cc) ? parsed.cc.map((address) => address.text).join(", ") : parsed.cc?.text,
      replyTo: parsed.replyTo?.text,
      messageID: parsed.messageId, references: parsed.references, text: parsed.text?.slice(0, 65_536),
      truncated: (parsed.text?.length ?? 0) > 65_536,
      attachments: parsed.attachments.map((item) => ({ name: item.filename, size: item.size, contentType: item.contentType })),
    }
  })
}

export async function saveDraft(account: Account, message: Outgoing) {
  requireSender(account, message)
  if (!account.drafts) throw new Error("Configure the GMX drafts folder first")
  const prepared = await prepare(message)
  return savePreparedDraft(account, prepared)
}

export async function savePreparedDraft(account: Account, prepared: Awaited<ReturnType<typeof prepare>>) {
  if (!account.drafts) throw new Error("Configure the GMX drafts folder first")
  if (prepared.envelope.from.toLowerCase() !== account.email.toLowerCase()) throw new Error("Sender does not match the active GMX account")
  await verifyFiles(prepared.files)
  return withInbox(account, async (client) => {
    const result = await client.append(account.drafts!, prepared.raw, ["\\Draft"])
    if (!result) throw new Error("Draft result unknown; check GMX before retrying")
    return { messageID: prepared.messageID, uid: result.uid, uidValidity: String(result.uidValidity), mailbox: account.drafts }
  })
}

export async function send(account: Account, message: Outgoing) {
  requireSender(account, message)
  const prepared = await prepare(message)
  return sendPrepared(account, prepared)
}

export async function sendPrepared(account: Account, prepared: Awaited<ReturnType<typeof prepare>>,
  onAccepted?: (receipt: { messageID: string; accepted: string[]; rejected: string[] }) => Promise<void>) {
  if (!account.enabled || prepared.envelope.from.toLowerCase() !== account.email.toLowerCase())
    throw new Error("Sender does not match the active GMX account")
  await verifyFiles(prepared.files)
  const password = await appPassword(account.secretID)
  const { createTransport } = await import("nodemailer")
  const transport = createTransport({
    host: "mail.gmx.net", port: 587, secure: false, requireTLS: true,
    auth: { user: account.email, pass: password },
    tls: { servername: "mail.gmx.net", rejectUnauthorized: true },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  })
  try {
    const result = await transport.sendMail({ raw: prepared.raw, envelope: prepared.envelope })
    if (!result.accepted.length) return { messageID: prepared.messageID, accepted: [], rejected: result.rejected.map(String), archive: "not-sent" as const }
    await onAccepted?.({ messageID: prepared.messageID, accepted: result.accepted.map(String), rejected: result.rejected.map(String) })
    return {
      messageID: prepared.messageID,
      accepted: result.accepted.map(String), rejected: result.rejected.map(String),
      // A failed Sent copy must never trigger a second SMTP submission.
      archive: account.sent ? await archive(account, prepared.raw, prepared.messageID).catch(() => "failed" as const) : "unconfigured" as const,
    }
  } finally {
    transport.close()
  }
}

function requireSender(account: Account, message: Outgoing) {
  if (!account.enabled || account.email.toLowerCase() !== message.from.toLowerCase())
    throw new Error("Sender does not match the active GMX account")
}

async function archive(account: Account, raw: Buffer, messageID: string) {
  return withInbox(account, async (client) => {
    if (!account.sent) return "unconfigured" as const
    await client.mailboxOpen(account.sent, { readOnly: true })
    const matches = await client.search({ header: { "Message-ID": messageID } })
    if (Array.isArray(matches) && matches.length) return "present" as const
    const result = await client.append(account.sent, raw, ["\\Seen"])
    if (!result) throw new Error("Sent copy outcome unknown")
    return "saved" as const
  })
}

// GMX rejects logins from connections that identified themselves as "imapflow" via
// IMAP ID beforehand, and it rejects AUTHENTICATE PLAIN for this account's app
// passwords - only the plain LOGIN command is accepted. The connection-options
// contract (identity + LOGIN) is pinned by test/mail/gmx-connection.test.ts.
export function inboxConnectionOptions(account: Account, password: string) {
  return {
    host: "imap.gmx.net",
    port: 993,
    secure: true,
    auth: { user: account.email, pass: password, loginMethod: "LOGIN" as const },
    logger: false as const,
    tls: { rejectUnauthorized: true, servername: "imap.gmx.net" },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    clientInfo: { name: "opencode-mail", vendor: "opencode" },
  }
}

export async function withInbox<T>(account: Account, run: (client: import("imapflow").ImapFlow) => Promise<T>) {
  if (!account.enabled) throw new Error("GMX account is disabled")
  const password = await appPassword(account.secretID)
  const { ImapFlow } = await import("imapflow")
  const client = new ImapFlow(inboxConnectionOptions(account, password))
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.logout().catch(() => undefined)
  }
}
