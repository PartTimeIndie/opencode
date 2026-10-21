import { createSimpleContext } from "@opencode-ai/ui/context"
import { useSearchParams } from "@solidjs/router"
import { createMemo, onCleanup } from "solid-js"
import type { FileSelection } from "@/context/file"
import { usePlatform, type Platform } from "@/context/platform"
import { useServerSDK } from "./server-sdk"
import { useSessionRoute } from "@/context/session-route"
import {
  acquirePromptSession,
  loadDraftPromptSession,
  MAX_PROMPT_SESSIONS,
  scopeKey,
  type PromptCacheEntry,
  type Scope,
} from "./prompt-session"

export {
  acquirePromptSession,
  clearDraftPromptState,
  createDraftPromptState,
  createPromptState,
  DEFAULT_PROMPT,
  isPromptEqual,
} from "./prompt-session"
export type { Scope } from "./prompt-session"

interface PartBase {
  content: string
  start: number
  end: number
}

export interface TextPart extends PartBase {
  type: "text"
}

export interface FileAttachmentPart extends PartBase {
  type: "file"
  path: string
  selection?: FileSelection
}

export interface AgentPart extends PartBase {
  type: "agent"
  name: string
}

export interface PromptAttachmentPart {
  type: "image"
  id: string
  filename: string
  sourcePath?: string
  mime: string
  dataUrl?: string
}

/** @deprecated Use PromptAttachmentPart. The discriminator remains stable for persisted drafts. */
export type ImageAttachmentPart = PromptAttachmentPart

export type ContentPart = TextPart | FileAttachmentPart | AgentPart | PromptAttachmentPart
export type Prompt = ContentPart[]

export type FileContextItem = {
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export type ContextItem = FileContextItem

export const { use: usePrompt, provider: PromptProvider } = createSimpleContext({
  name: "Prompt",
  gate: false,
  init: () => {
    const params = useSessionRoute()
    const [search] = useSearchParams<{ draftId?: string }>()
    const serverSDK = useServerSDK()
    const platform = usePlatform()
    const cache = new Map<string, PromptCacheEntry>()

    const disposeAll = () => {
      for (const entry of cache.values()) {
        entry.dispose()
      }
      cache.clear()
    }

    onCleanup(disposeAll)

    const prune = () => {
      while (cache.size > MAX_PROMPT_SESSIONS) {
        const first = cache.keys().next().value
        if (!first) return
        const entry = cache.get(first)
        entry?.dispose()
        cache.delete(first)
      }
    }

    const load = (scope: Scope) => {
      if ("draftID" in scope) return loadDraftPromptSession(scope.draftID, platform)

      const key = JSON.stringify([serverSDK().scope, scopeKey(scope)])
      const existing = cache.get(key)
      if (existing) {
        cache.delete(key)
        cache.set(key, existing)
        return existing.value
      }

      const entry = acquirePromptSession(serverSDK().scope, scope, platform)

      cache.set(key, entry)
      prune()
      return entry.value
    }

    const session = createMemo(() =>
      load(search.draftId ? { draftID: search.draftId } : { dir: params.dir!, id: params.id }),
    )
    const pick = (scope?: Scope) => (scope ? load(scope) : session())

    return {
      ready: () => session().ready,
      current: () => session().current(),
      cursor: () => session().cursor(),
      dirty: () => session().dirty(),
      context: {
        items: (scope?: Scope) => pick(scope).context.items(),
        add: (item: ContextItem, scope?: Scope) => pick(scope).context.add(item),
        remove: (key: string, scope?: Scope) => pick(scope).context.remove(key),
        removeComment: (path: string, commentID: string, scope?: Scope) =>
          pick(scope).context.removeComment(path, commentID),
        updateComment: (
          path: string,
          commentID: string,
          next: Partial<FileContextItem> & { comment?: string },
          scope?: Scope,
        ) => pick(scope).context.updateComment(path, commentID, next),
        replaceComments: (items: FileContextItem[], scope?: Scope) => pick(scope).context.replaceComments(items),
      },
      set: (prompt: Prompt, cursorPosition?: number, scope?: Scope) => pick(scope).set(prompt, cursorPosition),
      reset: (scope?: Scope) => pick(scope).reset(),
    }
  },
})
