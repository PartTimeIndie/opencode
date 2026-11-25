import { afterEach, expect, test } from "bun:test"
import { scheduleAnimations } from "./animation-lifecycle"

const request = globalThis.requestAnimationFrame
const cancel = globalThis.cancelAnimationFrame
afterEach(() => {
  globalThis.requestAnimationFrame = request
  globalThis.cancelAnimationFrame = cancel
})

test("disposing before the frame cancels startup, including a late queued callback", () => {
  let callback: FrameRequestCallback = () => {}
  let cancelled = 0
  let started = 0
  globalThis.requestAnimationFrame = (next) => {
    callback = next
    return 42
  }
  globalThis.cancelAnimationFrame = (id) => {
    cancelled = id
  }
  const dispose = scheduleAnimations(() => {
    started++
    return []
  })
  dispose()
  callback(1)
  expect(cancelled).toBe(42)
  expect(started).toBe(0)
})

test("disposing stops every started animation exactly once", () => {
  let callback: FrameRequestCallback = () => {}
  const stopped = [0, 0]
  globalThis.requestAnimationFrame = (next) => {
    callback = next
    return 7
  }
  globalThis.cancelAnimationFrame = () => {}
  const dispose = scheduleAnimations(() =>
    stopped.map((_, index) => ({
      stop() {
        stopped[index]++
      },
    })),
  )
  callback(1)
  expect(stopped).toEqual([0, 0])
  dispose()
  dispose()
  expect(stopped).toEqual([1, 1])
})
