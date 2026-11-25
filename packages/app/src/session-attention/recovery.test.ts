import { expect, test } from "bun:test"
import { recoverableAttention, recoverAttention } from "./recovery"

test("recovery touches only marked sessions of the current server", () => {
  const entry = { enabled: true, directory: "/p", cursor: 0, seen: 0, count: 0, error: false, title: "S" }
  expect(recoverableAttention({ "one\n/p\ns": entry, "one\n/p\nt": { ...entry, enabled: false },
    "two\n/p\nu": entry }, "one")).toEqual([{ directory: "/p", sessionID: "s" }])
})

test("recovery limits concurrent activity summary reads", async () => {
  let active = 0
  let maximum = 0
  await recoverAttention(Array.from({ length: 13 }, (_, index) => index), async () => {
    active++
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    active--
  })
  expect(maximum).toBe(4)
})
