import type { ContentPart, ContextItem, FileAttachmentPart, ImageAttachmentPart, Prompt } from "./prompt"

export const MAX_PROMPT_INLINE_DATA_URL_BYTES = 256 * 1024

export type PromptStore = {
  prompt: Prompt
  cursor?: number
  context: {
    items: (ContextItem & { key: string })[]
  }
}

function defaultPrompt(): Prompt {
  return [{ type: "text", content: "", start: 0, end: 0 }]
}

function cloneSelection(selection: FileAttachmentPart["selection"]) {
  if (!selection) return undefined
  return { ...selection }
}

function clonePart(part: ContentPart): ContentPart {
  if (part.type === "text") return { ...part }
  if (part.type === "image") return { ...part }
  if (part.type === "agent") return { ...part }
  return {
    ...part,
    selection: cloneSelection(part.selection),
  }
}

function dataUrlSize(value: string) {
  return value.length * 2
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function persistedImagePart(part: ImageAttachmentPart): ImageAttachmentPart | undefined {
  if (part.annotation) return { type: "image", id: part.id, filename: part.filename, mime: "image/png", annotation: { ...part.annotation } }
  if (part.sourcePath) {
    return {
      type: "image",
      id: part.id,
      filename: part.filename,
      sourcePath: part.sourcePath,
      mime: part.mime,
      ...(part.unpack ? { unpack: true } : {}),
    }
  }
  if (!part.dataUrl || dataUrlSize(part.dataUrl) > MAX_PROMPT_INLINE_DATA_URL_BYTES) return
  return { ...part }
}

function persistedPart(part: ContentPart) {
  if (part.type === "image") return persistedImagePart(part)
  return clonePart(part)
}

export function promptStore(): PromptStore {
  return {
    prompt: defaultPrompt(),
    cursor: undefined,
    context: {
      items: [],
    },
  }
}

export function sanitizePromptStore(store: PromptStore): PromptStore {
  const prompt = store.prompt.flatMap((part) => {
    if (!isRecord(part)) return []
    const next = persistedPart(part as ContentPart)
    return next ? [next] : []
  })
  return {
    prompt: prompt.length ? prompt : defaultPrompt(),
    cursor: store.cursor,
    context: {
      items: store.context.items.map((item) => ({ ...item, selection: cloneSelection(item.selection) })),
    },
  }
}

export function migratePromptStore(value: unknown): PromptStore {
  if (!isRecord(value)) return promptStore()
  return sanitizePromptStore({
    prompt: Array.isArray(value.prompt) ? (value.prompt as Prompt) : promptStore().prompt,
    cursor: typeof value.cursor === "number" ? value.cursor : undefined,
    context: {
      items:
        isRecord(value.context) && Array.isArray(value.context.items)
          ? (value.context.items as (ContextItem & { key: string })[])
          : [],
    },
  })
}
