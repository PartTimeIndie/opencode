import { gmailRequest, gmailToken } from "./gmail-client"
import type { MailAction, MailDestination, MailRef, MailRow } from "./manager"

const base = "/gmail/v1/users/me/"
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

export async function gmailIdentity() {
  const profile = await gmailRequest(await gmailToken(), `${base}profile`)
  if (typeof profile.emailAddress !== "string") throw new Error("Gmail account identity is unavailable")
  return profile.emailAddress
}

export async function gmailDestinations() {
  const result = await gmailRequest(await gmailToken(), `${base}labels`)
  return Array.isArray(result.labels) ? result.labels.flatMap((value): MailDestination[] =>
    record(value) && value.type === "user" && typeof value.id === "string" && typeof value.name === "string"
      ? [{ id: value.id, label: value.name, kind: "label" }] : []) : []
}

export async function gmailSearch(input: { from?: string; subject?: string; since?: Date; limit?: number; labelID?: string }) {
  const token = await gmailToken()
  const q = [input.from ? `from:${input.from}` : "", input.subject ? `subject:${JSON.stringify(input.subject)}` : "",
    `after:${Math.floor((input.since ?? new Date(Date.now() - 30 * 86400_000)).getTime() / 1000)}`].filter(Boolean).join(" ")
  const url = new URLSearchParams({ q, maxResults: String(Math.min(Math.max(input.limit ?? 20, 1), 50)),
    ...(input.labelID ? { labelIds: input.labelID } : { labelIds: "INBOX" }) })
  const result = await gmailRequest(token, `${base}messages?${url}`)
  if (!Array.isArray(result.messages)) return []
  const rows = await Promise.all(result.messages.slice(0, 50).flatMap((item) => record(item) && typeof item.id === "string" ? [item.id] : []).map(async (id) => {
    const details = await gmailRequest(token, `${base}messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)
    const headers = record(details.payload) && Array.isArray(details.payload.headers) ? details.payload.headers : []
    const header = (name: string) => headers.find((entry) => record(entry) && entry.name === name)
    const text = (name: string) => { const entry = header(name); return record(entry) && typeof entry.value === "string" ? entry.value : "" }
    const labels = strings(details.labelIds)
    const ref: MailRef = { provider: "gmail", accountID: "gmail-default", messageID: id,
      ...(input.labelID ? { sourceLabel: input.labelID } : { sourceLabel: "INBOX" }) }
    const row: MailRow = { key: id, ref, from: text("From"), subject: text("Subject"), date: text("Date"),
      snippet: typeof details.snippet === "string" ? details.snippet.slice(0, 350) : "",
      unread: labels.includes("UNREAD"), starred: labels.includes("STARRED") }
    return row
  }))
  return rows
}

export async function gmailApply(ref: Extract<MailRef, { provider: "gmail" }>, action: MailAction, destination?: string) {
  const token = await gmailToken()
  const path = `${base}messages/${encodeURIComponent(ref.messageID)}`
  const current = await gmailRequest(token, `${path}?format=metadata`)
  const labels = strings(current.labelIds)
  requireSourceLabel(ref, labels)
  if (action === "trash") {
    if (labels.includes("TRASH")) throw new Error("Already in Trash; permanent deletion is not supported")
    await gmailRequest(token, `${path}/trash`, { method: "POST" })
    return { trashed: true }
  }

  if ((action === "move" || action === "add_label" || action === "remove_label") &&
      (!destination || !(await gmailDestinations()).some((item) => item.id === destination)))
    throw new Error("Gmail label is not available")
  const addLabelIds = action === "move" || action === "add_label" ? [destination!] :
    action === "mark_unread" ? ["UNREAD"] : action === "star" ? ["STARRED"] : []
  const removeLabelIds = action === "move" || action === "archive" ? [ref.sourceLabel!] :
    action === "remove_label" ? [destination!] : action === "mark_read" ? ["UNREAD"] : action === "unstar" ? ["STARRED"] : []
  await gmailRequest(token, `${path}/modify`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ addLabelIds, removeLabelIds }) })
  return { addLabelIds, removeLabelIds }
}

export function requireSourceLabel(ref: Extract<MailRef, { provider: "gmail" }>, labels: readonly string[]) {
  if (!ref.sourceLabel || !labels.includes(ref.sourceLabel)) throw new Error("Source label changed; search again")
}
