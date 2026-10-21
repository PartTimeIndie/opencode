export * as CircuitBreaker from "./circuit-breaker"

/**
 * Per-provider circuit breaker (E5). Counts consecutive typed provider
 * failures; an open circuit skips that provider so the model chain can
 * advance instead of dying on every turn.
 *
 * State is owned per `make()` instance — one instance per runner service —
 * so suites and embedded hosts never share breaker state implicitly.
 */
export type State = "closed" | "open" | "half-open"

export type Snapshot = {
  readonly key: string
  readonly state: State
  readonly failures: number
  readonly openedAt?: number
}

export const FAILURE_THRESHOLD = 3
export const OPEN_MS = 30_000

export function make() {
  const snapshots = new Map<string, { state: State; failures: number; openedAt?: number }>()
  const inspect = (key: string): Snapshot => {
    const current = snapshots.get(key) ?? { state: "closed" as const, failures: 0 }
    return { key, ...current }
  }
  const shouldSkip = (key: string, now = Date.now()): boolean => {
    const current = snapshots.get(key)
    if (!current || current.state === "closed") return false
    if (current.state === "open") {
      if (current.openedAt !== undefined && now - current.openedAt >= OPEN_MS) {
        snapshots.set(key, { state: "half-open", failures: current.failures, openedAt: current.openedAt })
        return false
      }
      return true
    }
    return false
  }
  const recordSuccess = (key: string): Snapshot => {
    snapshots.set(key, { state: "closed", failures: 0 })
    return inspect(key)
  }
  const recordFailure = (key: string, now = Date.now()): Snapshot => {
    const current = snapshots.get(key) ?? { state: "closed" as const, failures: 0 }
    if (current.state === "half-open") {
      snapshots.set(key, { state: "open", failures: current.failures + 1, openedAt: now })
      return inspect(key)
    }
    const failures = current.failures + 1
    if (failures >= FAILURE_THRESHOLD) {
      snapshots.set(key, { state: "open", failures, openedAt: now })
    } else {
      snapshots.set(key, { state: "closed", failures })
    }
    return inspect(key)
  }
  return { shouldSkip, recordSuccess, recordFailure, inspect }
}
