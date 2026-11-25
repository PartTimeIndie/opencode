import type { AppHostComposerSendPreparation, AppHostComposerTarget } from "@opencode-ai/plugin/app"
import type { Prompt } from "../context/prompt"
import { insertPromptDraft } from "../context/prompt-insert"
import { Identifier } from "../utils/id"

export type ComposerSendTarget = AppHostComposerTarget & { serverID: string }
export type ComposerSendResult = {
  status: "blocked" | "cancelled" | "admitted" | "unknown"
  error?: string
  /** Text a blocked preparation asked the host to keep as an unsent draft. */
  insertDraft?: string
}
export type PreparedComposerSubmission = {
  prompt: Prompt
  cursor: number
  agent: string
  canSetAgent(name: string): boolean
  execute(input: { prompt: Prompt; agent: string; messageID: string; signal: AbortSignal; dispatched(): void }): Promise<ComposerSendResult>
  /** Inserts into the live composer draft; the broker calls it before `settle`. */
  insertDraft?(text: string): { ok: boolean; error?: string }
  settle(result: ComposerSendResult, approved: Prompt, prepared: Prompt): void
  dispose(): void
}
export type ComposerSendHooks = (input: {
  signal: AbortSignal
  getText(): string
  setText(text: string): void
  appendText(text: string): void
  getAgent(): string
  setAgent(name: string): boolean
}) => Promise<{ ok: boolean; error?: string; commit?: () => void }>

type Registration = { target: ComposerSendTarget; preparation: AppHostComposerSendPreparation; signal: AbortSignal; consumed: boolean; dispose(): void }
type Intent = { target: ComposerSendTarget; controller: AbortController; result: Promise<ComposerSendResult>; dispatched: boolean }

/** Volatile approval only. Editor disposal is deliberately not this owner's lifetime. */
export function createComposerSendIntents() {
  const registrations = new Map<string, Registration>()
  const pending = new Map<string, Intent>()
  const listeners = new Set<() => void>()
  const receipts = new Map<string, { target: string; operationID: string; before: string; after: string; text: string; cursor: number; replacementCursor?: number }>()
  const ambiguousCommands = new Map<string, string>()
  const notify = () => listeners.forEach((listener) => listener())
  const key = (target: ComposerSendTarget) => JSON.stringify([target.serverID, target.directory, target.sessionID, target.composerID])
  const active = (target: ComposerSendTarget) => {
    const entry = registrations.get(key(target))
    return entry && !entry.consumed && !entry.signal.aborted && entry.preparation.isActive() ? entry : undefined
  }
  const cancel = (matches: (target: ComposerSendTarget) => boolean) => {
    for (const intent of pending.values()) if (matches(intent.target)) intent.controller.abort(new Error("Composer send cancelled"))
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    available(target: ComposerSendTarget) { return !!active(target) || pending.has(key(target)) },
    busy(target: ComposerSendTarget) { return pending.has(key(target)) },
    ambiguousCommand(target: ComposerSendTarget, prompt: Prompt) {
      const id = key(target)
      const previous = ambiguousCommands.get(id)
      if (!previous) return false
      const current = prompt.map((part) => "content" in part ? part.content : "").join("")
      if (current === previous) return true
      ambiguousCommands.delete(id)
      return false
    },
    cancel,
    revoke(matches: (target: ComposerSendTarget) => boolean) {
      cancel(matches)
      for (const entry of [...registrations.values()]) if (matches(entry.target)) {
        entry.dispose()
      }
    },
    register(target: ComposerSendTarget, preparation: AppHostComposerSendPreparation, signal: AbortSignal) {
      if (signal.aborted) return () => {}
      const id = key(target)
      if (registrations.has(id) || !preparation.operationID) throw new Error("Composer preparation is already registered or has no operation identity")
      const entry = { target: { ...target }, preparation, signal, consumed: false, dispose: () => {} }
      registrations.set(id, entry)
      const unsubscribe = preparation.subscribe(notify)
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        if (registrations.get(id) === entry) registrations.delete(id)
        unsubscribe()
        signal.removeEventListener("abort", dispose)
        for (const [receiptID, receipt] of receipts) if (receipt.target === id && receipt.operationID === preparation.operationID && !pending.has(id)) receipts.delete(receiptID)
        notify()
      }
      entry.dispose = dispose
      signal.addEventListener("abort", dispose, { once: true })
      notify()
      return dispose
    },
    recordInsertion(target: ComposerSendTarget, operationID: string, before: Prompt, after: Prompt, text: string, cursor: number, replacement?: { replace: string; cursor: number }) {
      const entry = registrations.get(key(target))
      if (!entry || entry.signal.aborted || entry.preparation.operationID !== operationID) return
      const id = crypto.randomUUID()
      receipts.set(id, { target: key(target), operationID, before: JSON.stringify(before), after: JSON.stringify(after), text, cursor, replacementCursor: replacement?.cursor })
      return id
    },
    submit(target: ComposerSendTarget, capture: () => PreparedComposerSubmission, hooks?: ComposerSendHooks): Promise<ComposerSendResult> | undefined {
      const id = key(target)
      const existing = pending.get(id)
      if (existing) return existing.result
      const entry = active(target)
      if (!entry) return
      const controller = new AbortController()
      const done = Promise.withResolvers<ComposerSendResult>()
      const intent = { target: { ...target }, controller, result: done.promise, dispatched: false }
      pending.set(id, intent)
      entry.consumed = true
      notify()
      const signal = AbortSignal.any([controller.signal, entry.signal])
      let snapshot: PreparedComposerSubmission
      let approved: Prompt
      let draft: { prompt: Prompt; cursor: number; agent: string }
      let intentID: string
      try {
        intentID = crypto.randomUUID()
        snapshot = capture()
        approved = structuredClone(snapshot.prompt)
        draft = { prompt: structuredClone(snapshot.prompt), cursor: snapshot.cursor, agent: snapshot.agent }
      } catch (error) {
        entry.consumed = false
        pending.delete(id)
        notify()
        done.resolve({ status: "blocked", error: message(error) })
        return done.promise
      }
      const state = { current: () => draft.prompt, cursor: () => draft.cursor, set: (prompt: Prompt, cursor: number) => { draft.prompt = prompt; draft.cursor = cursor } }
      const insert = (text: string, position?: "end") => {
        const result = insertPromptDraft(state, { text, position })
        if (!result.ok) throw new Error(result.error)
      }
      const run = async (): Promise<ComposerSendResult> => {
        signal.throwIfAborted()
        const prepared = await awaitComposerSend(signal, () => entry.preparation.prepare({ intentID, signal }))
        signal.throwIfAborted()
        if (!prepared.ok)
          return typeof prepared.insertDraft === "string" && prepared.insertDraft
            ? { status: "blocked", error: prepared.error, insertDraft: prepared.insertDraft }
            : { status: "blocked", error: prepared.error }
        if ("insertionReceiptID" in prepared) {
          const receipt = receipts.get(prepared.insertionReceiptID)
          if (!receipt || receipt.target !== id || receipt.operationID !== entry.preparation.operationID) throw new Error("Invalid composer insertion receipt")
          const current = JSON.stringify(approved)
          if (current !== receipt.after) {
            if (current !== receipt.before) throw new Error("Draft changed during transcript insertion")
            if (receipt.replacementCursor !== undefined) {
              draft.prompt = JSON.parse(receipt.after) as Prompt
              draft.cursor = receipt.replacementCursor
            } else {
              draft.cursor = receipt.cursor
              insert(receipt.text)
            }
          }
          receipts.delete(prepared.insertionReceiptID)
        } else insert(prepared.text)
        const preparedHooks = await hooks?.({
          signal,
          getText: () => draft.prompt.map((part) => "content" in part ? part.content : "").join(""),
          setText(text) {
            signal.throwIfAborted()
            draft.prompt = [{ type: "text", content: text, start: 0, end: text.length }, ...draft.prompt.filter((part) => part.type === "image")]
          },
          appendText(text) {
            signal.throwIfAborted()
            const start = draft.prompt.reduce((length, part) => length + ("content" in part ? part.content.length : 0), 0)
            const content = `${start ? "\n\n" : ""}${text.trim()}`
            draft.prompt.push({ type: "text", content, start, end: start + content.length })
          },
          getAgent: () => draft.agent,
          setAgent(name) { signal.throwIfAborted(); if (!snapshot.canSetAgent(name)) return false; draft.agent = name; return true },
        })
        if (preparedHooks && !preparedHooks.ok) return { status: "blocked", error: preparedHooks.error }
        signal.throwIfAborted()
        const result = await snapshot.execute({ prompt: draft.prompt, agent: draft.agent, messageID: Identifier.ascending("message"), signal, dispatched() { signal.throwIfAborted(); intent.dispatched = true } })
        // A local hook failure cannot turn confirmed admission into an unknown send.
        if (result.status === "admitted") {
          try { preparedHooks?.commit?.() } catch (error) { console.warn("Composer post-admission hook failed", error) }
        }
        return result
      }
      void run().catch((error): ComposerSendResult => ({ status: intent.dispatched ? "unknown" : signal.aborted ? "cancelled" : "blocked", error: message(error) })).then((result) => {
        if (result.status === "unknown") {
          const text = draft.prompt.map((part) => "content" in part ? part.content : "").join("")
          if (/^\/[^\s]+(?:\s|$)/.test(text)) ambiguousCommands.set(id, text)
        }
        // A blocked preparation may keep text as an unsent draft. This runs
        // after `prepare` settled and before the host restores the approved
        // prompt for presentation, so the kept draft is never rolled back.
        if (result.status === "blocked" && result.insertDraft !== undefined) {
          const insertDraft = result.insertDraft
          try {
            const inserted = snapshot.insertDraft?.(insertDraft)
            if (inserted && !inserted.ok)
              result = { status: "blocked", error: `${result.error ?? "The send was blocked"} The draft could not be inserted: ${inserted.error ?? "unknown error"}` }
          } catch (error) {
            result = { status: "blocked", error: `${result.error ?? "The send was blocked"} The draft could not be inserted: ${message(error)}` }
          }
        }
        try { snapshot.settle(result, approved, draft.prompt) } catch (error) {
          console.warn("Composer result presentation failed", error)
        } finally {
          try { snapshot.dispose() } catch (error) { console.warn("Composer cleanup failed", error) }
          pending.delete(id)
          for (const [receiptID, receipt] of receipts) if (receipt.target === id && receipt.operationID === entry.preparation.operationID) receipts.delete(receiptID)
          notify()
          done.resolve(result)
        }
      })
      return done.promise
    },
  }
}

export async function awaitComposerSend<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const abort = () => cancelled.reject(signal.reason)
  signal.addEventListener("abort", abort, { once: true })
  try { return await Promise.race([cancelled.promise, run()]) } finally { signal.removeEventListener("abort", abort) }
}

function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
export const composerSendIntents = createComposerSendIntents()
