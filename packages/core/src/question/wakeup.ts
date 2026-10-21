export * as QuestionWakeup from "./wakeup"

import { Effect } from "effect"

interface Entry {
  readonly generation: number
  observers: number
  readonly waiters: Set<() => void>
}

let nextGeneration = 0
const entries = new Map<string, Entry>()

function acquire(requestID: string) {
  const existing = entries.get(requestID)
  if (existing) {
    existing.observers++
    return existing.generation
  }
  const entry = { generation: ++nextGeneration, observers: 1, waiters: new Set<() => void>() }
  entries.set(requestID, entry)
  return entry.generation
}

function release(requestID: string, observed: number) {
  const entry = entries.get(requestID)
  if (!entry || entry.generation !== observed) return
  entry.observers--
  if (entry.observers === 0 && entry.waiters.size === 0) entries.delete(requestID)
}

function awaitWake(requestID: string, observed: number) {
  return Effect.callback<void>((resume) => {
    const entry = entries.get(requestID)
    if (!entry || entry.generation !== observed) {
      resume(Effect.void)
      return
    }

    const waiter = () => resume(Effect.void)
    entry.waiters.add(waiter)
    return Effect.sync(() => {
      entry.waiters.delete(waiter)
    })
  })
}

export function wait<A, E, R>(
  requestID: string,
  use: (wakeup: Effect.Effect<void>) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => acquire(requestID)),
    (observed) => use(awaitWake(requestID, observed)),
    (observed) => Effect.sync(() => release(requestID, observed)),
  )
}

/** @internal Test-only visibility for leak regression coverage. */
export function hasEntry(requestID: string) {
  return entries.has(requestID)
}

export function wake(requestID: string) {
  const entry = entries.get(requestID)
  if (!entry) return
  entries.delete(requestID)
  for (const waiter of entry.waiters) waiter()
  entry.waiters.clear()
}
