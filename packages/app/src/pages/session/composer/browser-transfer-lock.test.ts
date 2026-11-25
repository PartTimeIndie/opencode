import { expect, test } from "bun:test"
import { createBrowserTransferLock } from "./browser-transfer-lock"

test("rejects overlapping ownership changes but allows independent pages", async () => {
  const lock = createBrowserTransferLock()
  let finish!: () => void
  const waiting = new Promise<void>((resolve) => { finish = resolve })
  const first = lock.run("tab:a", () => waiting)
  expect(lock.has("tab:a")).toBe(true)
  let called = false
  await expect(lock.run("tab:a", async () => { called = true })).rejects.toThrow("already in progress")
  expect(called).toBe(false)
  await expect(lock.run("tab:b", async () => "independent")).resolves.toBe("independent")
  finish()
  await first
  expect(lock.has("tab:a")).toBe(false)
})

test("releases the lock after synchronous and asynchronous failures", async () => {
  const lock = createBrowserTransferLock()
  await expect(lock.run("dock:a", () => { throw new Error("sync") })).rejects.toThrow("sync")
  expect(lock.has("dock:a")).toBe(false)
  await expect(lock.run("dock:a", async () => { throw new Error("async") })).rejects.toThrow("async")
  await expect(lock.run("dock:a", async () => "retry")).resolves.toBe("retry")
})
