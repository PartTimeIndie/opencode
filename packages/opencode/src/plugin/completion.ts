import path from "node:path"
import type { CompletionInput, CompletionPolicy } from "@opencode-ai/plugin/completion"

export function createCompletionRegistry(timeout = 5000) {
  const registrations = new Map<symbol, { directory: string; policy: CompletionPolicy; controller: AbortController }>()
  const key = (directory: string) => process.platform === "win32" ? path.resolve(directory).toLowerCase() : path.resolve(directory)
  return {
    register(directory: string, policy: CompletionPolicy) {
      const id = Symbol()
      const controller = new AbortController()
      registrations.set(id, { directory: key(directory), policy, controller })
      return () => { registrations.delete(id); controller.abort() }
    },
    async check(directory: string, input: Omit<CompletionInput, "signal">): Promise<"incomplete" | undefined> {
      for (const [id, item] of [...registrations]) {
        if (registrations.get(id) !== item) continue
        if (item.directory !== key(directory)) continue
        const deadline = new AbortController()
        const signal = AbortSignal.any([item.controller.signal, deadline.signal])
        const timer = setTimeout(() => deadline.abort(), timeout)
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => registrations.get(id) === item ? item.policy({ ...structuredClone(input), signal }) : undefined),
            new Promise<"incomplete">((resolve) => {
              if (signal.aborted) return resolve("incomplete")
              signal.addEventListener("abort", () => resolve("incomplete"), { once: true })
            }),
          ])
          if (registrations.has(id) && result === "incomplete") return result
        } catch {
          if (registrations.has(id)) return "incomplete"
        } finally {
          clearTimeout(timer)
          deadline.abort()
        }
      }
    },
  }
}

export const completionRegistry = createCompletionRegistry()

/** A plugin goal lifecycle that owns turn continuation for its session. */
export type GoalOwnershipPolicy = (input: { sessionID: string }) => boolean | Promise<boolean>

export function createGoalOwnershipRegistry(timeout = 2000) {
  const registrations = new Map<symbol, { directory: string; policy: GoalOwnershipPolicy; controller: AbortController }>()
  const key = (directory: string) => process.platform === "win32" ? path.resolve(directory).toLowerCase() : path.resolve(directory)
  return {
    register(directory: string, policy: GoalOwnershipPolicy) {
      const id = Symbol()
      const controller = new AbortController()
      registrations.set(id, { directory: key(directory), policy, controller })
      return () => { registrations.delete(id); controller.abort() }
    },
    /**
     * True when a registered plugin goal owns continuation for the session, so
     * the generic host auto-resume must stand down and leave one owner. Errors
     * and timeouts fail closed (owned): the session then settles visibly
     * incomplete instead of racing the plugin with a second continuation.
     */
    async owned(directory: string, sessionID: string): Promise<boolean> {
      for (const [id, item] of [...registrations]) {
        if (registrations.get(id) !== item) continue
        if (item.directory !== key(directory)) continue
        const deadline = new AbortController()
        const signal = AbortSignal.any([item.controller.signal, deadline.signal])
        const timer = setTimeout(() => deadline.abort(), timeout)
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => registrations.get(id) === item ? item.policy({ sessionID }) : false),
            new Promise<never>((_, reject) => {
              if (signal.aborted) return reject(new Error("goal ownership aborted"))
              signal.addEventListener("abort", () => reject(new Error("goal ownership aborted")), { once: true })
            }),
          ])
          if (registrations.has(id) && result === true) return true
        } catch {
          if (registrations.has(id)) return true
        } finally {
          clearTimeout(timer)
          deadline.abort()
        }
      }
      return false
    },
    /**
     * Synchronous variant for effect-fiber hot paths (no async boundary).
     * Policies should be plain predicates; a policy that returns a promise or
     * throws is treated as owning (fail-closed) so the host owner stands down
     * while the plugin goal drives the session.
     */
    ownedSync(directory: string, sessionID: string): boolean {
      for (const [id, item] of [...registrations]) {
        if (registrations.get(id) !== item) continue
        if (item.directory !== key(directory)) continue
        try {
          const result = item.policy({ sessionID })
          if (result === true) return true
          // An async policy cannot answer synchronously: fail closed (owned)
          // so the host owner stands down while the plugin drives the session.
          if (result instanceof Promise) {
            // The result cannot be awaited here, but a rejected policy must
            // not escape as an unhandled rejection after we fail closed.
            void result.catch(() => undefined)
            return true
          }
        } catch {
          return true
        }
      }
      return false
    },
  }
}

export const goalOwnershipRegistry = createGoalOwnershipRegistry()
