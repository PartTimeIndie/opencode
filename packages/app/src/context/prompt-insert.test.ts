import { expect, test } from "bun:test"
import type { Prompt } from "./prompt"
import { insertPromptDraft, promptInsertionIdentity } from "./prompt-insert"

function draft(prompt: Prompt, cursor?: number) {
  return {
    current: () => prompt,
    cursor: () => cursor,
    set(next: Prompt, position: number) {
      prompt = next
      cursor = position
    },
  }
}

test("background insertion changes only the pinned draft and preserves attachments/context tokens", () => {
  const image = { type: "image" as const, id: "image", filename: "a.png", mime: "image/png" }
  const pinned = draft([{ type: "text", content: "hello world", start: 0, end: 11 }, image], 5)
  const other = draft([{ type: "text", content: "untouched", start: 0, end: 9 }])
  expect(insertPromptDraft(pinned, { text: "dictation" })).toEqual({ ok: true })
  expect(
    pinned
      .current()
      .filter((part) => part.type === "text")
      .map((part) => part.content)
      .join(""),
  ).toBe("hello dictation world")
  expect(pinned.cursor()).toBe(15)
  expect(pinned.current()).toContainEqual(image)
  expect(other.current()[0]).toEqual({ type: "text", content: "untouched", start: 0, end: 9 })
})

test("polishing replaces only the anchored insertion and never edited-away text or reference tokens", () => {
  const pinned = draft([])
  expect(insertPromptDraft(pinned, { text: "old words" }).ok).toBe(true)
  expect(insertPromptDraft(pinned, { text: "new", replace: "old words" })).toEqual({ ok: true })
  expect(pinned.current()).toEqual([{ type: "text", content: "new", start: 0, end: 3 }])
  expect(insertPromptDraft(pinned, { text: "duplicate", replace: "old words" }).ok).toBe(false)
  const reference = draft([{ type: "agent", name: "worker", content: "@worker", start: 0, end: 7 }], 3)
  expect(insertPromptDraft(reference, { text: "oops" }).ok).toBe(false)
  expect(insertPromptDraft(reference, { text: "next", position: "end" }).ok).toBe(true)
  expect(reference.current()[0]).toEqual({ type: "agent", name: "worker", content: "@worker", start: 0, end: 7 })
})

test("shares replacement anchors across wrappers for the same prompt session only", () => {
  const store: { prompt: Prompt; cursor?: number } = { prompt: [] }
  const wrapper = () => ({
    current: () => store.prompt,
    cursor: () => store.cursor,
    set(next: Prompt, position: number) {
      store.prompt = next
      store.cursor = position
    },
  })
  const session = promptInsertionIdentity({
    serverID: "server-a",
    directory: "directory-a",
    sessionID: "session-a",
    composerID: "session-a",
  })
  const otherTab = promptInsertionIdentity({
    serverID: "server-a",
    directory: "directory-a",
    sessionID: "session-b",
    composerID: "session-b",
  })

  expect(insertPromptDraft(wrapper(), { text: "dictated words" }, session)).toEqual({ ok: true })
  expect(insertPromptDraft(wrapper(), { text: "polished words", replace: "dictated words" }, session)).toEqual({ ok: true })
  expect(store.prompt).toEqual([{ type: "text", content: "polished words", start: 0, end: 14 }])
  expect(insertPromptDraft(wrapper(), { text: "wrong tab", replace: "polished words" }, otherTab).ok).toBe(false)
})

test("keeps replacement anchors separate by server, directory, session, and composer", () => {
  const store: { prompt: Prompt; cursor?: number } = { prompt: [] }
  const wrapper = () => ({
    current: () => store.prompt,
    cursor: () => store.cursor,
    set(next: Prompt, position: number) {
      store.prompt = next
      store.cursor = position
    },
  })
  const identity = (serverID: string, directory: string, sessionID = "session", composerID = "session") =>
    promptInsertionIdentity({ serverID, directory, sessionID, composerID })

  expect(insertPromptDraft(wrapper(), { text: "dictated words" }, identity("server-a", "directory-a"))).toEqual({ ok: true })
  for (const other of [
    identity("server-b", "directory-a"),
    identity("server-a", "directory-b"),
    identity("server-a", "directory-a", "other-session", "session"),
    identity("server-a", "directory-a", "session", "other-composer"),
  ])
    expect(insertPromptDraft(wrapper(), { text: "wrong scope", replace: "dictated words" }, other).ok).toBe(false)
  expect(insertPromptDraft(wrapper(), { text: "polished words", replace: "dictated words" }, identity("server-a", "directory-a"))).toEqual({
    ok: true,
  })
  expect(store.prompt).toEqual([{ type: "text", content: "polished words", start: 0, end: 14 }])
})

test("evicts the oldest replacement anchor beyond the session cache limit", () => {
  const stores = new Map<string, { prompt: Prompt; cursor?: number }>()
  const wrapper = (sessionID: string) => {
    const store = stores.get(sessionID) ?? { prompt: [], cursor: undefined }
    stores.set(sessionID, store)
    return {
      current: () => store.prompt,
      cursor: () => store.cursor,
      set(next: Prompt, position: number) {
        store.prompt = next
        store.cursor = position
      },
    }
  }
  const identity = (sessionID: string) =>
    promptInsertionIdentity({ serverID: "server-a", directory: "directory-a", sessionID, composerID: sessionID })
  for (let index = 0; index <= 256; index += 1)
    expect(insertPromptDraft(wrapper(`session-${index}`), { text: `dictated ${index}` }, identity(`session-${index}`))).toEqual({
      ok: true,
    })
  expect(insertPromptDraft(wrapper("session-0"), { text: "polished", replace: "dictated 0" }, identity("session-0")).ok).toBe(false)
  expect(
    insertPromptDraft(wrapper("session-256"), { text: "polished", replace: "dictated 256" }, identity("session-256")),
  ).toEqual({ ok: true })
})

test("identical pre-existing text is not an insertion anchor and unrelated edits invalidate stale anchors", () => {
  const pinned = draft([{ type: "text", content: "same words", start: 0, end: 10 }])
  expect(insertPromptDraft(pinned, { text: "oops", replace: "same words" }).ok).toBe(false)
  expect(insertPromptDraft(pinned, { text: "same words", position: "end" }).ok).toBe(true)
  expect(insertPromptDraft(pinned, { text: "polished", replace: "same words" }).ok).toBe(true)
  expect(
    pinned
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join(""),
  ).toBe("same words polished")
  pinned.set([{ type: "text", content: "new intro same words polished", start: 0, end: 28 }], 0)
  expect(insertPromptDraft(pinned, { text: "again", replace: "polished" }).ok).toBe(false)
})

test("polishing cannot overwrite an unrelated duplicate after the dictated occurrence is edited away", () => {
  const pinned = draft([{ type: "text", content: "same words", start: 0, end: 10 }])
  expect(insertPromptDraft(pinned, { text: "same words", position: "end" }).ok).toBe(true)
  pinned.set([{ type: "text", content: "same words user edit", start: 0, end: 20 }], 20)
  const before = structuredClone(pinned.current())
  expect(insertPromptDraft(pinned, { text: "polished", replace: "same words" }).ok).toBe(false)
  expect(pinned.current()).toEqual(before)
  expect(pinned.cursor()).toBe(20)
})
