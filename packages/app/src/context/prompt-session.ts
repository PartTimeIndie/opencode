// Session-scoped composer prompt stores. Kept free of router and app-shell imports so async
// continuations (e.g. move-session success handlers) can create prompt sessions outside the
// routed component tree with an explicit platform; hydration itself still needs a Solid root.
import { batch, createMemo, createRoot, getOwner } from "solid-js"
import { checksum } from "@opencode-ai/core/util/encode"
import { createStore, type SetStoreFunction } from "solid-js/store"
import type { FileSelection } from "@/context/file"
import type { Platform } from "@/context/platform"
import { Persist, persisted, type PersistTarget } from "@/utils/persist"
import type { ServerScope } from "@/utils/server-scope"
import { migratePromptStore, promptStore, sanitizePromptStore, type PromptStore } from "./prompt-persist"
import { clearDraftPromptSubmitState } from "@/components/prompt-input/submit-state"
import type { ContentPart, ContextItem, FileContextItem, Prompt } from "./prompt"

export const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

function isSelectionEqual(a?: FileSelection, b?: FileSelection) {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.startLine === b.startLine && a.startChar === b.startChar && a.endLine === b.endLine && a.endChar === b.endChar
  )
}

function isPartEqual(partA: ContentPart, partB: ContentPart) {
  switch (partA.type) {
    case "text":
      return partB.type === "text" && partA.content === partB.content
    case "file":
      return partB.type === "file" && partA.path === partB.path && isSelectionEqual(partA.selection, partB.selection)
    case "agent":
      return partB.type === "agent" && partA.name === partB.name
    case "image":
      return partB.type === "image" && partA.id === partB.id
  }
}

export function isPromptEqual(promptA: Prompt, promptB: Prompt): boolean {
  if (promptA.length !== promptB.length) return false
  for (let i = 0; i < promptA.length; i++) {
    if (!isPartEqual(promptA[i], promptB[i])) return false
  }
  return true
}

function cloneSelection(selection?: FileSelection) {
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

function clonePrompt(prompt: Prompt): Prompt {
  return prompt.map(clonePart)
}

function contextItemKey(item: ContextItem) {
  if (item.type !== "file") return item.type
  const start = item.selection?.startLine
  const end = item.selection?.endLine
  const key = `${item.type}:${item.path}:${start}:${end}`

  if (item.commentID) {
    return `${key}:c=${item.commentID}`
  }

  const comment = item.comment?.trim()
  if (!comment) return key
  const digest = checksum(comment) ?? comment
  return `${key}:c=${digest.slice(0, 8)}`
}

function isCommentItem(item: ContextItem | (ContextItem & { key: string })) {
  return item.type === "file" && !!item.comment?.trim()
}

function createPromptActions(
  setStore: SetStoreFunction<{
    prompt: Prompt
    cursor?: number
    context: {
      items: (ContextItem & { key: string })[]
    }
  }>,
) {
  return {
    set(prompt: Prompt, cursorPosition?: number) {
      batch(() => {
        setStore("prompt", clonePrompt(prompt))
        if (cursorPosition !== undefined) setStore("cursor", cursorPosition)
      })
    },
    reset() {
      batch(() => {
        setStore("prompt", clonePrompt(DEFAULT_PROMPT))
        setStore("cursor", 0)
      })
    },
  }
}

const WORKSPACE_KEY = "__workspace__"
export const MAX_PROMPT_SESSIONS = 20

type PromptSession = ReturnType<typeof createPromptSession>

export type Scope = { draftID: string } | { dir: string; id?: string }

export function scopeKey(scope: Scope) {
  if ("draftID" in scope) return `draft:${scope.draftID}`
  return `${scope.dir}:${scope.id ?? WORKSPACE_KEY}`
}

export type PromptCacheEntry = {
  value: PromptSession
  dispose: VoidFunction
}

const draftPromptCache = new Map<string, PromptCacheEntry>()
const sessionPromptCache = new Map<string, PromptCacheEntry & { refs: number }>()

// The composer and asynchronous host insertion must share the same live store.
// A separate persisted instance could overwrite newer edits after hydration.
// The platform is passed explicitly because callers may create sessions from async
// continuations where no provider is reachable through the Solid owner chain.
export function acquirePromptSession(serverScope: ServerScope, scope: Scope, platform: Platform): PromptCacheEntry {
  if ("draftID" in scope) return { value: loadDraftPromptSession(scope.draftID, platform), dispose() {} }
  const key = JSON.stringify([serverScope, scope.dir, scope.id])
  const entry =
    sessionPromptCache.get(key) ??
    createRoot(
      (dispose) => ({ value: createPromptSession(serverScope, scope, platform), dispose, refs: 0 }),
      getOwner(),
    )
  sessionPromptCache.set(key, entry)
  entry.refs += 1
  let released = false
  return {
    value: entry.value,
    dispose() {
      if (released) return
      released = true
      entry.refs -= 1
      if (entry.refs) return
      sessionPromptCache.delete(key)
      entry.dispose()
    },
  }
}

function promptTarget(serverScope: ServerScope | undefined, scope: Scope): PersistTarget {
  const serialize = (value: unknown) => sanitizePromptStore(value as PromptStore)
  if ("draftID" in scope) return { ...Persist.draft(scope.draftID, "prompt"), serialize }
  if (!serverScope) throw new Error("Prompt server scope is required")
  const legacy = `${scope.dir}/prompt${scope.id ? "/" + scope.id : ""}.v2`
  return { ...Persist.serverScoped(serverScope, scope.dir, scope.id, "prompt", [legacy]), serialize }
}

function createPromptSession(serverScope: ServerScope | undefined, scope: Scope, platform: Platform) {
  const [store, setStore, _, ready] = persisted(
    { ...promptTarget(serverScope, scope), migrate: migratePromptStore },
    createStore<PromptStore>(promptStore()),
    platform,
  )

  return { ready, ...createPromptStateValue(store, setStore) }
}

export function loadDraftPromptSession(draftID: string, platform: Platform) {
  const existing = draftPromptCache.get(draftID)
  if (existing) return existing.value

  const entry = createRoot(
    (dispose) => ({
      value: createPromptSession(undefined, { draftID }, platform),
      dispose,
    }),
    getOwner(),
  )
  draftPromptCache.set(draftID, entry)
  return entry.value
}

export function clearDraftPromptState(draftID: string) {
  clearDraftPromptSubmitState(draftID)
  const entry = draftPromptCache.get(draftID)
  if (!entry) return
  entry.dispose()
  draftPromptCache.delete(draftID)
}

function createPromptStateValue(store: PromptStore, setStore: SetStoreFunction<PromptStore>) {
  const actions = createPromptActions(setStore)

  return {
    current: () => store.prompt,
    cursor: createMemo(() => store.cursor),
    dirty: () => !isPromptEqual(store.prompt, DEFAULT_PROMPT),
    context: {
      items: createMemo(() => store.context.items),
      add(item: ContextItem) {
        const key = contextItemKey(item)
        if (store.context.items.find((x) => x.key === key)) return
        setStore("context", "items", (items) => [...items, { key, ...item }])
      },
      remove(key: string) {
        setStore("context", "items", (items) => items.filter((x) => x.key !== key))
      },
      removeComment(path: string, commentID: string) {
        setStore("context", "items", (items) =>
          items.filter((item) => !(item.type === "file" && item.path === path && item.commentID === commentID)),
        )
      },
      updateComment(path: string, commentID: string, next: Partial<FileContextItem> & { comment?: string }) {
        setStore("context", "items", (items) =>
          items.map((item) => {
            if (item.type !== "file" || item.path !== path || item.commentID !== commentID) return item
            const value = { ...item, ...next }
            return { ...value, key: contextItemKey(value) }
          }),
        )
      },
      replaceComments(items: FileContextItem[]) {
        setStore("context", "items", (current) => [
          ...current.filter((item) => !isCommentItem(item)),
          ...items.map((item) => ({ ...item, key: contextItemKey(item) })),
        ])
      },
    },
    set: actions.set,
    reset: actions.reset,
  }
}

export function createPromptState() {
  const [store, setStore] = createStore<PromptStore>(promptStore())
  const ready = Object.assign(() => true, { promise: Promise.resolve(true) })
  return {
    ready: () => ready,
    ...createPromptStateValue(store, setStore),
  }
}

export function createDraftPromptState(draftID: string, platform: Platform) {
  const session = loadDraftPromptSession(draftID, platform)
  return {
    ready: () => session.ready,
    current: () => session.current(),
    cursor: () => session.cursor(),
    dirty: () => session.dirty(),
    context: {
      items: () => session.context.items(),
      add: (item: ContextItem) => session.context.add(item),
      remove: (key: string) => session.context.remove(key),
      removeComment: (path: string, commentID: string) => session.context.removeComment(path, commentID),
      updateComment: (path: string, commentID: string, next: Partial<FileContextItem> & { comment?: string }) =>
        session.context.updateComment(path, commentID, next),
      replaceComments: (items: FileContextItem[]) => session.context.replaceComments(items),
    },
    set: (prompt: Prompt, cursorPosition?: number) => session.set(prompt, cursorPosition),
    reset: () => session.reset(),
  }
}
