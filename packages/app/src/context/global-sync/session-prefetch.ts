import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import { createSignal } from "solid-js"

const key = (scope: ServerScope, directory: string, sessionID: string) => ScopedKey.from(scope, directory, sessionID)

export const SESSION_PREFETCH_TTL = 15_000
export const SESSION_PREFETCH_FAILURE_COOLDOWN = 5 * 60_000

type Meta = {
  limit: number
  cursor?: string
  complete: boolean
  at: number
}

export function shouldSkipSessionPrefetch(input: { message: boolean; info?: Meta; chunk: number; now?: number }) {
  if (input.message) {
    if (!input.info) return true
    if (input.info.complete) return true
    if (input.info.limit >= input.chunk) return true
  } else {
    if (!input.info) return false
  }

  return (input.now ?? Date.now()) - input.info.at < SESSION_PREFETCH_TTL
}

export function canUseSessionPrefetch(input: { messageCount: number; info?: Meta; minLimit?: number }) {
  if (!input.info) return false
  if (input.messageCount < input.info.limit) return false
  if (input.info.complete) return true
  return input.info.limit >= (input.minLimit ?? 1)
}

export function activeSessionReadyForBackgroundPrefetch(input: { message: boolean; info?: Meta }) {
  // Foreground sync creates an empty message array before the request starts so
  // the shell can render. Only metadata written after a completed page read
  // proves that background history work may safely use the connection.
  return input.message && !!input.info
}

const cache = new Map<string, Meta>()
const [metadataRevision, setMetadataRevision] = createSignal(0)
type Inflight = {
  controller: AbortController
  promise: Promise<Meta | undefined>
}

const inflight = new Map<string, Inflight>()
const rev = new Map<string, number>()
const failed = new Map<string, number>()

const version = (id: string) => rev.get(id) ?? 0

export function getSessionPrefetch(scope: ServerScope, directory: string, sessionID: string) {
  return cache.get(key(scope, directory, sessionID))
}

export function sessionPrefetchRevision() {
  return metadataRevision()
}

export function getSessionPrefetchPromise(scope: ServerScope, directory: string, sessionID: string) {
  return inflight.get(key(scope, directory, sessionID))?.promise
}

export function sessionPrefetchCoolingDown(
  scope: ServerScope,
  directory: string,
  sessionID: string,
  now = Date.now(),
) {
  const id = key(scope, directory, sessionID)
  const at = failed.get(id)
  if (at === undefined) return false
  if (now - at < SESSION_PREFETCH_FAILURE_COOLDOWN) return true
  failed.delete(id)
  return false
}

export function markSessionPrefetchFailed(scope: ServerScope, directory: string, sessionID: string, at = Date.now()) {
  failed.set(key(scope, directory, sessionID), at)
}

export function clearSessionPrefetchInflight(scope: ServerScope) {
  const prefix = ScopedKey.prefix(scope)
  for (const [id, pending] of inflight) {
    if (!id.startsWith(prefix)) continue
    pending.controller.abort()
    inflight.delete(id)
  }
}

export function cancelSessionPrefetch(scope: ServerScope, directory: string, sessionID: string) {
  const id = key(scope, directory, sessionID)
  const pending = inflight.get(id)
  if (!pending) return
  rev.set(id, version(id) + 1)
  pending.controller.abort()
  inflight.delete(id)
}

export function isSessionPrefetchCurrent(scope: ServerScope, directory: string, sessionID: string, value: number) {
  return version(key(scope, directory, sessionID)) === value
}

export function runSessionPrefetch(input: {
  directory: string
  scope: ServerScope
  sessionID: string
  task: (value: number, signal: AbortSignal) => Promise<Meta | undefined>
}) {
  const id = key(input.scope, input.directory, input.sessionID)
  const pending = inflight.get(id)
  if (pending) return pending.promise

  const value = version(id)
  const controller = new AbortController()

  const promise = input.task(value, controller.signal).finally(() => {
    if (inflight.get(id)?.promise === promise) inflight.delete(id)
  })

  inflight.set(id, { controller, promise })
  return promise
}

export function setSessionPrefetch(input: {
  directory: string
  scope: ServerScope
  sessionID: string
  limit: number
  cursor?: string
  complete: boolean
  at?: number
}) {
  const id = key(input.scope, input.directory, input.sessionID)
  failed.delete(id)
  cache.set(id, {
    limit: input.limit,
    cursor: input.cursor,
    complete: input.complete,
    at: input.at ?? Date.now(),
  })
  setMetadataRevision((value) => value + 1)
}

export function clearSessionPrefetch(scope: ServerScope, directory: string, sessionIDs: Iterable<string>) {
  let changed = false
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    const id = key(scope, directory, sessionID)
    rev.set(id, version(id) + 1)
    changed = cache.delete(id) || changed
    failed.delete(id)
    const pending = inflight.get(id)
    pending?.controller.abort()
    inflight.delete(id)
  }
  if (changed) setMetadataRevision((value) => value + 1)
}

export function clearSessionPrefetchDirectory(scope: ServerScope, directory: string) {
  const prefix = ScopedKey.prefix(scope, directory)
  const keys = new Set([...cache.keys(), ...inflight.keys(), ...failed.keys()])
  for (const id of keys) {
    if (!id.startsWith(prefix)) continue
    rev.set(id, version(id) + 1)
    cache.delete(id)
    failed.delete(id)
    const pending = inflight.get(id)
    pending?.controller.abort()
    inflight.delete(id)
  }
}
