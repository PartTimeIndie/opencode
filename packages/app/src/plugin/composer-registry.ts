import type {
  AppHostComposerTarget,
  AppHostComposerSnapshot,
  AppHostComposerBeforeSubmitHandler,
  AppHostComposerInsertResult,
} from "@opencode-ai/plugin/app"
import { abortPluginWork } from "./abort"

type HostTarget = AppHostComposerTarget & { serverID: string }
type Insert = HostTarget & { text: string; position?: "cursor" | "end"; replace?: string }
type Editor = {
  read(): AppHostComposerSnapshot
  change(text: string): void
  appendText?(text: string): void
  insertText(input: Insert): AppHostComposerInsertResult
  submitText(text: string): Promise<AppHostComposerInsertResult>
}

export function createComposerRegistry() {
  const editors = new Map<string, { target: HostTarget; editor: Editor; controller: AbortController }>()
  const listeners = new Map<string, Set<{ handler: AppHostComposerBeforeSubmitHandler; controller: AbortController }>>()
  const pending = new Set<string>()

  const find = (target: HostTarget) => {
    const entry = editors.get(key(target))
    if (!entry || entry.controller.signal.aborted) return
    const snapshot = { ...entry.editor.read() }
    if (!matches(target, snapshot)) return
    return { ...entry, snapshot }
  }

  return {
    register(target: HostTarget, editor: Editor) {
      const id = key(target)
      if (editors.has(id)) throw new Error("Composer is already registered")
      const entry = { target: { ...target }, editor, controller: new AbortController() }
      editors.set(id, entry)
      return () => {
        if (editors.get(id) !== entry) return
        editors.delete(id)
        abortPluginWork(entry.controller)
      }
    },
    read(target: HostTarget) {
      const snapshot = find(target)?.snapshot
      return snapshot && Object.freeze({ ...snapshot })
    },
    change(input: HostTarget & { text: string; expectedText?: string }): AppHostComposerInsertResult {
      const entry = find(input)
      if (!entry) return { ok: false, error: "Composer is no longer available" }
      if (input.expectedText !== undefined && entry.snapshot.text !== input.expectedText)
        return { ok: false, error: "Composer changed during editing" }
      entry.editor.change(input.text)
      return { ok: true }
    },
    insertText(input: Insert) {
      return find(input)?.editor.insertText(input)
    },
    async submitText(input: HostTarget & { text: string }): Promise<AppHostComposerInsertResult> {
      const entry = find(input)
      if (!entry) return { ok: false, error: "Composer is no longer available" }
      return entry.editor.submitText(input.text)
    },
    beforeSubmit(target: HostTarget, handler: AppHostComposerBeforeSubmitHandler, signal?: AbortSignal) {
      if (signal?.aborted) return () => {}
      const id = key(target)
      const group = listeners.get(id) ?? new Set()
      const entry = { handler, controller: new AbortController() }
      listeners.set(id, group)
      group.add(entry)
      const dispose = () => {
        group.delete(entry)
        if (group.size === 0 && listeners.get(id) === group) listeners.delete(id)
        signal?.removeEventListener("abort", dispose)
        abortPluginWork(entry.controller)
      }
      signal?.addEventListener("abort", dispose, { once: true })
      return dispose
    },
    async runBeforeSubmit(
      target: HostTarget,
      agent: {
        getAgent(): string | undefined
        canSetAgent(name: string): boolean
        setAgent(name: string): boolean
      },
    ): Promise<AppHostComposerInsertResult> {
      const id = key(target)
      if (pending.has(id)) return { ok: false, error: "Composer submission is already in progress" }
      const entry = find(target)
      if (!entry) return { ok: false, error: "Composer is no longer available" }
      pending.add(id)
      const draft = {
        text: entry.snapshot.text,
        appended: [] as string[] | undefined,
        blocked: false,
        reason: undefined as string | undefined,
        agent: undefined as string | undefined,
      }
      try {
        for (const listener of [...(listeners.get(id) ?? [])]) {
          if (listener.controller.signal.aborted) continue
          const signal = AbortSignal.any([entry.controller.signal, listener.controller.signal])
          let active = true
          const check = () => {
            signal.throwIfAborted()
            if (!active) throw new Error("Composer callback has already completed")
          }
          await abortable(signal, () =>
            Promise.resolve(
              listener.handler({
                directory: target.directory,
                sessionID: target.sessionID,
                composerID: target.composerID,
                mode: entry.snapshot.mode,
                signal,
                getText: () => draft.text,
                setText(value) {
                  check()
                  draft.text = value
                  draft.appended = undefined
                },
                appendText(value) {
                  check()
                  const text = value.trim()
                  if (!text) return
                  draft.text = `${draft.text}${draft.text.trim() ? "\n\n" : ""}${text}`
                  draft.appended?.push(text)
                },
                preventSubmit(reason) {
                  check()
                  draft.blocked = true
                  draft.reason = reason
                },
                getAgent: () => draft.agent ?? agent.getAgent(),
                setAgent(name) {
                  check()
                  if (!agent.canSetAgent(name)) return false
                  draft.agent = name
                  return true
                },
              }),
            ),
          ).finally(() => {
            active = false
          })
          if (draft.blocked) return { ok: false, error: draft.reason }
        }
        const current = find(target)
        if (
          !current ||
          current.controller !== entry.controller ||
          current.snapshot.text !== entry.snapshot.text ||
          current.snapshot.mode !== entry.snapshot.mode
        )
          return { ok: false, error: "Composer changed before submission" }
        if (draft.agent && !agent.setAgent(draft.agent))
          return { ok: false, error: `Agent '${draft.agent}' is unavailable` }
        if (draft.text !== entry.snapshot.text) {
          if (draft.appended && entry.editor.appendText)
            draft.appended.forEach((text) => entry.editor.appendText!(text))
          else entry.editor.change(draft.text)
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Composer callback failed" }
      } finally {
        pending.delete(id)
      }
    },
  }
}

function key(target: HostTarget) {
  return JSON.stringify([target.serverID, target.directory, target.sessionID, target.composerID])
}

function matches(target: AppHostComposerTarget, snapshot: AppHostComposerSnapshot) {
  return (
    target.directory === snapshot.directory &&
    target.sessionID === snapshot.sessionID &&
    target.composerID === snapshot.composerID
  )
}

async function abortable<T>(signal: AbortSignal, run: () => Promise<T>) {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const abort = () => cancelled.reject(signal.reason)
  signal.addEventListener("abort", abort, { once: true })
  return Promise.race([cancelled.promise, Promise.resolve().then(run)]).finally(() =>
    signal.removeEventListener("abort", abort),
  )
}

export const composerRegistry = createComposerRegistry()
