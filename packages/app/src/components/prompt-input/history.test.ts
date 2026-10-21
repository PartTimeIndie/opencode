import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import {
  canNavigateHistoryAtCursor,
  clonePromptParts,
  MAX_HISTORY_ENTRY_BYTES,
  migratePromptHistoryState,
  normalizePromptHistoryEntry,
  navigatePromptHistory,
  prependHistoryEntry,
  promptLength,
  resumeLastPromptEntry,
  type PromptHistoryComment,
  type ResumeLastPromptEntryInput,
} from "./history"

const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

const text = (value: string): Prompt => [{ type: "text", content: value, start: 0, end: value.length }]
const comment = (id: string, value = "note"): PromptHistoryComment => ({
  id,
  path: "src/a.ts",
  selection: { start: 2, end: 4 },
  comment: value,
  time: 1,
  origin: "review",
  preview: "const a = 1",
})

describe("prompt-input history", () => {
  test("prependHistoryEntry skips empty prompt and deduplicates consecutive entries", () => {
    const first = prependHistoryEntry([], DEFAULT_PROMPT)
    expect(first).toEqual([])

    const commentsOnly = prependHistoryEntry([], DEFAULT_PROMPT, [comment("c1")])
    expect(commentsOnly).toHaveLength(1)

    const withOne = prependHistoryEntry([], text("hello"))
    expect(withOne).toHaveLength(1)

    const deduped = prependHistoryEntry(withOne, text("hello"))
    expect(deduped).toBe(withOne)

    const dedupedComments = prependHistoryEntry(commentsOnly, DEFAULT_PROMPT, [comment("c1")])
    expect(dedupedComments).toBe(commentsOnly)
  })

  test("navigatePromptHistory restores saved prompt when moving down from newest", () => {
    const entries = [text("third"), text("second"), text("first")]
    const up = navigatePromptHistory({
      direction: "up",
      entries,
      historyIndex: -1,
      currentPrompt: text("draft"),
      currentComments: [comment("draft")],
      savedPrompt: null,
    })
    expect(up.handled).toBe(true)
    if (!up.handled) throw new Error("expected handled")
    expect(up.historyIndex).toBe(0)
    expect(up.cursor).toBe("start")
    expect(up.entry.comments).toEqual([])

    const down = navigatePromptHistory({
      direction: "down",
      entries,
      historyIndex: up.historyIndex,
      currentPrompt: text("ignored"),
      currentComments: [],
      savedPrompt: up.savedPrompt,
    })
    expect(down.handled).toBe(true)
    if (!down.handled) throw new Error("expected handled")
    expect(down.historyIndex).toBe(-1)
    expect(down.entry.prompt[0]?.type === "text" ? down.entry.prompt[0].content : "").toBe("draft")
    expect(down.entry.comments).toEqual([comment("draft")])
  })

  test("navigatePromptHistory keeps entry comments when moving through history", () => {
    const entries = [
      {
        prompt: text("with comment"),
        comments: [comment("c1")],
      },
    ]

    const up = navigatePromptHistory({
      direction: "up",
      entries,
      historyIndex: -1,
      currentPrompt: text("draft"),
      currentComments: [],
      savedPrompt: null,
    })

    expect(up.handled).toBe(true)
    if (!up.handled) throw new Error("expected handled")
    expect(up.entry.prompt[0]?.type === "text" ? up.entry.prompt[0].content : "").toBe("with comment")
    expect(up.entry.comments).toEqual([comment("c1")])
  })

  test("normalizePromptHistoryEntry supports legacy prompt arrays", () => {
    const entry = normalizePromptHistoryEntry(text("legacy"))
    expect(entry.prompt[0]?.type === "text" ? entry.prompt[0].content : "").toBe("legacy")
    expect(entry.comments).toEqual([])
  })

  test("prependHistoryEntry does not persist image data", () => {
    const entry = prependHistoryEntry([], [
      { type: "text", content: "look", start: 0, end: 4 },
      {
        type: "image",
        id: "1",
        filename: "img.png",
        sourcePath: "C:\\Temp\\img.png",
        mime: "image/png",
        dataUrl: "data:image/png;base64,abc",
      },
    ])

    expect(entry).toHaveLength(1)
    expect(normalizePromptHistoryEntry(entry[0]).prompt).toEqual([
      { type: "text", content: "look", start: 0, end: 4 },
      { type: "image", id: "1", filename: "img.png", sourcePath: "C:\\Temp\\img.png", mime: "image/png" },
    ])
  })

  test("prependHistoryEntry skips image-only and oversized prompts", () => {
    expect(
      prependHistoryEntry([], [
        { type: "image", id: "1", filename: "img.png", mime: "image/png", dataUrl: "data:image/png;base64,abc" },
      ]),
    ).toEqual([])

    expect(prependHistoryEntry([], text("x".repeat(MAX_HISTORY_ENTRY_BYTES)))).toEqual([])
  })

  test("migratePromptHistoryState strips legacy image data and keeps source links", () => {
    const state = migratePromptHistoryState({
      entries: [
        {
          prompt: [
            { type: "text", content: "look", start: 0, end: 4 },
            {
              type: "image",
              id: "1",
              filename: "img.png",
              sourcePath: "C:\\Temp\\img.png",
              mime: "image/png",
              dataUrl: "data:image/png;base64,abc",
            },
          ],
          comments: [],
        },
        text("x".repeat(MAX_HISTORY_ENTRY_BYTES)),
      ],
    })

    expect(state.entries).toHaveLength(1)
    expect(normalizePromptHistoryEntry(state.entries[0]).prompt).toEqual([
      { type: "text", content: "look", start: 0, end: 4 },
      { type: "image", id: "1", filename: "img.png", sourcePath: "C:\\Temp\\img.png", mime: "image/png" },
    ])
  })

  test("helpers clone prompt and count text content length", () => {
    const original: Prompt = [
      { type: "text", content: "one", start: 0, end: 3 },
      {
        type: "file",
        path: "src/a.ts",
        content: "@src/a.ts",
        start: 3,
        end: 12,
        selection: { startLine: 1, startChar: 1, endLine: 2, endChar: 1 },
      },
      { type: "image", id: "1", filename: "img.png", mime: "image/png", dataUrl: "data:image/png;base64,abc" },
    ]
    const copy = clonePromptParts(original)
    expect(copy).not.toBe(original)
    expect(promptLength(copy)).toBe(12)
    if (copy[1]?.type !== "file") throw new Error("expected file")
    copy[1].selection!.startLine = 9
    if (original[1]?.type !== "file") throw new Error("expected file")
    expect(original[1].selection?.startLine).toBe(1)
  })

  test("canNavigateHistoryAtCursor only allows prompt boundaries", () => {
    const value = "a\nb\nc"

    expect(canNavigateHistoryAtCursor("up", value, 0)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", value, 0)).toBe(false)

    expect(canNavigateHistoryAtCursor("up", value, 2)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", value, 2)).toBe(false)

    expect(canNavigateHistoryAtCursor("up", value, 5)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", value, 5)).toBe(true)

    expect(canNavigateHistoryAtCursor("up", "abc", 0)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", "abc", 3)).toBe(true)
    expect(canNavigateHistoryAtCursor("up", "abc", 1)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", "abc", 1)).toBe(false)

    expect(canNavigateHistoryAtCursor("up", "", 0)).toBe(true)
    expect(canNavigateHistoryAtCursor("down", "", 0)).toBe(true)

    expect(canNavigateHistoryAtCursor("up", "abc", 0, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("up", "abc", 3, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("down", "abc", 0, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("down", "abc", 3, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("up", "abc", 1, true)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", "abc", 1, true)).toBe(false)
  })

  test("resumeLastPromptEntry returns the newest entry for an idle empty composer", () => {
    const entry = resumeLastPromptEntry(resumeInput())
    expect(entry?.prompt[0]?.type === "text" ? entry.prompt[0].content : "").toBe("latest")
  })

  test("resumeLastPromptEntry refuses when the composer is not idle and empty", () => {
    expect(resumeLastPromptEntry(resumeInput({ mode: "shell" }))).toBeUndefined()
    expect(resumeLastPromptEntry(resumeInput({ working: true }))).toBeUndefined()
    expect(resumeLastPromptEntry(resumeInput({ historyIndex: 0 }))).toBeUndefined()
    expect(resumeLastPromptEntry(resumeInput({ hasSession: false }))).toBeUndefined()
    expect(resumeLastPromptEntry(resumeInput({ blank: false }))).toBeUndefined()
    expect(resumeLastPromptEntry(resumeInput({ hasPendingContext: true }))).toBeUndefined()
    expect(resumeLastPromptEntry(resumeInput({ entries: [] }))).toBeUndefined()
  })

  test("resumeLastPromptEntry keeps entry comments and refuses empty entries", () => {
    const withComment = resumeInput({ entries: [{ prompt: text("with comment"), comments: [comment("c1")] }] })
    expect(resumeLastPromptEntry(withComment)?.comments).toEqual([comment("c1")])
    expect(resumeLastPromptEntry(resumeInput({ entries: [DEFAULT_PROMPT] }))).toBeUndefined()
  })
})

const resumeInput = (overrides: Partial<ResumeLastPromptEntryInput> = {}): ResumeLastPromptEntryInput => ({
  mode: "normal",
  working: false,
  historyIndex: -1,
  hasSession: true,
  blank: true,
  hasPendingContext: false,
  entries: [text("latest")],
  ...overrides,
})
