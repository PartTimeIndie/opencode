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
