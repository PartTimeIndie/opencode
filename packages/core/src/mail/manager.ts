export type MailAction = "move" | "trash" | "archive" | "mark_read" | "mark_unread" | "star" | "unstar" | "add_label" | "remove_label"
export type MailRef =
  | { provider: "gmx"; accountID: string; mailbox: string; uid: number; uidValidity: string }
  | { provider: "gmail"; accountID: "gmail-default"; messageID: string; sourceLabel?: string }

export type MailRow = {
  key: string
  ref: MailRef
  from: string
  subject: string
  date?: string
  snippet: string
  unread: boolean
  starred: boolean
  attachments?: { name: string; size: number }[]
}

export type MailDestination = { id: string; label: string; kind: "folder" | "label" }

export type MailView = {
  id: string
  sessionID: string
  directory: string
  accountID: string
  address: string
  provider: "gmail" | "gmx"
  mailbox: string
  rows: MailRow[]
  destinations: MailDestination[]
  createdAt: number
  revision: number
  state: "ready" | "applying" | "completed" | "unknown" | "dismissed"
  result?: { key: string; status: "completed" | "unknown" | "not_started"; detail?: string }[]
}

export function selectedMailAction(view: MailView, input: { keys: unknown; operation: unknown; destination?: unknown }) {
  if (!Array.isArray(input.keys) || !input.keys.length || input.keys.length > 50 ||
    !input.keys.every((key) => typeof key === "string") || new Set(input.keys).size !== input.keys.length)
    throw new Error("Select 1 to 50 messages")
  const rows = input.keys.map((key) => view.rows.find((row) => row.key === key))
  if (rows.some((row) => !row)) throw new Error("Message selection is stale")
  const action = input.operation
  if (action !== "move" && action !== "trash" && action !== "archive" && action !== "mark_read" &&
      action !== "mark_unread" && action !== "star" && action !== "unstar" && action !== "add_label" && action !== "remove_label")
    throw new Error("Unsupported mail action")
  if ((action === "add_label" || action === "remove_label") && view.provider !== "gmail")
    throw new Error("Labels are only supported for Gmail")
  if (action === "trash" && view.mailbox === "trash") throw new Error("Already in Trash; permanent deletion is not supported")
  if (action === "move" || action === "add_label" || action === "remove_label") {
    if (typeof input.destination !== "string" || !view.destinations.some((item) => item.id === input.destination &&
      (view.provider === "gmx" ? item.kind === "folder" : item.kind === "label")))
      throw new Error("Choose an available destination")
  } else if (input.destination !== undefined && input.destination !== "") throw new Error("Unexpected destination")
  return { rows: rows as MailRow[], action: action as MailAction, destination: typeof input.destination === "string" ? input.destination : undefined }
}
