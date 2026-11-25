import { expect, test } from "bun:test"
import { stopWithRecovery } from "./shutdown-recovery"

test("a blocked stop asks before forcing and waits for confirmed exit", async () => {
  let resolveExit!: () => void
  const exit = new Promise<void>((resolve) => { resolveExit = resolve })
  let forced = 0
  let completed = false
  const result = stopWithRecovery({
    stop: async () => { throw new Error("timeout") },
    choose: async () => "force",
    force: async () => { forced++; await exit },
  }).then(() => { completed = true })
  await Bun.sleep(0)
  expect(forced).toBe(1)
  expect(completed).toBe(false)
  resolveExit()
  await result
  expect(completed).toBe(true)
})

test("cancel never forces; retry repeats graceful stop", async () => {
  let forced = 0
  await expect(stopWithRecovery({
    stop: async () => { throw new Error("timeout") },
    choose: async () => "cancel",
    force: async () => { forced++ },
  })).rejects.toThrow("timeout")
  expect(forced).toBe(0)
  let stops = 0
  await stopWithRecovery({
    stop: async () => { if (++stops === 1) throw new Error("timeout") },
    choose: async () => "retry",
    force: async () => { forced++ },
  })
  expect(stops).toBe(2)
  expect(forced).toBe(0)
})

test("a failed forced exit stays blocked", async () => {
  await expect(stopWithRecovery({
    stop: async () => { throw new Error("timeout") },
    choose: async () => "force",
    force: async () => { throw new Error("exit unconfirmed") },
  })).rejects.toThrow("exit unconfirmed")
})
