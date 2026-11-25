import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { subscribeServerState } from "./server-state-subscription"
import { serverStateLabel, type ServerState } from "./server-state"

test("newer restart state wins over the initial snapshot, and unsubscribe releases the listener", async () => {
  const bus = new EventEmitter()
  const received: ServerState[] = []
  let resolve!: (state: ServerState) => void
  const subscription = subscribeServerState({
    snapshot: () => new Promise((done) => { resolve = done }),
    listen: (callback) => { bus.on("state", callback); return () => { bus.off("state", callback) } },
  }, (state) => received.push(state))
  bus.emit("state", { phase: "restarting", attempt: 2 })
  resolve({ phase: "healthy", attempt: 0 })
  const stop = await subscription
  expect(received).toEqual([{ phase: "restarting", attempt: 2 }])
  expect(serverStateLabel(received[0])).toContain("2/5")
  stop()
  expect(bus.listenerCount("state")).toBe(0)
})

test("snapshot failure also releases the listener", async () => {
  let stopped = false
  await expect(subscribeServerState({
    listen: () => () => { stopped = true },
    snapshot: () => Promise.reject(new Error("unavailable")),
  }, () => {})).rejects.toThrow("unavailable")
  expect(stopped).toBe(true)
})
