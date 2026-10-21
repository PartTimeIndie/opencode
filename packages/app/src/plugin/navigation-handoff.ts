import type { AppHostHandoff, AppHostHandoffContext } from "@opencode-ai/plugin/app"
import { abortPluginWork } from "./abort"

type Result = { ok: boolean; error?: string }
type Context = { serverID: string; source: AppHostHandoffContext["source"]; signal?: AbortSignal }
type Registration = {
  controller: AbortController
  handle(context: AppHostHandoffContext): void | Promise<void>
}

export function validateHandoff(input: AppHostHandoff) {
  if (
    !input ||
    typeof input.pluginID !== "string" ||
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,127}$/i.test(input.pluginID)
  )
    return "Invalid handoff plugin"
  if (typeof input.handlerID !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.handlerID))
    return "Invalid handoff handler"
  if (typeof input.directory !== "string" || !input.directory.trim() || input.directory.length > 4096)
    return "Invalid handoff directory"
  try {
    const payload = JSON.stringify(input.payload)
    if (payload === undefined || payload.length > 65536) return "Invalid handoff payload"
  } catch {
    return "Invalid handoff payload"
  }
}

export function createNavigationHandoffRegistry() {
  const entries = new Map<string, Registration>()
  const waiting = new Map<string, Set<() => void>>()
  const key = (serverID: string, pluginID: string, handlerID: string) => JSON.stringify([serverID, pluginID, handlerID])

  return {
    register(
      input: { serverID: string; pluginID: string; handlerID: string; signal: AbortSignal },
      handle: Registration["handle"],
    ) {
      const error = validateHandoff({ ...input, directory: "/", payload: null })
      if (error) throw new Error(error)
      const id = key(input.serverID, input.pluginID, input.handlerID)
      if (entries.has(id)) throw new Error("Handoff handler is already registered")
      if (input.signal.aborted) return () => {}
      const entry = { controller: new AbortController(), handle }
      entries.set(id, entry)
      const dispose = () => {
        if (entries.get(id) === entry) entries.delete(id)
        input.signal.removeEventListener("abort", dispose)
        abortPluginWork(entry.controller)
      }
      input.signal.addEventListener("abort", dispose, { once: true })
      for (const ready of waiting.get(id) ?? []) ready()
      return dispose
    },
    async dispatch(input: AppHostHandoff, context: Context, waitForRegistration = false): Promise<Result> {
      const error = validateHandoff(input)
      if (error) return { ok: false, error }
      const directory = input.directory
      const payload = JSON.parse(JSON.stringify(input.payload))
      const id = key(context.serverID, input.pluginID, input.handlerID)
      if (context.signal?.aborted) return { ok: false, error: "Handoff cancelled" }
      // External links can arrive before the target plugin finishes loading.
      if (!entries.has(id) && waitForRegistration) {
        if ([...waiting.values()].reduce((count, set) => count + set.size, 0) >= 64)
          return { ok: false, error: "Too many pending handoffs" }
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            context.signal?.removeEventListener("abort", done)
            waiting.get(id)?.delete(done)
            if (!waiting.get(id)?.size) waiting.delete(id)
            resolve()
          }
          const timer = setTimeout(done, 10000)
          if (!waiting.has(id)) waiting.set(id, new Set())
          waiting.get(id)!.add(done)
          context.signal?.addEventListener("abort", done, { once: true })
        })
      }
      const entry = entries.get(id)
      if (context.signal?.aborted) return { ok: false, error: "Handoff cancelled" }
      if (!entry) return { ok: false, error: "Handoff plugin or handler is unavailable" }
      const controller = new AbortController()
      const abort = () => abortPluginWork(controller)
      entry.controller.signal.addEventListener("abort", abort, { once: true })
      context.signal?.addEventListener("abort", abort, { once: true })
      let cancel: (() => void) | undefined
      try {
        return await Promise.race([
          Promise.resolve()
            .then(() => {
              if (controller.signal.aborted) throw new Error("Handoff cancelled")
              return entry.handle({
                directory,
                payload,
                source: context.source,
                signal: controller.signal,
              })
            })
            .then(
              () => ({ ok: true }),
              (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
            ),
          new Promise<Result>((resolve) => {
            cancel = () => resolve({ ok: false, error: "Handoff cancelled" })
            controller.signal.addEventListener("abort", cancel, { once: true })
          }),
        ])
      } finally {
        entry.controller.signal.removeEventListener("abort", abort)
        context.signal?.removeEventListener("abort", abort)
        if (cancel) controller.signal.removeEventListener("abort", cancel)
        abortPluginWork(controller)
      }
    },
  }
}

export const navigationHandoffs = createNavigationHandoffRegistry()
