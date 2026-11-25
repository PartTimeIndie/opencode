import { describe, expect, test } from "bun:test"
import { PersistTesting } from "@/utils/persist"
import {
  MAX_PROMPT_INLINE_DATA_URL_BYTES,
  migratePromptStore,
  sanitizePromptStore,
  type PromptStore,
} from "./prompt-persist"

const dataUrl = (size: number) => `data:image/png;base64,${"a".repeat(size)}`

describe("prompt store persistence", () => {
  test("retains explicit archive extraction choice for source-backed drafts", () => {
    const archive = { type: "image" as const, id: "archive", filename: "save.7z", sourcePath: "C:/Temp/save.7z", mime: "application/x-7z-compressed", unpack: true }
    expect(sanitizePromptStore({ prompt: [archive], context: { items: [] } }).prompt[0]).toMatchObject({ unpack: true })
    expect(migratePromptStore({ prompt: [archive], context: { items: [] } }).prompt[0]).toMatchObject({ unpack: true })
  })
  test("sanitizes source-backed image data before persistence", () => {
    const store: PromptStore = {
      prompt: [
        { type: "text", content: "look", start: 0, end: 4 },
        {
          type: "image",
          id: "img_1",
          filename: "image.png",
          sourcePath: "C:\\Temp\\image.png",
          mime: "image/png",
          dataUrl: dataUrl(16),
        },
      ],
      cursor: 4,
      context: { items: [] },
    }

    expect(sanitizePromptStore(store).prompt).toEqual([
      { type: "text", content: "look", start: 0, end: 4 },
      { type: "image", id: "img_1", filename: "image.png", sourcePath: "C:\\Temp\\image.png", mime: "image/png" },
    ])
  })

  test("drops oversized inline data URLs on load", () => {
    const store = migratePromptStore({
      prompt: [
        { type: "text", content: "look", start: 0, end: 4 },
        { type: "image", id: "img_1", filename: "small.png", mime: "image/png", dataUrl: dataUrl(16) },
        {
          type: "image",
          id: "img_2",
          filename: "huge.png",
          mime: "image/png",
          dataUrl: dataUrl(MAX_PROMPT_INLINE_DATA_URL_BYTES),
        },
      ],
      context: { items: [] },
    })

    expect(store.prompt).toEqual([
      { type: "text", content: "look", start: 0, end: 4 },
      { type: "image", id: "img_1", filename: "small.png", mime: "image/png", dataUrl: dataUrl(16) },
    ])
  })

  test("keeps a default prompt when all loaded parts are removed", () => {
    const store = migratePromptStore({
      prompt: [
        {
          type: "image",
          id: "img_1",
          filename: "huge.png",
          mime: "image/png",
          dataUrl: dataUrl(MAX_PROMPT_INLINE_DATA_URL_BYTES),
        },
      ],
      context: { items: [] },
    })

    expect(store.prompt).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
  })

  test("write-time serialize strips oversized images from the persisted copy only", () => {
    const live: PromptStore = {
      prompt: [
        { type: "text", content: "look", start: 0, end: 4 },
        { type: "image", id: "img_small", filename: "small.png", mime: "image/png", dataUrl: dataUrl(16) },
        {
          type: "image",
          id: "img_huge",
          filename: "huge.png",
          mime: "image/png",
          dataUrl: dataUrl(MAX_PROMPT_INLINE_DATA_URL_BYTES),
        },
      ],
      cursor: 4,
      context: { items: [] },
    }

    const persisted = JSON.parse(
      PersistTesting.serializeValue(JSON.stringify(live), (value) => sanitizePromptStore(value as PromptStore)),
    ) as PromptStore

    expect(persisted.prompt).toEqual([
      { type: "text", content: "look", start: 0, end: 4 },
      { type: "image", id: "img_small", filename: "small.png", mime: "image/png", dataUrl: dataUrl(16) },
    ])
    expect(live.prompt).toHaveLength(3)
  })
})
