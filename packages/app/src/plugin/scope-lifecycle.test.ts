import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { createPluginScopeDisposer, ownsPluginScope, trackPluginScope, type PluginScope } from "./scope-lifecycle"

function scope(id = "plugin"): PluginScope {
  return { id, controller: new AbortController(), disposers: [] }
}

describe("plugin scope lifecycle", () => {
  test.each(["current", "snapshot"])("drains a real store-backed scope through %s", async (source) => {
    const current = scope()
    const calls: number[] = []
    current.disposers.push(
      () => {
        calls.push(1)
      },
      () => {
        calls.push(2)
      },
    )
    const [store] = createStore({ scopes: { plugin: current } })
    const disposer = createPluginScopeDisposer({
      current: (id) => store.scopes[id as "plugin"],
      snapshot: () => Object.entries(store.scopes),
      release: () => {},
    })

    if (source === "current") await disposer.dispose("plugin")
    if (source === "snapshot") await disposer.disposeAll()
    await disposer.dispose("plugin")

    expect(calls).toEqual([2, 1])
    expect(current.disposers).toEqual([])
    expect(store.scopes.plugin.disposers).toEqual([])
    expect(current.controller.signal.aborted).toBe(true)
  })

  test("releases disposer closures and aborts without retaining the caller stack", async () => {
    const current = scope()
    const calls: number[] = []
    current.disposers.push(
      () => {
        calls.push(1)
      },
      () => {
        calls.push(2)
      },
    )
    const disposer = createPluginScopeDisposer({
      current: () => current,
      snapshot: () => [[current.id, current]],
      release: () => {},
    })

    await disposer.dispose(current.id)

    expect(calls).toEqual([2, 1])
    expect(current.disposers).toEqual([])
    expect(current.controller.signal.aborted).toBe(true)
    expect(current.controller.signal.reason.name).toBe("AbortError")
    expect(current.controller.signal.reason.stack).toBe("")
  })

  test("immediately removes a registration attempted after disposal", () => {
    const current = scope()
    const controls = new Set<string>()
    current.controller.abort()

    controls.add("stale")
    trackPluginScope(current, () => {
      controls.delete("stale")
    })

    expect(controls).toEqual(new Set())
    expect(current.disposers).toEqual([])
  })

  test("distinguishes a replacement scope with the same plugin id", () => {
    const stale = scope()
    const replacement = scope()

    expect(ownsPluginScope(stale, stale)).toBe(true)
    expect(ownsPluginScope(replacement, stale)).toBe(false)
  })

  test("releases every disposer even when one throws synchronously", async () => {
    const current = scope()
    const calls: number[] = []
    const failure = new Error("cleanup failed")
    current.disposers.push(
      () => {
        calls.push(1)
      },
      () => {
        throw failure
      },
    )
    const disposer = createPluginScopeDisposer({
      current: () => current,
      snapshot: () => [[current.id, current]],
      release: () => {},
    })

    await expect(disposer.dispose(current.id)).rejects.toBe(failure)
    expect(calls).toEqual([1])
    expect(current.disposers).toEqual([])
  })

  test("claims concurrent disposal exactly once", async () => {
    const current = scope()
    const scopes: Record<string, PluginScope> = { plugin: current }
    const gate = Promise.withResolvers<void>()
    const calls: string[] = []
    current.disposers.push(async () => {
      calls.push("dispose")
      await gate.promise
    })
    const disposer = createPluginScopeDisposer({
      current: (id) => scopes[id],
      snapshot: () => Object.entries(scopes),
      release: (id, expected) => {
        if (ownsPluginScope(scopes[id], expected)) delete scopes[id]
      },
    })

    const first = disposer.dispose("plugin", current)
    const second = disposer.dispose("plugin", current)
    expect(second).toBe(first)
    expect(scopes.plugin).toBeUndefined()
    expect(current.controller.signal.aborted).toBe(true)

    await Promise.resolve()
    expect(calls).toEqual(["dispose"])
    gate.resolve()
    await Promise.all([first, second])
    expect(calls).toEqual(["dispose"])
  })

  test("concurrent disposeAll joins the claimed work", async () => {
    const current = scope()
    const scopes: Record<string, PluginScope> = { plugin: current }
    const gate = Promise.withResolvers<void>()
    current.disposers.push(() => gate.promise)
    const disposer = createPluginScopeDisposer({
      current: (id) => scopes[id],
      snapshot: () => Object.entries(scopes),
      release: (id, expected) => {
        if (ownsPluginScope(scopes[id], expected)) delete scopes[id]
      },
    })

    const first = disposer.disposeAll()
    const second = disposer.disposeAll()
    const settled: string[] = []
    void second.then(() => settled.push("done"))

    await Promise.resolve()
    expect(settled).toEqual([])
    gate.resolve()
    await Promise.all([first, second])
    expect(settled).toEqual(["done"])
  })

  test("a stale disposeAll snapshot cannot release a replacement scope", async () => {
    const stale = scope()
    const replacement = scope()
    const scopes: Record<string, PluginScope> = { plugin: stale }
    const gate = Promise.withResolvers<void>()
    stale.disposers.push(() => gate.promise)
    const disposer = createPluginScopeDisposer({
      current: (id) => scopes[id],
      snapshot: () => Object.entries(scopes),
      release: (id, expected) => {
        if (ownsPluginScope(scopes[id], expected)) delete scopes[id]
      },
    })

    const disposing = disposer.disposeAll()
    scopes.plugin = replacement
    gate.resolve()
    await disposing

    expect(scopes.plugin).toBe(replacement)
    expect(replacement.controller.signal.aborted).toBe(false)
  })
})
