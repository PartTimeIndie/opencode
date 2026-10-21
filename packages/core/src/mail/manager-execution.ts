import { changeMailView, readOwnedMailView } from "./manager-view"
import { selectedMailAction } from "./manager"
import type { MailRef, MailView } from "./manager"

export type MailOwner = { sessionID: string; directory: string; revision: number }

export function managerSelection(view: MailView, values: Record<string, unknown>) {
  if (Object.keys(values).some((key) => !/^mail-\d+$/.test(key) && key !== "action" && key !== "destination" && key !== "wish_text" && key !== "wish_open" && key !== "apply"))
    throw new Error("Unexpected mail form value")
  const keys = view.rows.flatMap((row, index) => values[`mail-${index}`] === true ? [row.key] : [])
  if (view.rows.some((_, index) => values[`mail-${index}`] !== undefined && typeof values[`mail-${index}`] !== "boolean"))
    throw new Error("Invalid mail selection")
  if (Object.keys(values).some((key) => /^mail-\d+$/.test(key) && Number(key.slice(5)) >= view.rows.length))
    throw new Error("Invalid mail selection")
  return selectedMailAction(view, { keys, operation: values.action, destination: values.destination })
}

// An unknown row has crossed the durable provider-effect boundary. Never retry it automatically.
export async function applyMailView(input: { id: string; owner: MailOwner; values: Record<string, unknown>; state?: string },
  apply: (ref: MailRef, action: ReturnType<typeof selectedMailAction>["action"], destination?: string) => Promise<unknown>) {
  const view = await readOwnedMailView(input.id, input.owner, input.state)
  const selected = managerSelection(view, input.values)
  await changeMailView(input.id, input.owner, (current) => {
    if (current.state !== "ready") throw new Error("Mail action already started; inspect status before retrying")
  }, (current) => ({ ...current, state: "applying", result: selected.rows.map((row) => ({ key: row.key, status: "not_started" })) }), input.state)
  for (const row of selected.rows) {
    await changeMailView(input.id, input.owner, (current) => {
      if (current.state !== "applying" || !current.result?.some((item) => item.key === row.key && item.status === "not_started"))
        throw new Error("Mail action state changed")
    }, (current) => ({ ...current, result: current.result?.map((item) => item.key === row.key ? { ...item, status: "unknown" } : item) }), input.state)
    const outcome = await apply(row.ref, selected.action, selected.destination).then(
      () => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }),
    )
    await changeMailView(input.id, input.owner, () => {}, (current) => ({ ...current,
      state: outcome.ok ? current.state : "unknown",
      result: current.result?.map((item) => item.key === row.key ? {
        ...item, status: outcome.ok ? "completed" as const : "unknown" as const,
        ...(!outcome.ok ? { detail: outcome.error instanceof Error ? outcome.error.message : "Provider outcome unknown" } : {}),
      } : item),
    }), input.state)
    if (!outcome.ok) return readOwnedMailView(input.id, input.owner, input.state)
  }
  return changeMailView(input.id, input.owner, () => {}, (current) => ({ ...current, state: "completed" }), input.state)
}

export async function wishMailView(input: { id: string; owner: MailOwner; values: Record<string, unknown>; state?: string },
  queue: (text: string) => Promise<unknown>) {
  const text = input.values.wish_text
  if (typeof text !== "string" || !text.trim() || text.length > 4000 || input.values.wish_open !== "true")
    throw new Error("Write a wish and explicitly submit it")
  await changeMailView(input.id, input.owner, (current) => {
    if (current.state !== "ready") throw new Error("Mail view already used")
  }, (current) => ({ ...current, state: "unknown" }), input.state)
  await queue(text.trim())
  return changeMailView(input.id, input.owner, () => {}, (current) => ({ ...current, state: "completed" }), input.state)
}
