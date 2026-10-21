import { expect, test } from "bun:test"
import { createCompletionRegistry } from "./completion"

const input = { sessionID: "neutral", messages: [] }

test("completion policies isolate directories and dispose independently", async () => {
  const registry = createCompletionRegistry()
  const first = registry.register("/first", async () => "incomplete")
  const second = registry.register("/second", async () => "incomplete")
  expect(await registry.check("/first", input)).toBe("incomplete")
  first()
  expect(await registry.check("/first", input)).toBeUndefined()
  expect(await registry.check("/second", input)).toBe("incomplete")
  second()
  expect(await registry.check("/second", input)).toBeUndefined()
})

test("failed or stalled policies cannot acknowledge completion", async () => {
  const registry = createCompletionRegistry(10)
  const dispose = registry.register("/first", async () => { throw new Error("unavailable") })
  expect(await registry.check("/first", input)).toBe("incomplete")
  dispose()
  let signal: AbortSignal | undefined
  registry.register("/first", (request) => { signal = request.signal; return new Promise(() => {}) })
  expect(await registry.check("/first", input)).toBe("incomplete")
  expect(signal?.aborted).toBe(true)
})

test("unload cancels in-flight policies and ignores their stale result", async () => {
  const registry = createCompletionRegistry()
  const ready = Promise.withResolvers<void>()
  const dispose = registry.register("/first", async () => { ready.resolve(); return new Promise(() => {}) })
  const pending = registry.check("/first", input)
  await ready.promise
  dispose()
  expect(await pending).toBeUndefined()
})

test("does not invoke a snapshotted policy disposed while an earlier policy waits", async () => {
  const registry = createCompletionRegistry()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<undefined>()
  registry.register("/first", async () => { started.resolve(); return release.promise })
  let called = false
  const dispose = registry.register("/first", async () => { called = true; return "incomplete" })
  const pending = registry.check("/first", input)
  await started.promise
  dispose()
  release.resolve(undefined)
  expect(await pending).toBeUndefined()
  expect(called).toBe(false)
})
