import type { Session } from "@opencode-ai/sdk/v2/client"
import type { RootLoadArgs } from "./types"
import { isCancellationError } from "@/utils/server-errors"

export type SharedSessionLoad = {
  promise: Promise<void>
  controller: AbortController
  consumers: Set<symbol>
}

export function waitForSharedSessionLoad(load: SharedSessionLoad, signal?: AbortSignal) {
  const consumer = Symbol()
  load.consumers.add(consumer)
  const release = () => {
    load.consumers.delete(consumer)
    if (load.consumers.size === 0) load.controller.abort()
  }
  if (!signal) return load.promise.finally(release)
  if (signal.aborted) {
    release()
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
  }
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      release()
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
    }
    signal.addEventListener("abort", abort, { once: true })
    void load.promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort)
      release()
    })
  })
}

export async function loadRootSessionsWithFallback(input: RootLoadArgs) {
  try {
    const result = await input.list({ directory: input.directory, roots: true, limit: input.limit })
    return {
      data: result.data,
      limit: input.limit,
      limited: true,
    } as const
  } catch (error) {
    if (input.signal?.aborted || isCancellationError(error)) throw error
    const result = await input.list({ directory: input.directory, roots: true })
    return {
      data: result.data,
      limit: input.limit,
      limited: false,
    } as const
  }
}

export function estimateRootSessionTotal(input: { count: number; limit: number; limited: boolean }) {
  if (!input.limited) return input.count
  if (input.count < input.limit) return input.count
  return input.count + 1
}

export function mergeLoadedSessions(input: {
  loaded: Session[]
  current: Session[]
  initialIDs: ReadonlySet<string>
  preserveIDs?: ReadonlySet<string>
}) {
  const loadedIDs = new Set(input.loaded.map((session) => session.id))
  const current = new Map(input.current.map((session) => [session.id, session]))
  return [
    ...input.loaded.map((session) => {
      const cached = current.get(session.id)
      return cached && cached.time.updated > session.time.updated ? cached : session
    }),
    ...input.current.filter(
      (session) =>
        !loadedIDs.has(session.id) &&
        (!!session.parentID || input.preserveIDs?.has(session.id) || !input.initialIDs.has(session.id)),
    ),
  ]
}
