import type { ServerScope } from "@/utils/server-scope"
import { pathKey } from "@/utils/path-key"
import { Persist, persisted } from "@/utils/persist"
import { createSignal, type Accessor } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import type { FollowupItem } from "./followup-queue"

export type FollowupEdit = Pick<FollowupItem, "id" | "prompt" | "context">

export type FollowupState = {
  items: Record<string, FollowupItem[] | undefined>
  failed: Record<string, string | undefined>
  paused: Record<string, boolean | undefined>
  edit: Record<string, FollowupEdit | undefined>
}

type FollowupStore = [
  state: FollowupState,
  setFollowup: SetStoreFunction<FollowupState>,
  ready: () => boolean,
]

// Every open session tab of one project mounts its own Session component, and
// each mount used to hydrate its own copy of the persisted followup file. The
// persisted store writes the whole value on every change, so a stale copy from
// one mount could overwrite items queued through another mount (lost followups
// without any send). One store instance per scope+directory keeps all mounts
// writing through the same state.
const cache = new Map<string, FollowupStore>()

// The cache is a plain Map, so consumers scanning every store (the global
// followup drain) need an explicit reactive hint whenever a session tab caches
// another directory's store.
const [cacheVersion, setCacheVersion] = createSignal(0)
export const followupCacheVersion: Accessor<number> = cacheVersion

export function followupStore(input: { scope: ServerScope; directory: string }): FollowupStore {
  const key = `${String(input.scope)}\0${pathKey(input.directory)}`
  const existing = cache.get(key)
  if (existing) return existing
  const created = createFollowupStore(input)
  cache.set(key, created)
  setCacheVersion((value) => value + 1)
  return created
}

export function clearFollowupStoreCache() {
  cache.clear()
  setCacheVersion((value) => value + 1)
}

// Followup sends are claimed per scope+directory+session+item before the queued
// item is removed, so the per-tab composer and the global drain can never send
// the same parked item twice.
export const sendingFollowups = new Set<string>()

const [claimVersion, setClaimVersion] = createSignal(0)
export const followupClaimVersion: Accessor<number> = claimVersion

// Claim and release bump a reactive version so the global drain re-scans when a
// manual send finishes instead of stalling on the just-claimed item.
export function claimFollowupSend(key: string) {
  if (sendingFollowups.has(key)) return false
  sendingFollowups.add(key)
  setClaimVersion((value) => value + 1)
  return true
}

export function releaseFollowupSend(key: string) {
  const existed = sendingFollowups.delete(key)
  if (existed) setClaimVersion((value) => value + 1)
  return existed
}

export type FollowupStoreEntry = {
  directory: string
  store: FollowupStore
}

// Cached stores outlive their mounting session tab, so a queue parked on a
// background session stays visible here even when no Session component of that
// directory is rendered.
export function followupStoreEntries(scope: ServerScope): FollowupStoreEntry[] {
  const prefix = `${String(scope)}\0`
  const entries: FollowupStoreEntry[] = []
  for (const [key, store] of cache) {
    if (!key.startsWith(prefix)) continue
    entries.push({ directory: key.slice(prefix.length), store })
  }
  return entries
}

function createFollowupStore(input: { scope: ServerScope; directory: string }): FollowupStore {
  const [state, setState, init, ready] = persisted(
    Persist.serverWorkspace(input.scope, input.directory, "followup", ["followup.v1"]),
    createStore<FollowupState>({ items: {}, failed: {}, paused: {}, edit: {} }),
  )

  // A write that lands before the persisted file has been read would serialize
  // the empty default store over the real queue (the async hydration is then
  // skipped entirely). Buffer early writes and replay them in order once
  // hydration resolved, so a reload can never wipe queued items.
  let settled = !(init instanceof Promise)
  type Write = (...args: unknown[]) => void
  const write = setState as Write
  const pending: Parameters<Write>[] = []
  const flush = () => {
    if (settled) return
    settled = true
    for (const args of pending.splice(0)) write(...args)
  }
  if (init instanceof Promise) void init.then(flush, flush)

  const setFollowup = ((...args: Parameters<Write>) => {
    if (settled) return write(...args)
    pending.push(args)
  }) as SetStoreFunction<FollowupState>

  return [state, setFollowup, ready]
}
