import { abortPluginWork } from "./abort"
import { unwrap } from "solid-js/store"

export type PluginScope = {
  id: string
  controller: AbortController
  disposers: Array<() => void | Promise<void>>
}

export function createPluginScopeDisposer(input: {
  current(id: string): PluginScope | undefined
  snapshot(): Array<[string, PluginScope]>
  release(id: string, scope: PluginScope): void
  onError?(id: string, error: unknown): void
}) {
  const claims = new WeakMap<AbortController, Promise<void>>()
  const pending = new Set<Promise<void>>()

  const dispose = (id: string, expected?: PluginScope): Promise<void> => {
    // Runtime lookups return a read-only Solid proxy; drain the owned raw list.
    const scope = unwrap(expected ?? input.current(id))
    if (!scope) return Promise.resolve()
    const claimed = claims.get(scope.controller)
    if (claimed) return claimed
    if (!expected && !ownsPluginScope(input.current(id), scope)) return Promise.resolve()

    const task = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(
        scope.disposers
          .splice(0)
          .reverse()
          .map(async (dispose) => dispose()),
      )
      const failed = results.find((result) => result.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
    })
    claims.set(scope.controller, task)
    pending.add(task)
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    )

    input.release(id, scope)
    abortPluginWork(scope.controller)
    return task
  }

  const disposeAll = async () => {
    const requested = input
      .snapshot()
      .map(([id, scope]) => dispose(id, scope).catch((error) => input.onError?.(id, error)))
    await Promise.allSettled([...pending, ...requested])
  }

  return { dispose, disposeAll }
}

export function trackPluginScope(scope: PluginScope, dispose: () => void | Promise<void>) {
  if (scope.controller.signal.aborted) {
    void dispose()
    return () => {}
  }
  scope.disposers.push(dispose)
  return () => {
    scope.disposers = scope.disposers.filter((item) => item !== dispose)
    void dispose()
  }
}

export function ownsPluginScope(current: PluginScope | undefined, expected: PluginScope) {
  return current?.controller === expected.controller
}
