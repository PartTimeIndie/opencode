import { load } from "./accounts"
import { folders, withInbox } from "./gmx"
import type { MailAction, MailDestination, MailRef, MailRow } from "./manager"

export async function gmxAccount(id: string) {
  const account = (await load()).accounts.find((item) => item.id === id && item.enabled)
  if (!account) throw new Error("GMX account not configured or disabled")
  return account
}

export async function gmxDestinations(accountID: string) {
  const entries = await folders(await gmxAccount(accountID))
  return entries.map((entry): MailDestination => ({ id: entry.path, label: entry.path, kind: "folder" }))
}

export async function gmxSearch(input: { accountID: string; mailbox?: string; from?: string; subject?: string; since?: Date; limit?: number }) {
  const account = await gmxAccount(input.accountID)
  const available = await folders(account)
  const mailbox = input.mailbox ?? "INBOX"
  if (!available.some((item) => item.path === mailbox)) throw new Error("GMX folder is not available")
  return withInbox(account, async (client) => {
    const box = await client.mailboxOpen(mailbox, { readOnly: true })
    const ids = await client.search({ since: input.since ?? new Date(Date.now() - 30 * 86400_000),
      ...(input.from ? { from: input.from } : {}), ...(input.subject ? { subject: input.subject } : {}) }, { uid: true })
    if (!Array.isArray(ids)) return []
    const selected = ids.slice(-Math.min(Math.max(input.limit ?? 20, 1), 50)).reverse()
    const rows = await Promise.all(selected.map(async (uid) => {
      const value = await client.fetchOne(String(uid), { envelope: true, uid: true, flags: true }, { uid: true })
      if (!value || !value.envelope) return
      const ref: MailRef = { provider: "gmx", accountID: input.accountID, mailbox, uid,
        uidValidity: String(box.uidValidity) }
      const row: MailRow = { key: `${mailbox}:${uid}`, ref, from: value.envelope.from?.map((from) => from.address).join(", ") ?? "",
        subject: value.envelope.subject ?? "", date: value.envelope.date ? new Date(value.envelope.date).toISOString() : undefined, snippet: "",
        unread: !value.flags?.has("\\Seen"), starred: value.flags?.has("\\Flagged") ?? false }
      return row
    }))
    return rows.filter((row): row is MailRow => !!row)
  })
}

export async function gmxApply(ref: Extract<MailRef, { provider: "gmx" }>, action: MailAction, destination?: string) {
  const account = await gmxAccount(ref.accountID)
  return withInbox(account, async (client) => {
    const available = await client.list()
    if (!available.some((item) => item.path === ref.mailbox)) throw new Error("Source folder is no longer available")
    const box = await client.mailboxOpen(ref.mailbox)
    if (String(box.uidValidity) !== ref.uidValidity) throw new Error("Mailbox changed; search again")
    const message = await client.fetchOne(String(ref.uid), { envelope: true, flags: true }, { uid: true })
    if (!message || !message.envelope) throw new Error("Message is no longer available")
    if (action === "add_label" || action === "remove_label") throw new Error("GMX does not support Gmail labels")
    if (action === "move" || action === "archive" || action === "trash") {
      const target = action === "move" ? destination : action === "archive" ? account.archive : account.trash
      if (!target || !available.some((item) => item.path === target) || target === ref.mailbox)
        throw new Error("Destination folder is not configured or available")
      if (!client.capabilities.has("MOVE")) throw new Error("GMX server does not support safe MOVE")
      await client.messageMove(String(ref.uid), target, { uid: true })
      return { movedTo: target }
    }
    const flag = action === "mark_read" || action === "mark_unread" ? "\\Seen" : "\\Flagged"
    if (action === "mark_read" || action === "star") await client.messageFlagsAdd(String(ref.uid), [flag], { uid: true })
    else await client.messageFlagsRemove(String(ref.uid), [flag], { uid: true })
    return { flag, present: action === "mark_read" || action === "star" }
  })
}
