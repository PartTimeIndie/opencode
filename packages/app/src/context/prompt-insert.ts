import type { Prompt } from "./prompt"

const insertions = new WeakMap<object, { snapshot: string; text: string; start: number }>()
const sessionInsertions = new Map<string, { snapshot: string; text: string; start: number }>()
const MAX_SESSION_INSERTION_ANCHORS = 256

export function promptInsertionIdentity(input: {
  serverID: string
  directory: string
  sessionID?: string
  composerID?: string
}) {
  return JSON.stringify([input.serverID, input.directory, input.sessionID, input.composerID])
}

/** Edit draft data without mounting/focusing a composer or flattening attachment tokens. */
export function insertPromptDraft(
  state: { current(): Prompt; cursor(): number | undefined; set(prompt: Prompt, cursor: number): void },
  input: { text: string; position?: "cursor" | "end"; replace?: string },
  identity: string | object = state,
) {
  const text = input.text.trim()
  if (!text) return { ok: false, error: "Transcript is empty" }
  const parts = state.current()
  const content = parts.map((part) => ("content" in part ? part.content : "")).join("")
  const replacement = input.replace?.trim()
  const previous = typeof identity === "string" ? sessionInsertions.get(identity) : insertions.get(identity)
  // Replacement identity is the recorded insertion, never a matching phrase elsewhere.
  // Without an edit history, concurrent draft changes invalidate the whole anchor.
  if (replacement && (!previous || previous.text !== replacement || previous.snapshot !== JSON.stringify(parts)))
    return { ok: false, error: "The original transcript has changed or is no longer anchored in this draft" }
  const index = replacement ? previous!.start : -1
  const start =
    index >= 0
      ? index
      : input.position === "end"
        ? content.length
        : Math.max(0, Math.min(state.cursor() ?? content.length, content.length))
  const end = index >= 0 ? start + replacement!.length : start
  const before = content.slice(0, start)
  const after = content.slice(end)
  const inserted =
    index >= 0 ? text : `${before && !/\s$/.test(before) ? " " : ""}${text}${after && !/^\s/.test(after) ? " " : ""}`
  const next: Prompt = []
  let offset = 0
  let written = false
  let position = 0
  const append = (part: Prompt[number]) => {
    if (part.type === "image") {
      next.push(part)
      return
    }
    next.push({ ...part, start: position, end: position + part.content.length })
    position += part.content.length
  }
  for (const part of parts) {
    if (part.type === "image") {
      append(part)
      continue
    }
    const limit = offset + part.content.length
    if (
      part.type !== "text" &&
      ((start > offset && start < limit) || (end > offset && end < limit) || (start < limit && end > offset))
    )
      return { ok: false, error: "Transcript insertion would alter a file or agent reference" }
    if (limit < start || offset > end) append(part)
    else {
      if (start > offset) append({ ...part, content: part.content.slice(0, start - offset) })
      if (!written) {
        append({ type: "text", content: inserted, start: 0, end: 0 })
        written = true
      }
      if (limit > end) append({ ...part, content: part.content.slice(Math.max(0, end - offset)) })
    }
    offset = limit
  }
  if (!written) append({ type: "text", content: inserted, start: 0, end: 0 })
  state.set(next, start + inserted.length)
  const anchor = { snapshot: JSON.stringify(state.current()), text, start: start + inserted.indexOf(text) }
  if (typeof identity !== "string") {
    insertions.set(identity, anchor)
    return { ok: true }
  }
  sessionInsertions.delete(identity)
  sessionInsertions.set(identity, anchor)
  if (sessionInsertions.size > MAX_SESSION_INSERTION_ANCHORS)
    sessionInsertions.delete(sessionInsertions.keys().next().value!)
  return { ok: true }
}
