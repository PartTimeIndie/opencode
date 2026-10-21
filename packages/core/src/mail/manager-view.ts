import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Global } from "../global"
import { Flock } from "../util/flock"
import type { MailView } from "./manager"

const root = (state = Global.Path.state) => join(state, "mail-manager")
const file = (id: string, state?: string) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid mail view")
  return join(root(state), `${id}.json`)
}

export async function createMailView(input: Omit<MailView, "id" | "state" | "revision" | "createdAt">, state?: string) {
  const view: MailView = { ...input, id: crypto.randomUUID(), state: "ready", revision: 1, createdAt: Date.now() }
  requireView(view)
  await mkdir(root(state), { recursive: true, mode: 0o700 })
  await writeFile(file(view.id, state), JSON.stringify(view), { mode: 0o600, flag: "wx" })
  return view
}

export async function readMailView(id: string, state?: string) {
  const value: unknown = JSON.parse(await readFile(file(id, state), "utf8"))
  requireView(value)
  if (value.id !== id) throw new Error("Invalid mail view")
  if (value.createdAt + 24 * 60 * 60 * 1000 < Date.now()) throw new Error("Mail view expired; search again")
  return value
}

export async function readOwnedMailView(id: string, owner: { sessionID: string; directory: string; revision: number }, state?: string) {
  const view = await readMailView(id, state)
  mailViewOwner(view, owner)
  return view
}

export async function changeMailView(id: string, owner: { sessionID: string; directory: string; revision: number },
  check: (view: MailView) => void, update: (view: MailView) => MailView, state?: string) {
  return Flock.withLock(`mail-manager:${state ?? "global"}:${id}`, async () => {
    const view = await readOwnedMailView(id, owner, state)
    check(view)
    const next = update(view)
    requireView(next)
    if (next.id !== view.id || next.sessionID !== view.sessionID || next.directory !== view.directory ||
      next.accountID !== view.accountID || next.provider !== view.provider || next.mailbox !== view.mailbox ||
      next.address !== view.address || JSON.stringify(next.rows) !== JSON.stringify(view.rows) ||
      JSON.stringify(next.destinations) !== JSON.stringify(view.destinations) ||
      next.createdAt !== view.createdAt || next.revision !== view.revision)
      throw new Error("Mail view identity cannot change")
    const tmp = `${file(id, state)}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(next), { mode: 0o600, flag: "wx" })
      await rename(tmp, file(id, state))
    } finally {
      await rm(tmp, { force: true })
    }
    return next
  })
}

export function mailViewOwner(view: MailView, input: { sessionID: string; directory: string; revision: number }) {
  if (view.sessionID !== input.sessionID || view.directory !== input.directory || view.revision !== input.revision)
    throw new Error("Mail view does not belong to this Session or revision")
}

function requireView(value: unknown): asserts value is MailView {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mail view")
  const view = value as Partial<MailView>
  if (typeof view.id !== "string" || !/^[0-9a-f-]{36}$/.test(view.id) ||
    typeof view.sessionID !== "string" || !view.sessionID || typeof view.directory !== "string" || !view.directory ||
    typeof view.accountID !== "string" || !view.accountID || typeof view.address !== "string" || !view.address ||
    (view.provider !== "gmail" && view.provider !== "gmx") || typeof view.mailbox !== "string" || !view.mailbox ||
    typeof view.createdAt !== "number" || !Number.isFinite(view.createdAt) || view.createdAt > Date.now() + 60_000 ||
    view.revision !== 1 || !["ready", "applying", "completed", "unknown", "dismissed"].includes(view.state ?? "") ||
    !Array.isArray(view.rows) || view.rows.length > 50 || !Array.isArray(view.destinations) || view.destinations.length > 100 ||
    new Set(view.rows.map((row) => row?.key)).size !== view.rows.length) throw new Error("Invalid mail view")
  if (view.rows.some((row) => !row || typeof row.key !== "string" || !row.key ||
    typeof row.from !== "string" || typeof row.subject !== "string" || typeof row.snippet !== "string" ||
    typeof row.unread !== "boolean" || typeof row.starred !== "boolean" || !row.ref ||
    row.ref.provider !== view.provider || row.ref.accountID !== view.accountID ||
    (row.ref.provider === "gmx" ?
      row.ref.mailbox !== view.mailbox || !Number.isSafeInteger(row.ref.uid) || row.ref.uid <= 0 || !row.ref.uidValidity :
      !row.ref.messageID || typeof row.ref.messageID !== "string"))) throw new Error("Invalid mail view")
  if (view.destinations.some((dest) => !dest || typeof dest.id !== "string" || !dest.id ||
    typeof dest.label !== "string" || dest.kind !== (view.provider === "gmx" ? "folder" : "label")))
    throw new Error("Invalid mail view")
  if (view.result !== undefined && (!Array.isArray(view.result) || view.result.length > view.rows.length ||
    view.result.some((result) => !result || typeof result.key !== "string" || !view.rows!.some((row) => row.key === result.key) ||
      !["completed", "unknown", "not_started"].includes(result.status)))) throw new Error("Invalid mail view")
}
