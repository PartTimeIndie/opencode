import { expect, test } from "bun:test"
import { createNavigationHandoffRegistry } from "./navigation-handoff"

const target = { pluginID: "@neutral/export", handlerID: "open", directory: "/project", payload: { archive: "123" } }

test("independent plugin handlers receive immutable routing context within their server scope", async () => {
  const registry = createNavigationHandoffRegistry()
  const owner = new AbortController()
  const calls: unknown[] = []
  registry.register({ serverID: "one", pluginID: target.pluginID, handlerID: "open", signal: owner.signal }, (context) => { calls.push(context.payload); (context.payload as { archive: string }).archive = "edited" })
  registry.register({ serverID: "one", pluginID: "second", handlerID: "open", signal: owner.signal }, (context) => { calls.push(context.source) })
  expect(await registry.dispatch(target, { serverID: "one", source: "plugin" })).toEqual({ ok: true })
  expect(target.payload).toEqual({ archive: "123" })
  expect(await registry.dispatch({ ...target, pluginID: "second" }, { serverID: "one", source: "external" })).toEqual({ ok: true })
  expect(calls).toEqual([{ archive: "edited" }, "external"])
  expect((await registry.dispatch(target, { serverID: "other", source: "plugin" })).ok).toBe(false)
  expect((await registry.dispatch({ ...target, handlerID: "missing" }, { serverID: "one", source: "plugin" })).ok).toBe(false)
  owner.abort()
  expect((await registry.dispatch(target, { serverID: "one", source: "plugin" })).ok).toBe(false)
})

test("rejects duplicate ownership and malformed handoffs without invoking a handler", async () => {
  const registry = createNavigationHandoffRegistry()
  const owner = new AbortController()
  const input = { serverID: "one", pluginID: target.pluginID, handlerID: "open", signal: owner.signal }
  const dispose = registry.register(input, () => {})
  expect(() => registry.register(input, () => {})).toThrow("already registered")
  for (const invalid of [{ ...target, pluginID: undefined }, { ...target, handlerID: "../private" }, { ...target, directory: "" }, { ...target, payload: "x".repeat(65537) }])
    expect((await registry.dispatch(invalid as never, { serverID: "one", source: "plugin" })).ok).toBe(false)
  dispose()
  expect(() => registry.register(input, () => {})).not.toThrow()
  owner.abort()
})

test("aborts a noncooperative handler immediately on unregister or caller cancellation", async () => {
  for (const reason of ["caller", "unload"]) {
    const registry = createNavigationHandoffRegistry()
    const owner = new AbortController()
    const caller = new AbortController()
    const started = Promise.withResolvers<AbortSignal>()
    const dispose = registry.register({ serverID: "one", pluginID: target.pluginID, handlerID: "open", signal: owner.signal }, (context) => { started.resolve(context.signal); return new Promise(() => {}) })
    const pending = registry.dispatch(target, { serverID: "one", source: "plugin", signal: caller.signal })
    const signal = await started.promise
    if (reason === "caller") caller.abort()
    else dispose()
    expect(await pending).toEqual({ ok: false, error: "Handoff cancelled" })
    expect(signal.aborted).toBe(true)
    expect(signal.reason.name).toBe("AbortError")
    expect(signal.reason.stack).toBe("")
    owner.abort()
  }
})

test("delivers an external startup link once its exact handler is registered", async () => {
  const registry = createNavigationHandoffRegistry()
  const owner = new AbortController()
  const pending = registry.dispatch(target, { serverID: "one", source: "external" }, true)
  let count = 0
  registry.register({ serverID: "one", pluginID: target.pluginID, handlerID: "open", signal: owner.signal }, () => { count++ })
  expect(await pending).toEqual({ ok: true })
  expect(count).toBe(1)
  owner.abort()
})

test("cancels a queued external link and does not deliver it after plugin activation", async () => {
  const registry = createNavigationHandoffRegistry()
  const caller = new AbortController()
  const pending = registry.dispatch(target, { serverID: "one", source: "external", signal: caller.signal }, true)
  caller.abort()
  expect(await pending).toEqual({ ok: false, error: "Handoff cancelled" })
  const owner = new AbortController()
  let count = 0
  registry.register({ serverID: "one", pluginID: target.pluginID, handlerID: "open", signal: owner.signal }, () => { count++ })
  await Promise.resolve()
  expect(count).toBe(0)
  owner.abort()
})
