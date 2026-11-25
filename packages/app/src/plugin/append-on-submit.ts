import type { AppToolbarContext, AppToolbarItem } from "@opencode-ai/plugin/app"
import type { FinalAppendHandler } from "./composer-registry"

export type AppendOnSubmitTarget = {
  serverID: string
  directory: string
  sessionID?: string
  composerID: string
}

export type AppendOnSubmitItem = Pick<AppToolbarItem, "command" | "skill" | "appendOnSubmit" | "run" | "mount">

export function appendOnSubmitTarget(item: AppendOnSubmitItem): { token: string } | { error: string } {
  const command = item.command?.name.trim()
  const skill = item.skill?.name.trim()
  if (item.run || item.mount)
    return { error: "Custom run/mount handlers override the appendOnSubmit standard action entirely." }
  if (item.command && item.skill)
    return { error: "Toolbar item must not set both `command` and `skill` for appendOnSubmit." }
  const name = command || skill
  if (!name) return { error: "appendOnSubmit requires exactly one `command` or `skill` target." }
  if (!/^[^\s/]+$/.test(name))
    return { error: "Toolbar reference names must be a single name without slashes or whitespace." }
  return { token: `/${name}` }
}

/** Deduplication uses whitespace-delimited references, not Markdown interpretation. */
export function referencePresent(text: string, token: string) {
  return new RegExp(`(?:^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`).test(text)
}

export function appendOnSubmitKey(target: AppendOnSubmitTarget) {
  return JSON.stringify([target.serverID, target.directory, target.sessionID, target.composerID])
}

export function createAppendOnSubmitStore() {
  const pending = new Map<string, Map<string, { token: string }>>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  const store = {
    armed(itemID: string, target: AppendOnSubmitTarget) {
      return pending.get(appendOnSubmitKey(target))?.has(itemID) ?? false
    },
    toggle(itemID: string, target: AppendOnSubmitTarget, token: string) {
      const key = appendOnSubmitKey(target)
      const group = pending.get(key) ?? new Map<string, { token: string }>()
      if (group.has(itemID)) group.delete(itemID)
      else group.set(itemID, { token })
      if (group.size) pending.set(key, group)
      else pending.delete(key)
      notify()
      return group.has(itemID)
    },
    tokens(target: AppendOnSubmitTarget) {
      return [...(pending.get(appendOnSubmitKey(target)) ?? [])].map(([itemID, value]) => ({
        itemID,
        token: value.token,
      }))
    },
    stage(target: AppendOnSubmitTarget) {
      const key = appendOnSubmitKey(target)
      const captured = [...(pending.get(key) ?? [])]
      return {
        tokens: captured.map(([, value]) => value.token),
        commit() {
          const current = pending.get(key)
          if (!current) return
          for (const [id, value] of captured) {
            if (current.get(id) === value) current.delete(id)
          }
          if (!current.size) pending.delete(key)
          notify()
        },
      }
    },
    remove(itemID: string) {
      for (const [key, group] of pending) {
        group.delete(itemID)
        if (!group.size) pending.delete(key)
      }
      notify()
    },
    prune(eligible: (itemID: string, target: AppendOnSubmitTarget) => boolean) {
      let changed = false
      for (const [key, group] of pending) {
        const [serverID, directory, sessionID, composerID] = JSON.parse(key) as string[]
        for (const id of group.keys()) {
          if (
            eligible(id, { serverID: serverID!, directory: directory!, sessionID: sessionID!, composerID: composerID! })
          )
            continue
          group.delete(id)
          changed = true
        }
        if (!group.size) pending.delete(key)
      }
      if (changed) notify()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return store
}

export type AppendOnSubmitStore = ReturnType<typeof createAppendOnSubmitStore>

/** This final phase stages a receipt; only durable admission (or explicit local Queue) commits it. */
export function createToolbarFinalAppend(store: AppendOnSubmitStore): FinalAppendHandler {
  return (input) => {
    if (input.mode !== "normal" || !input.getText().trim()) return
    const staged = store.stage(input)
    if (!staged.tokens.length) return
    for (const token of staged.tokens) {
      if (!referencePresent(input.getText(), token)) input.appendText(token)
    }
    return { commit: staged.commit }
  }
}

export function resolveAppendOnSubmitTarget(
  serverID: string,
  context: Pick<AppToolbarContext, "directory" | "sessionID" | "composerID">,
): { target: AppendOnSubmitTarget } | { error: string } {
  if (!context.directory || !context.composerID)
    return { error: "Toolbar item needs an exact composer target with directory and composer." }
  return {
    target: { serverID, directory: context.directory, sessionID: context.sessionID, composerID: context.composerID },
  }
}
